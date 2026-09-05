/**
 * The Ask panel's brain: a persona, and everything the reader is currently looking at.
 *
 * Modelled on sql-gauntlet's tutor (`sql-gauntlet/server.js`), which the owner pointed at: a
 * persona system prompt, a `buildContextBlock` that flattens the current state into labelled
 * lines, and the local `claude` CLI as the backend so no API key is needed. repo-tour keeps
 * that shape and supplies its own backend — `llm.ts` already has the provider registry, and
 * the subscription-not-API-key constraint is the same one that shaped this whole product.
 *
 * What differs is the context. sql-gauntlet's tutor is given a question and the student's
 * SQL. This one is given the pull request, the file in view, its diff, THE DIGEST'S OWN
 * READING of that file, and — the point of the ticket — the reader's notes. An assistant
 * that cannot see what you flagged cannot help you review.
 *
 * ── T-18: it is given the code, and it can ask for more ──────────────────────────────────
 * Until 2026-09-05 it was handed a DESCRIPTION of the code and never the code, which made it
 * blindest at the exact moment it exists for: the tour did not cover this, let me ask. The
 * owner's ruling (Q1 on the decision form) was to send the source AND let it fetch what it
 * still needs — but through the server, not through real tools. That distinction is the whole
 * reason the option was picked over handing the CLI a toolbelt: with the server in the middle
 * the reader can be shown exactly what was looked at. So the model gets a PROTOCOL, not
 * permissions: it replies with one `FETCH:` line, something else serves it, and it is asked
 * again. `--allowedTools ''` stays set on every path in `llm.ts`.
 */

/**
 * How many times one question may send the model back for more material.
 *
 * Six is enough to follow a call into its definition and then into that file's own imports —
 * the shape of nearly every real "where does this actually happen" question — without letting
 * a confused model walk the repository on the reader's time. Hitting the cap is REPORTED in
 * the answer, never swallowed.
 */
export const MAX_FETCH_HOPS = 6;

/** Characters of the on-screen file to send. Beyond this the clip is stated, never silent. */
export const SOURCE_BUDGET = 24_000;

/** Characters of fetched material to carry across all hops of one question, together. */
export const FETCH_BUDGET = 40_000;

export const ASK_PERSONA = [
  'You are helping someone read a repository they did not write, inside repo-tour.',
  'They can see a page: a file, its diff if this is a pull request, and an explanation of',
  'what the code is for. You are given the same things, plus any notes they have taken.',
  '',
  'How to answer:',
  '- Answer the question asked. Do not restate the context back at them.',
  '- Ground every claim in what you were given. If the answer needs code you cannot see,',
  '  ask for it — see "Looking things up" — rather than guessing at its contents.',
  '- NEVER claim to have read a file, run a command, or checked a test. You have not. You',
  '  were handed some text, plus whatever you asked for.',
  '- When they ask about their notes, answer FROM the notes, and say which note you mean',
  '  ("your note on rank.ts:24"). Do not invent notes they did not write.',
  '- Say where a claim comes from, as a path with a line when you have one: rank.ts:24.',
  '  Cite ONLY files you were actually shown — the reader is told, on the page, when a',
  '  citation names a file you never read.',
  '- Be concise: usually under 200 words. Plain text. Fenced blocks for code. No headings.',
  '- If something in the diff looks wrong, say so plainly and say why. You are helping them',
  '  review, not reassuring them.',
  '- If you genuinely cannot tell, say that. "I cannot tell from what I can see here" is a',
  '  useful answer and a guess dressed as fact is not.',
  '',
  'Looking things up:',
  '- You may ask for material you were not given: another file, or where some text appears',
  '  across the repository. It is fetched for you and you are asked the question again.',
  '- To ask, reply with ONE line and NOTHING else — no preamble, no explanation, no answer:',
  '    FETCH: file <path from the repository root>',
  '    FETCH: search <text to find>',
  `- One request per reply, and at most ${MAX_FETCH_HOPS} of them for a single question, so`,
  '  spend them on what would actually change your answer.',
  '- When you have enough, answer normally. If you ran out of requests, say what you still',
  '  could not see.',
  '- You have no other tools and no shell. Nothing you ask for can change anything.',
].join('\n');

export interface AskNote {
  file?: string;
  startLine?: number;
  endLine?: number;
  stopTitle?: string | null;
  quote?: string;
  body?: string;
}

/** A file the tutor asked for and was given, or the search it ran. */
export interface AskFetched {
  /** what was asked for, in the protocol's own words: 'file src/rank.ts' or 'search foo' */
  what: string;
  body: string;
  /** set when the body was clipped, so the model knows it is not seeing all of it */
  truncated?: boolean;
}

