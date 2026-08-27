/**
 * The Ask panel's brain: a persona, and everything the reader is currently looking at.
 *
 * Modelled on sql-gauntlet's tutor (`sql-gauntlet/server.js`), which Evan pointed at: a
 * persona system prompt, a `buildContextBlock` that flattens the current state into labelled
 * lines, and the local `claude` CLI as the backend so no API key is needed. repo-tour keeps
 * that shape and supplies its own backend — `llm.ts` already has the provider registry, and
 * the subscription-not-API-key constraint is the same one that shaped this whole product.
 *
 * What differs is the context. sql-gauntlet's tutor is given a question and the student's
 * SQL. This one is given the pull request, the file in view, its diff, THE DIGEST'S OWN
 * READING of that file, and — the point of the ticket — the reader's notes. An assistant
 * that cannot see what you flagged cannot help you review.
 */

export const ASK_PERSONA = [
  'You are helping someone read a repository they did not write, inside repo-tour.',
  'They can see a page: a file, its diff if this is a pull request, and an explanation of',
  'what the code is for. You are given the same things, plus any notes they have taken.',
  '',
  'How to answer:',
  '- Answer the question asked. Do not restate the context back at them.',
  '- Ground every claim in what you were given. If the answer needs code you cannot see,',
  '  say which file you would need rather than guessing at its contents.',
  '- NEVER claim to have read a file, run a command, or checked a test. You have not. You',
  '  were handed some text.',
  '- When they ask about their notes, answer FROM the notes, and say which note you mean',
  '  ("your note on rank.ts:24"). Do not invent notes they did not write.',
  '- Be concise: usually under 200 words. Plain text. Fenced blocks for code. No headings.',
  '- If something in the diff looks wrong, say so plainly and say why. You are helping them',
  '  review, not reassuring them.',
  '- If you genuinely cannot tell, say that. "I cannot tell from what I can see here" is a',
  '  useful answer and a guess dressed as fact is not.',
  '- Do not use tools, read files, or run commands. Answer directly in plain text.',
].join('\n');

export interface AskNote {
  file?: string;
  startLine?: number;
  endLine?: number;
  stopTitle?: string | null;
  quote?: string;
  body?: string;
}

export interface AskContext {
  /** the repository being read */
  repo?: string;
  /** set when the reader is on a pull request page */
  pr?: { number?: number | null; title?: string | null; body?: string | null; head?: string | null; base?: string | null };
  /** the file currently on screen */
  file?: string;
  /** what the digest worked out this file is for */
  fileMeaning?: string;
  /** what the tour is currently saying about it */
  stopTitle?: string | null;
  stopText?: string | null;
  /** the unified diff of the file in view, when there is one */
  diff?: string;
  /** what else imports the file in view */
  importers?: string[];
  /** everything the reader has written down */
  notes?: AskNote[];
}

export interface AskMessage {
  role: 'user' | 'assistant';
  content: string;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated)`;
}

/**
 * Flatten the page into labelled lines.
 *
 * Labelled rather than prose so the model can tell the reader's words from the tool's:
 * the notes are the human's, the meaning is the machine's, and an answer that confuses the
 * two would be worse than no answer.
 */
export function buildContextBlock(ctx: AskContext): string {
  const lines: string[] = ['--- WHAT THE READER IS LOOKING AT ---'];
  if (ctx.repo) lines.push(`Repository: ${ctx.repo}`);
  if (ctx.pr) {
    lines.push(
      `Pull request: ${ctx.pr.number ? `#${ctx.pr.number} ` : ''}${ctx.pr.title ?? '(untitled)'}` +
        (ctx.pr.head && ctx.pr.base ? ` (${ctx.pr.head} → ${ctx.pr.base})` : ''),
    );
    if (ctx.pr.body) lines.push(`Its description:\n${clip(ctx.pr.body, 1500)}`);
  }
  if (ctx.file) lines.push(`File on screen: ${ctx.file}`);
  if (ctx.fileMeaning) lines.push(`What the digest worked out this file is for:\n${clip(ctx.fileMeaning, 2000)}`);
  if (ctx.importers && ctx.importers.length) {
    lines.push(`Imported by ${ctx.importers.length}: ${ctx.importers.slice(0, 15).join(', ')}`);
  }
  if (ctx.stopTitle || ctx.stopText) {
    lines.push(`The tour is currently saying:\n${ctx.stopTitle ? ctx.stopTitle + '\n' : ''}${clip(ctx.stopText ?? '', 2000)}`);
  }
  if (ctx.diff) lines.push(`The diff of that file:\n${clip(ctx.diff, 8000)}`);

  if (ctx.notes && ctx.notes.length) {
    lines.push(`--- THE READER'S OWN NOTES (${ctx.notes.length}) ---`);
    ctx.notes.slice(0, 40).forEach((n, i) => {
      const where = `${n.file ?? '?'}:${n.startLine ?? '?'}${n.endLine && n.endLine !== n.startLine ? `-${n.endLine}` : ''}`;
      lines.push(
        `[note ${i + 1}] ${where}` +
          (n.stopTitle ? ` — taken while reading "${n.stopTitle}"` : '') +
          `\n  they wrote: ${clip(n.body ?? '', 800)}` +
          (n.quote ? `\n  about this code:\n${clip(n.quote, 600)}` : ''),
      );
    });
  } else {
    lines.push("--- THE READER'S OWN NOTES --- none yet.");
  }

  lines.push('--- END ---');
  return lines.join('\n');
}

/**
 * The whole prompt, for a provider that takes one string.
 *
 * `runLlm` speaks to CLIs, not to a chat API, so the conversation is rendered into the
 * document rather than passed as turns. Same choice sql-gauntlet makes on its CLI path.
 */
export function buildAskPrompt(messages: AskMessage[], ctx: AskContext): string {
  const doc: string[] = [ASK_PERSONA, '', buildContextBlock(ctx), '', '--- CONVERSATION SO FAR ---'];
  for (const m of messages) {
    doc.push(`${m.role === 'assistant' ? 'ASSISTANT' : 'READER'}: ${m.content}`);
  }
  doc.push(
    '--- END CONVERSATION ---',
    '',
    "Write the assistant's next reply to the reader's last message.",
    'Output ONLY the reply text — no role prefix, no preamble.',
  );
  return doc.join('\n');
}

/**
 * Trim a conversation to what is worth sending.
 *
 * Last 30 turns, and never starting on an assistant turn — the same two rules sql-gauntlet
 * applies, for the same reason: a transcript that opens mid-answer reads as though the
 * reader said something they did not.
 */
export function trimMessages(raw: unknown): AskMessage[] {
  if (!Array.isArray(raw)) return [];
  const msgs: AskMessage[] = raw
    .filter((m): m is { role?: unknown; content?: unknown } => typeof m === 'object' && m !== null)
    .map((m) => ({
      role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: String(m.content ?? ''),
    }))
    .filter((m) => m.content.trim().length > 0)
    .slice(-30);
  while (msgs.length && msgs[0]!.role !== 'user') msgs.shift();
  return msgs;
}
