/**
 * T-18 — what actually reaches the two pages (AC8, AC10, AC11).
 *
 * The panels are browser scripts built as strings, so what can be asserted here is what each
 * page HANDS OVER: the context keys, the transcript key, the note fields, the offline words.
 * That is enough to catch the failure that matters — a change landing on one surface and not
 * the other, which is exactly what Q8 ("both, in this one piece of work") was answered to
 * avoid, and what the notes panel's recorded duplication makes easy to do by accident.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/digest.js';
import { buildCodeTour } from '../src/codetour.js';
import { renderRepoView } from '../src/repoview.js';
import { renderPrView } from '../src/prview.js';
import { parseUnified } from '../src/diff.js';
import { noteFromExchange } from '../src/notes.js';
import { askPanelScript } from '../src/askpanel.js';
import type { FileDelta } from '../src/delta.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const prRefs = {
  number: 3, url: 'https://github.com/o/r/pull/3',
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null,
  baseLabel: 'main', headLabel: 'feature', baseAhead: 0,
  prose: { title: 'A change', body: null, commits: [], issues: [], source: 'github' as const },
};
const prDelta: FileDelta = {
  path: 'src/rank.ts', status: 'M', linesChanged: 2, meaningDelta: 0.6,
  surface: { added: [], removed: [], changed: [] }, interpreted: true, reason: 'r', basis: 'adjudicated',
};

function renderPr(repoPath?: string): string {
  return renderPrView({
    refs: prRefs, repoName: 'repo-tour', repoPath,
    deltas: [prDelta],
    diffs: new Map([['src/rank.ts', parseUnified('src/rank.ts', '@@ -22,1 +22,1 @@\n-  test: 0.5,\n+  test: 0.05,')]]),
    steps: [], ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
    verdicts: new Map([['src/rank.ts', {
      changed: true, magnitude: 0.6, kind: 'behaviour' as const, source: 'model' as const,
      headline: 'h', narrative: 'The multiplier drops to 0.05.',
    }]]),
    meanings: new Map([['src/rank.ts', 'Scores every file.']]),
    importers: new Map([['src/rank.ts', ['src/digest.ts']]]),
  });
}

let repoHtml: string;
let servedHtml: string;

beforeAll(async () => {
  const r = await digest(root, { write: false });
  const plan = buildCodeTour(r, { maxFiles: 3, perFile: 2 });
  repoHtml = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });
  servedHtml = renderRepoView(r, {
    steps: plan.steps,
    itinerary: plan.itinerary,
    servedBy: { homeUrl: '/', repoPath: '/tmp/whatever', builtAt: new Date().toISOString() },
  });
}, 120_000);

describe('the repo tour hands over what T-18 promised', () => {
  it('sends the source of the file on screen, not only a description of it', () => {
    expect(repoHtml).toContain('source: R.files[i].text.slice(0,');
    expect(repoHtml).toContain('sourceFullLength:');
  });

  it('sends the stop index, so a message can be stamped with where it was asked', () => {
    expect(repoHtml).toContain('stopIndex: window.__tour ? window.__tour.index() : -1');
    // Regression guard, found by driving the real page: the falsy-zero form reports stop
    // ZERO — the opening stop, where most readers ask their first question — as "not
    // touring". Built by concatenation because a tour of THIS repository embeds this test
    // file, so a guard written as one literal would find itself and fail forever.
    expect(repoHtml).not.toContain(`window.__tour.index()${')'} || -1`);
  });

  it('carries the repository overview and the whole stop list in its payload', () => {
    const payload = JSON.parse(/window\.__REPO__ = (\{.*?\});<\/script>/s.exec(repoHtml)![1]!) as {
      stops: Array<{ index: number; title: string }>;
      overview: string | null;
      repoPath: string | null;
    };
    expect(Array.isArray(payload.stops)).toBe(true);
    expect(payload.stops.length).toBeGreaterThan(0);
    expect(payload.stops[0]).toHaveProperty('title');
    // no architecture was interpreted for this render, and null is the honest value
    expect(payload.overview).toBeNull();
  });

  it('sends a repo path only when a server is behind the page', () => {
    // An exported page has no server, so there is nothing to fetch from and it must not
    // claim otherwise — that is how the refusal in askStream stays truthful.
    const exported = JSON.parse(/window\.__REPO__ = (\{.*?\});<\/script>/s.exec(repoHtml)![1]!) as { repoPath: string | null };
    const served = JSON.parse(/window\.__REPO__ = (\{.*?\});<\/script>/s.exec(servedHtml)![1]!) as { repoPath: string | null };
    expect(exported.repoPath).toBeNull();
    expect(served.repoPath).toBe('/tmp/whatever');
  });

  it('keeps its transcript beside its notes, both scoped to the repository', () => {
    // Asserted against the EMITTED declarations, not the page as a whole: a tour of this
    // repository embeds this repository's own source, so the raw HTML contains every string
    // literal in src/ — including the PR page's keys. Matching the rendered form is the only
    // way to test a self-hosting tour and mean it.
    expect(repoHtml).toContain(`var CHAT_KEY = "repotour:chat:${path.basename(root)}";`);
    expect(repoHtml).toContain(`var NOTES_KEY = "repotour:notes:${path.basename(root)}";`);
    expect(repoHtml).not.toMatch(/var CHAT_KEY = "[^"]*#pr-/);
  });

  it('can open a file at a cited line', () => {
    expect(repoHtml).toContain('window.__openCitation');
    expect(repoHtml).toContain('window.__repo.mark(line, line)');
  });

  it('tells a reader who opened it from disk exactly what to run (AC11)', () => {
    const hintOf = (html: string): string => /var OFFLINE_HINT = ("(?:[^"\\]|\\.)*");/.exec(html)![1]!;
    const exported = JSON.parse(hintOf(repoHtml)) as string;
    expect(exported).toContain('opened as a saved file');
    expect(exported).toContain('repo-tour serve');
    expect(exported).toContain('will still be here');
    // a served page says something different — the server stopped, not "you saved this"
    const served = JSON.parse(hintOf(servedHtml)) as string;
    expect(served).not.toContain('opened as a saved file');
    expect(served).toContain('may have stopped');
  });
});

describe('the pull request page hands over the same things (AC10)', () => {
  it('carries the checkout root, so the tutor can read past the diff', () => {
    const html = renderPr('/tmp/checkout');
    expect(html).toContain('"repoPath":"/tmp/checkout"');
    expect(html).toContain('repoPath: META.repoPath');
  });

  it('is null-safe when no root was passed', () => {
    expect(renderPr()).toContain('"repoPath":null');
  });

  it('stamps the stop and carries the stop list', () => {
    const html = renderPr('/tmp/checkout');
    expect(html).toContain('stopIndex: m.index === undefined ? -1 : m.index');
    expect(html).toContain('stops: META.stops');
  });

  it('keys its transcript to the pull request, not just the repository', () => {
    const html = renderPr();
    expect(html).toContain('repotour:chat:repo-tour#pr-3');
    expect(html).toContain('repotour:notes:repo-tour#pr-3');
  });

  it('can jump to a cited file', () => {
    expect(renderPr()).toContain('window.__openCitation');
  });
});

describe('an answer can become a note, on both surfaces (AC8)', () => {
  it('the canonical record carries every provenance field plus the question', () => {
    const record = noteFromExchange({
      file: 'src/rank.ts', startLine: 20, endLine: 24,
      stopIndex: 2, stopTitle: 'The ranker', explanation: 'what the tour said',
      head: 'abc123', quote: 'const x = 1;',
    }, 'why is this damped?', 'Because tests would otherwise win the itinerary.', 1000);

    expect(record).toEqual({
      id: '1000-20', file: 'src/rank.ts', startLine: 20, endLine: 24,
      stopIndex: 2, stopTitle: 'The ranker', explanation: 'what the tour said',
      head: 'abc123', quote: 'const x = 1;',
      body: 'Because tests would otherwise win the itinerary.',
      question: 'why is this damped?', source: 'tutor',
    });
  });

  it('both note panels write the same two new fields', () => {
    // The duplication notes.ts has recorded since T-3: two panels, one shape. This is the
    // guard that they did not drift apart while T-18 touched both.
    for (const html of [repoHtml, renderPr()]) {
      expect(html).toContain('question: pendingQuestion || undefined');
      expect(html).toContain("source: pendingQuestion ? 'tutor' : undefined");
      expect(html).toContain('window.__keepNote');
      expect(html).toContain('trim it to what matters, then save');
    }
  });

  it('both exports show the question a kept note came from', () => {
    expect(repoHtml).toContain("'*Asked:* '");
    expect(renderPr()).toContain("'*Asked:* '");
  });

  it('the panel offers the keep button and reads the question from the turn above', () => {
    const script = askPanelScript({ notesKey: 'n', chatKey: 'c', offlineHint: 'hint' });
    expect(script).toContain('keep as note');
    expect(script).toContain("rows[j].role === 'user'");
  });
});

describe('the panel script is shared, so both pages get the same behaviour', () => {
  const script = askPanelScript({ notesKey: 'n', chatKey: 'c', offlineHint: 'the hint' });

  it('reads an event stream rather than one blob of JSON', () => {
    expect(script).toContain('getReader()');
    expect(script).toContain("event: (.+)");
    for (const kind of ['fetch', 'delta', 'reset', 'error', 'done']) {
      expect(script).toContain(`kind === '${kind}'`);
    }
  });

  it('shows each lookup as it happens', () => {
    expect(script).toContain("'read ' + data.what");
    expect(script).toContain("'could not '");
  });

  it('offers the whole tour by default, filterable to one stop', () => {
    expect(script).toContain('var showAll = true;');
    expect(script).toContain('showing this stop only');
  });

  it('never opens a sent transcript on an assistant turn', () => {
    expect(script).toContain("while (out.length && out[0].role !== 'user') out.shift();");
  });

  it('uses the offline words it was given', () => {
    expect(script).toContain('the hint');
  });
});