export interface AskContext {
  /** the repository being read */
  repo?: string;
  /**
   * The repository root on disk, so whatever serves a FETCH knows which checkout to serve
   * from. Sent up by the page (which was itself served from /r?path=…) rather than guessed.
   */
  repoPath?: string;
  /**
   * What the digest concluded about the system as a whole (`ArchitectureMeaning.overview`).
   *
   * T-18 Q2: most first questions about an unfamiliar repository are orientation questions —
   * "where does this fit?" — and answering one from a single file's context produces a
   * confident answer that is narrower than the question.
   */
  repoOverview?: string;
  /** every stop in the tour, so "have we covered the parser yet?" is answerable */
  stops?: Array<{ index: number; title: string }>;
  /** set when the reader is on a pull request page */
  pr?: { number?: number | null; title?: string | null; body?: string | null; head?: string | null; base?: string | null };
  /** the file currently on screen */
  file?: string;
  /**
   * The actual source of that file.
   *
   * The gap T-18 exists to close: before it, this assistant was handed `fileMeaning` — a
   * description of the code — and never the code, so it could say what a file was for and
   * nothing about what any line in it did.
   */
  source?: string;
  /** total length of `source` before clipping, when it was clipped */
  sourceFullLength?: number;
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
  /** material the tutor asked for during THIS question, in the order it was fetched */
  fetched?: AskFetched[];
  /**
   * The build step in view, when the reader is walking a generated tutorial rather than
   * touring a finished repository (VSCode-LLM-Tutorial T-6). A flattened copy of the ONE
   * decision the learner is inside of (`src/build/types.ts`'s `Step.decision`) — not the
   * whole `BuildPlan` — because the assistant is answering about this step, not auditing
   * the plan.
   */
  build?: {
    question: string;
    options: Array<{ label: string; consequence: string; taken: boolean }>;
    why: string;
    /** the learner's file against the author's reference, once they have written anything */
    learnerDiff?: string;
  };
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
  if (ctx.repoOverview) lines.push(`What this repository is, as a whole:\n${clip(ctx.repoOverview, 3000)}`);
  if (ctx.stops && ctx.stops.length) {
    // Titles only. The reader can see one stop's words at a time and so can you; the list is
    // here to answer "where does this fit" and "what have I not seen yet", not to re-narrate.
    lines.push(
      `The tour has ${ctx.stops.length} stop${ctx.stops.length === 1 ? '' : 's'}:\n` +
        ctx.stops.map((s) => `  ${s.index + 1}. ${s.title}`).join('\n'),
    );
  }
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
  if (ctx.source) {
    // The clip is STATED with its real numbers rather than left as a bare "(truncated)":
    // a model that knows it is seeing the first 24k of a 60k file asks for the rest, and one
    // that does not know answers confidently about a file it has only seen the top of.
    const full = ctx.sourceFullLength ?? ctx.source.length;
    const shown = ctx.source.length;
    const how =
      shown < full
        ? ` (showing the first ${shown.toLocaleString()} characters of ${full.toLocaleString()} — ask for the file if you need the rest)`
        : '';
    lines.push(`The source of that file${how}:\n${ctx.source}`);
  }
  if (ctx.diff) lines.push(`The diff of that file:\n${clip(ctx.diff, 8000)}`);

  if (ctx.build) {
    // Its own heading, like the notes below: this is the decision the learner is INSIDE of
    // right now, not a fact about the file on screen, and it deserves to read as one.
    lines.push('--- THE BUILD STEP ---');
    lines.push(`Question: ${ctx.build.question}`);
    for (const o of ctx.build.options) {
      lines.push(`[${o.taken ? 'author' : 'alternative'}] ${o.label} — ${o.consequence}`);
    }
    lines.push(`Why: ${ctx.build.why}`);
    if (ctx.build.learnerDiff) {
      lines.push(`The learner's file against the author's:\n${clip(ctx.build.learnerDiff, 8000)}`);
    }
  }

  if (ctx.fetched && ctx.fetched.length) {
    // Its own heading, and phrased as YOU ASKED FOR: the model must be able to tell what it
    // pulled in from what was on the reader's screen, because a citation to the first is
    // honest and a citation to something it never saw is not.
    lines.push(`--- WHAT YOU ASKED FOR AND WERE GIVEN (${ctx.fetched.length}) ---`);
    for (const f of ctx.fetched) {
      lines.push(`[${f.what}]${f.truncated ? ' (clipped)' : ''}\n${f.body}`);
    }
  }

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

/** A request for material, parsed out of a reply that contained nothing else. */
export interface FetchRequest {
  kind: 'file' | 'search';
  arg: string;
}

/**
 * Is this reply a request for material, or is it the answer?
 *
 * STRICT on purpose, in one direction only: the whole reply must be the request and nothing
 * else. An answer that happens to discuss fetching ("you could FETCH: file rank.ts to see
 * it") is an ANSWER — showing it to the reader is right and silently going off to fetch
 * something instead is not. The cost of being wrong is asymmetric: a missed fetch reads as a
 * slightly unhelpful answer, a false fetch eats a hop and shows the reader nothing.
 *
 * Lenient in the other direction about one thing only: a model wrapping the line in a code
 * fence, which is common enough that rejecting it would turn real requests into nonsense
 * answers on the page.
 */
export function parseFetchRequest(reply: string): FetchRequest | null {
  let text = reply.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (text.includes('\n')) return null;

  const m = /^FETCH:\s*(file|search)\s+(.+)$/i.exec(text);
  if (!m) return null;
  const arg = m[2]!.trim().replace(/^['"`]|['"`]$/g, '').trim();
  if (!arg) return null;
  return { kind: m[1]!.toLowerCase() as 'file' | 'search', arg };
}

/**
 * Clip a body to what is left of a shared budget.
 *
 * Returns null when there is no room at all, so a caller can tell the model it has spent its
 * budget rather than handing it an empty block that reads like an empty file.
 */
export function clipToBudget(body: string, remaining: number): { body: string; truncated: boolean } | null {
  if (remaining <= 0) return null;
  if (body.length <= remaining) return { body, truncated: false };
  return { body: `${body.slice(0, remaining)}\n… (clipped here — the budget for fetched material ran out)`, truncated: true };
}
