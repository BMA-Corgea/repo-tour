/**
 * The tutor transcript: the record shape, the storage key, and what gets sent.
 *
 * Same split `notes.ts` established, for the same reason: the SHAPE is shared and each page
 * does its own rendering. What is shared is what has to survive — a transcript written on a
 * repo tour and read back after a rebuild, and the rule about what is worth sending back to
 * the model.
 *
 * ── Why one thread and not one per stop (T-18 Q3) ────────────────────────────────────────
 * The obvious design is a conversation per stop, which keeps context clean and means the
 * assistant never confuses two files. The owner picked the other one, and the reason is that
 * understanding a repository is cumulative: "so is that the same ranking thing you mentioned
 * three stops ago?" is a question a reader actually asks, and a per-stop thread cannot hear
 * it. The cost is a growing prompt, paid down by `forSending`'s trim.
 *
 * Every message still records the stop it was asked at, so the thread can be filtered to one
 * stop, and so a transcript read a week later says where the reader was standing.
 */

import type { AskMessage } from './ask.js';

/**
 * Keyed to the repository — and to the pull request when there is one.
 *
 * Deliberately parallel to `notesKey`, and deliberately NOT keyed to the commit: a
 * conversation that vanished because the tour was rebuilt would be the same defect the notes
 * key exists to avoid.
 */
export function chatKey(repoName: string, pr?: number | null): string {
  return pr ? `repotour:chat:${repoName}#pr-${pr}` : `repotour:chat:${repoName}`;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** which stop was on screen; -1 when the reader was browsing rather than touring */
  stopIndex: number;
  stopTitle: string | null;
  /** the file on screen when this was said */
  file: string | null;
  /** epoch millis, so a transcript can be read in order it was actually said */
  ts: number;
}

/** How many turns of history to send back. Same number `trimMessages` has always used. */
export const SEND_TURNS = 30;

/** Stamp a line of the conversation with where the reader was standing when they said it. */
export function stampMessage(
  role: 'user' | 'assistant',
  content: string,
  where: { stopIndex?: number; stopTitle?: string | null; file?: string | null },
  now = Date.now(),
): ChatMessage {
  return {
    role,
    content,
    stopIndex: where.stopIndex ?? -1,
    stopTitle: where.stopTitle ?? null,
    file: where.file ?? null,
    ts: now,
  };
}

/**
 * The part of a stored transcript worth sending with the next question.
 *
 * Two rules, both inherited from `trimMessages`: the last thirty turns, and never opening on
 * an assistant turn — a transcript that starts mid-answer reads as though the reader said
 * something they did not.
 */
export function forSending(msgs: ChatMessage[]): AskMessage[] {
  const out = msgs
    .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-SEND_TURNS)
    .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content }));
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out;
}

/** The messages asked at one stop — the panel's "this stop" filter. */
export function atStop(msgs: ChatMessage[], stopIndex: number): ChatMessage[] {
  return msgs.filter((m) => m.stopIndex === stopIndex);
}

/**
 * Read a stored transcript back, discarding anything that is not a message.
 *
 * localStorage holds whatever was last written to it, including something written by an older
 * version of this file, so every field is defaulted rather than trusted. A transcript that
 * fails to parse is an empty one, never a broken page.
 */
export function parseTranscript(raw: unknown): ChatMessage[] {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      role: m['role'] === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(m['content'] ?? ''),
      stopIndex: typeof m['stopIndex'] === 'number' ? m['stopIndex'] : -1,
      stopTitle: typeof m['stopTitle'] === 'string' ? m['stopTitle'] : null,
      file: typeof m['file'] === 'string' ? m['file'] : null,
      ts: typeof m['ts'] === 'number' ? m['ts'] : 0,
    }))
    .filter((m) => m.content.trim().length > 0);
}
