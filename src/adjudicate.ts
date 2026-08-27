/**
 * Asking the model the question directly, instead of inferring it from two essays.
 *
 * ── Why this module exists (the measurement that forced it) ─────────────────────────────
 *
 * The first design compared the two INTERPRETATIONS of a file — stage 4's prose at the
 * checkpoint against stage 4's prose at the head — and scored how far the claims moved.
 * On hand-written pairs that separated beautifully: paraphrase 0.00-0.17, changed subject
 * 0.81-0.99.
 *
 * Then it met a real pull request. A commit that renamed five LOCAL VARIABLES in one
 * function — no exports touched, no imports touched, no behaviour touched — scored 0.47
 * and landed in the "meaning moved" band. Criterion 4 failed end to end.
 *
 * Reading both explanations showed why, and it was not a tuning problem. The model had not
 * paraphrased itself; it had written a different essay. One side mentioned monorepos, flat
 * lookups and the try/catch; the other mentioned shelling out, `path.posix.normalize`, and
 * what happens to a repo with zero commits. Both were correct. They overlapped about half.
 * Free prose describing the same code is simply not stable enough to diff, and no amount of
 * cleverness in the comparison recovers a signal the inputs do not carry.
 *
 * There is also a flaw in the premise the first design rested on. It treated identifiers as
 * the un-paraphrasable part — but a LOCAL variable is an identifier that carries no meaning
 * for a reader. Renaming one moves the vocabulary without moving the meaning, which is the
 * exact case criterion 4 tests.
 *
 * So this asks the question instead: here is the code before, here is the code after, did
 * what it is FOR change? That is one focused call per changed file, it is the question the
 * reader actually has, and it is answered by something that can read both versions at once
 * rather than by a metric guessing from two summaries.
 *
 * The deterministic comparison in delta.ts is kept and still runs. It is the fallback when
 * no model is available (`--no-interpret`), and a cheap second opinion when one is.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { defaultCacheDir } from './interpret.js';
import { runLlm, resolveChoice, type LlmChoice } from './llm.js';

/** Bump when the prompt changes — a cached verdict answered a different question. */
export const ADJUDICATOR_VERSION = 1;

export interface Adjudication {
  /** did what this code is FOR change? */
  changed: boolean;
  /** 0..1 — how far. A rename is 0; a rewritten purpose is 1. */
  magnitude: number;
  /** one line a reader can act on, written to sit in a tour stop's summary */
  headline: string;
  /** what kind of change this is, in the model's own judgement */
  kind: 'refactor' | 'behaviour' | 'surface' | 'new' | 'removed' | 'unclear';
  /** where this verdict came from, so a tour never implies more confidence than it has */
  source: 'model' | 'cache' | 'unavailable';
}

const SYSTEM = [
  'You are comparing two versions of the same source file from a pull request.',
  'Answer ONE question: did what this code is FOR change?',
  '',
  'Judge MEANING, not text. Specifically:',
  '- Renaming local variables, reformatting, reordering imports, changing comments, or',
  '  extracting a helper WITHOUT changing behaviour are all REFACTORS. magnitude 0.0-0.1.',
  '- A changed condition, threshold, default, order of operations, error path or return',
  '  value is BEHAVIOUR, even if the diff is tiny. magnitude 0.5-0.9.',
  '- An added, removed or re-shaped export is SURFACE — other code can feel it.',
  '  magnitude 0.6-1.0.',
  '- A file that now does a genuinely different job is NEW. magnitude 1.0.',
  '- If you truly cannot tell from what you were shown, say "unclear" and give 0.5.',
  '',
  'A LARGE diff that only renames things is still a refactor. A ONE LINE diff that flips a',
  'condition is still behaviour. Size is not the question; purpose is.',
  '',
  'The headline is one sentence for a reader skimming a list of changed files. Say what',
  'moved, concretely, naming identifiers. Never say "this change improves" or "this is a',
  'good refactor" — you are describing, not reviewing.',
  '',
  'Reply with ONLY this JSON object and nothing else:',
  '{"kind":"refactor|behaviour|surface|new|removed|unclear","magnitude":0.0,"headline":"..."}',
].join('\n');

function excerpt(code: string, limit = 6000): string {
  return code.length <= limit ? code : `${code.slice(0, limit)}\n… (truncated)`;
}

function buildPrompt(file: string, before: string, after: string): string {
  return [
    `File: ${file}`,
    '',
    '=== BEFORE ===',
    excerpt(before),
    '',
    '=== AFTER ===',
    excerpt(after),
    '',
    SYSTEM,
  ].join('\n');
}

function verdictKey(file: string, before: string, after: string, choice: LlmChoice): string {
  return createHash('sha256')
    .update(`${ADJUDICATOR_VERSION}:${file}:${before}:${after}:${choice.provider}:${choice.model}`)
    .digest('hex')
    .slice(0, 32);
}

function parse(raw: string): Omit<Adjudication, 'source'> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as {
      kind?: string; magnitude?: number; headline?: string;
    };
    const kinds = ['refactor', 'behaviour', 'surface', 'new', 'removed', 'unclear'] as const;
    const kind = (kinds as readonly string[]).includes(o.kind ?? '')
      ? (o.kind as Adjudication['kind'])
      : 'unclear';
    const magnitude = typeof o.magnitude === 'number' && o.magnitude >= 0 && o.magnitude <= 1
      ? o.magnitude
      : 0.5;
    const headline = typeof o.headline === 'string' && o.headline.trim().length > 0
      ? o.headline.trim()
      : 'The model returned no headline for this file.';
    return { kind, magnitude, changed: magnitude >= 0.15, headline };
  } catch {
    return null;
  }
}

export interface AdjudicateOptions {
  provider?: string;
  model?: string;
  cacheDir?: string;
  cwd?: string;
}

/**
 * Judge one file's change.
 *
 * Cached on the exact pair of file contents, so re-running a tour on the same PR is free
 * and a rebased branch only pays for what actually moved — the same content-keyed
 * discipline the interpret stage uses.
 */
export async function adjudicate(
  file: string,
  before: string,
  after: string,
  opts: AdjudicateOptions = {},
): Promise<Adjudication> {
  const choice = resolveChoice({ provider: opts.provider, model: opts.model });
  const cacheDir = opts.cacheDir ?? path.join(defaultCacheDir(), '..', 'adjudicate');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${verdictKey(file, before, after, choice)}.json`);

  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Omit<Adjudication, 'source'>;
      return { ...cached, source: 'cache' };
    } catch {
      /* a corrupt verdict is re-asked, not trusted */
    }
  }

  try {
    const reply = await runLlm(buildPrompt(file, before, after), choice, opts.cwd ?? process.cwd());
    const parsed = parse(reply.text);
    if (!parsed) {
      return {
        changed: false, magnitude: 0.5, kind: 'unclear',
        headline: 'The model did not answer in a readable form, so this file is unjudged.',
        source: 'unavailable',
      };
    }
    fs.writeFileSync(cachePath, JSON.stringify(parsed));
    return { ...parsed, source: 'model' };
  } catch (err) {
    // An unreachable model is a gap to state, never a quiet zero: scoring an unjudged file
    // as "nothing changed" is the failure direction that hides real change.
    return {
      changed: false, magnitude: 0.5, kind: 'unclear',
      headline: `Could not judge this file: ${(err as Error).message.split('\n')[0]}`,
      source: 'unavailable',
    };
  }
}
