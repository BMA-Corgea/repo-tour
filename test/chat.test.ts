/**
 * T-18 — the transcript that survives (AC5).
 *
 * The panel's memory used to be one array in the page, so a reload erased everything the
 * reader had asked while their notes survived. These are the rules that replace it.
 */

import { describe, it, expect } from 'vitest';
import { chatKey, stampMessage, forSending, atStop, parseTranscript, SEND_TURNS } from '../src/chat.js';
import { notesKey } from '../src/notes.js';

describe('the key', () => {
  it('is scoped to the repository, like the notes key', () => {
    expect(chatKey('repo-tour')).toBe('repotour:chat:repo-tour');
    expect(chatKey('repo-tour', 41)).toBe('repotour:chat:repo-tour#pr-41');
  });

  it('never collides with the notes key it sits beside', () => {
    expect(chatKey('r')).not.toBe(notesKey('r'));
    expect(chatKey('r', 2)).not.toBe(notesKey('r', 2));
  });
});

describe('every message remembers where the reader was standing', () => {
  it('stamps the stop and the file', () => {
    const m = stampMessage('user', 'what is this?', { stopIndex: 3, stopTitle: 'The ranker', file: 'src/rank.ts' }, 1000);
    expect(m).toEqual({
      role: 'user', content: 'what is this?', stopIndex: 3,
      stopTitle: 'The ranker', file: 'src/rank.ts', ts: 1000,
    });
  });

  it('records browsing-not-touring as -1 rather than pretending there was a stop', () => {
    expect(stampMessage('user', 'q', {}).stopIndex).toBe(-1);
  });

  it('filters to one stop', () => {
    const msgs = [
      stampMessage('user', 'at one', { stopIndex: 1 }),
      stampMessage('assistant', 'about one', { stopIndex: 1 }),
      stampMessage('user', 'at two', { stopIndex: 2 }),
    ];
    expect(atStop(msgs, 1).map((m) => m.content)).toEqual(['at one', 'about one']);
    expect(atStop(msgs, 9)).toEqual([]);
  });
});

describe('what gets sent back with the next question', () => {
  it('keeps the last thirty turns', () => {
    const msgs = Array.from({ length: 50 }, (_, i) =>
      stampMessage(i % 2 === 0 ? 'user' : 'assistant', `m${i}`, { stopIndex: 0 }));
    const sent = forSending(msgs);
    expect(sent.length).toBeLessThanOrEqual(SEND_TURNS);
    expect(sent[sent.length - 1]!.content).toBe('m49');
  });

  it('never opens on an assistant turn', () => {
    // A transcript starting mid-answer reads as though the reader said something they did not.
    const msgs = [
      stampMessage('assistant', 'an answer with no question above it', { stopIndex: 0 }),
      stampMessage('user', 'the real first question', { stopIndex: 0 }),
    ];
    expect(forSending(msgs)[0]!.role).toBe('user');
  });

  it('drops empty content rather than sending blank turns', () => {
    const msgs = [stampMessage('user', '   ', {}), stampMessage('user', 'real', {})];
    expect(forSending(msgs).map((m) => m.content)).toEqual(['real']);
  });

  it('carries only role and content — the stamps are for the page, not the prompt', () => {
    const sent = forSending([stampMessage('user', 'q', { stopIndex: 2, file: 'a.ts' })]);
    expect(Object.keys(sent[0]!).sort()).toEqual(['content', 'role']);
  });
});

describe('reading back what a browser stored', () => {
  it('round-trips through JSON', () => {
    const msgs = [stampMessage('user', 'q', { stopIndex: 1, stopTitle: 'T', file: 'a.ts' }, 5)];
    expect(parseTranscript(JSON.stringify(msgs))).toEqual(msgs);
  });

  it('treats junk as an empty transcript, never a broken page', () => {
    expect(parseTranscript('not json at all')).toEqual([]);
    expect(parseTranscript(null)).toEqual([]);
    expect(parseTranscript('{"not":"an array"}')).toEqual([]);
    expect(parseTranscript([1, 'two', null])).toEqual([]);
  });

  it('defaults every field a older version might not have written', () => {
    // localStorage holds whatever was last written to it, including by older code.
    const [m] = parseTranscript([{ role: 'assistant', content: 'hello' }]);
    expect(m).toEqual({ role: 'assistant', content: 'hello', stopIndex: -1, stopTitle: null, file: null, ts: 0 });
  });

  it('treats an unknown role as the reader, not the assistant', () => {
    // The safer default: an assistant turn attributed to the reader is odd, but a reader's
    // words attributed to the assistant would be put in its mouth.
    expect(parseTranscript([{ role: 'system', content: 'x' }])[0]!.role).toBe('user');
  });
});
