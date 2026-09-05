/**
 * T-18 — what the tutor is handed, and how it asks for more.
 *
 * The context block and the fetch protocol are the two halves of Q1 ("let it go and get what
 * it needs"), and both are pure functions precisely so they can be tested without a browser
 * or a model. What is asserted here is not that the prose reads well — it is that nothing is
 * sent SILENTLY: every clip states itself, every fetched block is labelled as fetched rather
 * than blending into what was on screen, and a reply is only treated as a request for
 * material when it is unambiguously one.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextBlock,
  buildAskPrompt,
  parseFetchRequest,
  clipToBudget,
  trimMessages,
  createReplyGate,
  MAX_FETCH_HOPS,
  type AskContext,
} from '../src/ask.js';

describe('the source of the file on screen (AC1)', () => {
  it('sends the code, not just a description of it', () => {
    const block = buildContextBlock({
      file: 'src/rank.ts',
      fileMeaning: 'scores files so the tour knows where to go',
      source: 'export function rank(x: number) {\n  return x * 2;\n}\n',
    });
    expect(block).toContain('The source of that file');
    expect(block).toContain('return x * 2;');
  });

  it('states a clip with its real numbers instead of a bare "(truncated)"', () => {
    // A model that knows it has the first 24k of a 61k file asks for the rest. One that is
    // told only "(truncated)" answers confidently about a file it has seen the top of.
    const block = buildContextBlock({
      file: 'src/big.ts',
      source: 'x'.repeat(24_000),
      sourceFullLength: 61_204,
    });
    expect(block).toContain('showing the first 24,000 characters of 61,204');
    expect(block).toContain('ask for the file if you need the rest');
  });

  it('says nothing at all when the clip did not happen', () => {
    const block = buildContextBlock({ file: 'a.ts', source: 'short', sourceFullLength: 5 });
    expect(block).toContain('The source of that file:');
    expect(block).not.toContain('showing the first');
  });

  it('leaves no empty heading behind when there is no source', () => {
    const block = buildContextBlock({ file: 'src/rank.ts' });
    expect(block).not.toContain('The source of that file');
  });
});

describe('orientation: the repo and the whole tour (AC4)', () => {
  it('carries what the digest concluded about the system as a whole', () => {
    const block = buildContextBlock({
      repo: 'sql-gauntlet',
      repoOverview: 'A teaching app that walks a learner through SQL puzzles.',
    });
    expect(block).toContain('What this repository is, as a whole');
    expect(block).toContain('walks a learner through SQL puzzles');
  });

  it('lists every stop in the tour, numbered from one', () => {
    const stops = Array.from({ length: 12 }, (_, i) => ({ index: i, title: `Stop ${i + 1}` }));
    const block = buildContextBlock({ stops });
    expect(block).toContain('The tour has 12 stops:');
    expect(block).toContain('  1. Stop 1');
    expect(block).toContain('  12. Stop 12');
  });

  it('says "1 stop" rather than "1 stops"', () => {
    expect(buildContextBlock({ stops: [{ index: 0, title: 'Only' }] })).toContain('The tour has 1 stop:');
  });

  it('leaves no empty headings when neither is known', () => {
    const block = buildContextBlock({ repo: 'x' });
    expect(block).not.toContain('as a whole');
    expect(block).not.toContain('The tour has');
  });
});

describe('fetched material is labelled as fetched (AC3)', () => {
  it('keeps what it asked for separate from what was on the reader screen', () => {
    // The distinction is not cosmetic: a citation to a file it was shown is honest and a
    // citation to one it never saw is not, and it can only tell them apart if we do.
    const block = buildContextBlock({
      file: 'src/a.ts',
      source: 'on screen',
      fetched: [{ what: 'file src/b.ts', body: 'fetched body' }],
    });
    expect(block).toContain('--- WHAT YOU ASKED FOR AND WERE GIVEN (1) ---');
    expect(block).toContain('[file src/b.ts]');
    expect(block).toContain('fetched body');
    expect(block.indexOf('on screen')).toBeLessThan(block.indexOf('fetched body'));
  });

  it('marks a clipped fetch as clipped', () => {
    const block = buildContextBlock({ fetched: [{ what: 'file big.ts', body: 'x', truncated: true }] });
    expect(block).toContain('[file big.ts] (clipped)');
  });

  it('renders nothing when nothing was fetched', () => {
    expect(buildContextBlock({ file: 'a.ts' })).not.toContain('WHAT YOU ASKED FOR');
  });
});

describe('the fetch protocol (AC2)', () => {
  it('reads a file request', () => {
    expect(parseFetchRequest('FETCH: file src/rank.ts')).toEqual({ kind: 'file', arg: 'src/rank.ts' });
  });

  it('reads a search request, keeping the spaces in the query', () => {
    expect(parseFetchRequest('FETCH: search buildContextBlock(')).toEqual({
      kind: 'search',
      arg: 'buildContextBlock(',
    });
  });

  it('tolerates a code fence, which models add unbidden', () => {
    expect(parseFetchRequest('```\nFETCH: file src/a.ts\n```')).toEqual({ kind: 'file', arg: 'src/a.ts' });
  });

  it('strips quotes a model wrapped the path in', () => {
    expect(parseFetchRequest('FETCH: file "src/a.ts"')).toEqual({ kind: 'file', arg: 'src/a.ts' });
  });

  it('is case-insensitive about the verb', () => {
    expect(parseFetchRequest('fetch: FILE src/a.ts')).toEqual({ kind: 'file', arg: 'src/a.ts' });
  });

  it('treats an ANSWER that merely mentions fetching as an answer', () => {
    // The asymmetry that decides this rule: a missed fetch is a slightly unhelpful answer,
    // a false fetch spends a hop and shows the reader nothing at all.
    expect(parseFetchRequest('You could FETCH: file rank.ts to see it, but I can already tell you.')).toBeNull();
    expect(parseFetchRequest('I need more.\nFETCH: file src/a.ts')).toBeNull();
  });

  it('refuses a request with nothing after the verb', () => {
    expect(parseFetchRequest('FETCH: file')).toBeNull();
    expect(parseFetchRequest('FETCH: file   ')).toBeNull();
  });

  it('refuses a verb it does not know', () => {
    expect(parseFetchRequest('FETCH: delete src/a.ts')).toBeNull();
  });

  it('returns null for an ordinary answer', () => {
    expect(parseFetchRequest('rank.ts scores files by churn and in-degree.')).toBeNull();
  });
});

describe('the fetch budget', () => {
  it('passes a body through untouched when it fits', () => {
    expect(clipToBudget('abc', 10)).toEqual({ body: 'abc', truncated: false });
  });

  it('clips and says so when it does not fit', () => {
    const out = clipToBudget('x'.repeat(50), 10)!;
    expect(out.truncated).toBe(true);
    expect(out.body).toContain('the budget for fetched material ran out');
    expect(out.body.startsWith('x'.repeat(10))).toBe(true);
  });

  it('returns null rather than an empty body when the budget is gone', () => {
    // An empty block reads to a model exactly like an empty file, which is a lie about the
    // repository. Nothing is better than that, and the caller can say why.
    expect(clipToBudget('anything', 0)).toBeNull();
    expect(clipToBudget('anything', -5)).toBeNull();
  });
});

describe('the persona tells the model the rules it is actually held to', () => {
  it('names the protocol and the real hop cap', () => {
    const prompt = buildAskPrompt([{ role: 'user', content: 'hi' }], {});
    expect(prompt).toContain('FETCH: file <path from the repository root>');
    expect(prompt).toContain('FETCH: search <text to find>');
    expect(prompt).toContain(`at most ${MAX_FETCH_HOPS} of them`);
  });

  it('tells it that citations are checked, because they are', () => {
    const prompt = buildAskPrompt([{ role: 'user', content: 'hi' }], {});
    expect(prompt).toContain('Cite ONLY files you were actually shown');
  });
});

describe('trimming still holds the rule it always held', () => {
  it('never opens a sent transcript on an assistant turn', () => {
    const msgs = trimMessages([
      { role: 'assistant', content: 'an answer with no question above it' },
      { role: 'user', content: 'the real first question' },
    ]);
    expect(msgs[0]!.role).toBe('user');
  });
});

describe('the reply gate — what the reader is allowed to see while it decides', () => {
  const drive = (chunks: string[]): { shown: string; full: string } => {
    const gate = createReplyGate();
    let shown = '';
    for (const c of chunks) shown += gate.push(c);
    return { shown, full: gate.full() };
  };

  it('never shows the reader a fetch line, however it is chunked', () => {
    expect(drive(['FETCH: file src/rank.ts']).shown).toBe('');
    expect(drive('FETCH: file src/rank.ts'.split('')).shown).toBe('');
    expect(drive(['FET', 'CH: fi', 'le src/rank.ts']).shown).toBe('');
    expect(drive(['   FETCH: file src/rank.ts']).shown).toBe('');
    expect(drive(['```\nFETCH: file src/rank.ts\n```']).shown).toBe('');
  });

  it('streams an ordinary answer through once it has committed', () => {
    const out = drive(['It returns 1. ', 'Nothing else.']);
    expect(out.shown).toBe('It returns 1. Nothing else.');
  });

  it('releases at exactly the probe length, not before', () => {
    expect(drive(['Yes sir']).shown).toBe('');        // 7 characters — still deciding
    expect(drive(['Yes sirs']).shown).toBe('Yes sirs'); // 8 — decided, and nothing was lost
  });

  it('holds short replies forever — and that is why the server checks released()', () => {
    // The gate is NOT correct alone, and this is the coupling that makes it safe: it holds
    // 'FETCH' (no colon), 'Yes.' and an unterminated fence indefinitely, because the probe
    // length is never reached. askStream compensates by falling back to the full reply text
    // whenever the gate released nothing. If that fallback is ever removed, these answers
    // vanish — so this test documents the contract between the two.
    for (const short of ['FETCH', 'Yes.', '```typescript']) {
      const out = drive([short]);
      expect(out.shown).toBe('');
      expect(out.full).toBe(short);   // the server still has it, and sends it
    }
  });

  it('keeps the whole reply available whatever it decided', () => {
    expect(drive(['FETCH: file a.ts']).full).toBe('FETCH: file a.ts');
    expect(drive(['an answer that is long enough']).full).toBe('an answer that is long enough');
  });

  it('shows the plumbing only when a model prefixes its own fetch line', () => {
    // The documented asymmetry: parseFetchRequest treats this as an ANSWER, so the reader
    // sees it rather than losing a hop to it. Recorded as a test so the trade stays a choice.
    const out = drive(['Sure. FETCH: file src/rank.ts']);
    expect(out.shown).toContain('FETCH:');
    expect(parseFetchRequest(out.full)).toBeNull();
  });

  it('never releases text it has not accounted for', () => {
    // released() is what askStream slices against; if it ever disagreed with what was
    // emitted, the reader would get a duplicated or truncated answer.
    const gate = createReplyGate();
    let emitted = '';
    for (const c of ['This is a norm', 'al answer.']) emitted += gate.push(c);
    expect(gate.released()).toBe(emitted);
    expect(gate.full()).toBe('This is a normal answer.');
  });
});
