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
export const ADJUDICATOR_VERSION = 2;

export interface Adjudication {
  /** did what this code is FOR change? */
  changed: boolean;
  /** 0..1 — how far. A rename is 0; a rewritten purpose is 1. */
  magnitude: number;
  /** one line a reader can act on, written to sit in a tour stop's summary */
  headline: string;
  /**
   * What this PR is PROPOSING TO CHANGE about code that already does something — the thing
   * Evan asked for and the first two versions of this did not give him:
   *
   *   "It needs to use the context of what's actually going on to tell us what the PR is
   *    proposing to change about it."
   *
   * So the model is handed the checkpoint's own reading of the file and the list of modules
   * that depend on it, and asked to write about the change IN THOSE TERMS. Not the commit
   * message paraphrased, and emphatically not the score.
   */
  narrative: string;
  /** what kind of change this is, in the model's own judgement */
  kind: 'refactor' | 'behaviour' | 'surface' | 'new' | 'removed' | 'unclear';
  /** where this verdict came from, so a tour never implies more confidence than it has */
  source: 'model' | 'cache' | 'unavailable';
}

const SYSTEM = [
  'You are explaining one file\'s change in a pull request, to someone who has never seen',
  'this repository. You are given what the file ALREADY does (worked out from the code',
  'before this change), what depends on it, and the diff.',
  '',
  'Answer two things.',
  '',
  'FIRST — did what this code is FOR change?',
  '- Renaming locals, reformatting, reordering imports, changing comments, or extracting a',
  '  helper WITHOUT changing behaviour are REFACTORS. magnitude 0.0-0.1.',
  '- A changed condition, threshold, default, order of operations, error path or return',
  '  value is BEHAVIOUR, even if the diff is one line. magnitude 0.5-0.9.',
  '- An added, removed or re-shaped export is SURFACE. magnitude 0.6-1.0.',
  '- A file that now does a genuinely different job is NEW. magnitude 1.0.',
  '- If you cannot tell from what you were shown, say "unclear" and give 0.5.',
  'A LARGE diff that only renames is still a refactor. A ONE LINE diff that flips a',
  'condition is still behaviour. Size is not the question; purpose is.',
  '',
  'SECOND — "narrative": two to four sentences on WHAT THIS PR IS PROPOSING TO CHANGE,',
  'written in terms of what this code is for and what leans on it.',
  '',
  'The narrative is the main thing you are producing. Rules for it:',
  '- START with the change itself, in plain words. Never start with a number, a score, a',
  '  band, a line count, or the words "meaning moved".',
  '- Say what the code did BEFORE, then what this change makes it do instead. The reader',
  '  has the diff in front of them; tell them what it MEANS, not what it says.',
  '- Where the dependents matter, say what this means for them concretely.',
  '- Name real identifiers and real values from the diff. "drops the multiplier from 0.5 to',
  '  0.05" beats "adjusts a weighting".',
  '- Do NOT review it. No "improves", "cleanly", "nicely", "should probably". Describe.',
  '- Do NOT mention how far ahead or behind any branch is. Not your subject.',
  '- If the diff genuinely changes nothing about purpose, say so plainly and briefly —',
  '  a reader who can skip a file is glad to be told.',
  '',
  'headline: ONE sentence, the same discipline, for a list view.',
  '',
  'Reply with ONLY this JSON object and nothing else:',
  '{"kind":"refactor|behaviour|surface|new|removed|unclear","magnitude":0.0,',
  ' "headline":"...","narrative":"..."}',
].join('\n');

export interface FileContext {
  /** what the checkpoint already worked out this file does */
  what?: string;
  /** and why it exists, where that was inferable */
  why?: string;
  /** modules that import it — the reason a change here can be felt elsewhere */
  importers?: string[];
}

function excerpt(code: string, limit = 6000): string {
  return code.length <= limit ? code : `${code.slice(0, limit)}\n… (truncated)`;
}

function buildPrompt(file: string, diff: string, ctx: FileContext): string {
  const parts: string[] = [`File: ${file}`, ''];

  if (ctx.what) {
    parts.push('=== WHAT THIS FILE ALREADY DOES (worked out before this change) ===', ctx.what);
    if (ctx.why) parts.push('', `Why it exists: ${ctx.why}`);
    parts.push('');
  }
  if (ctx.importers && ctx.importers.length) {
    parts.push(
      `=== WHAT DEPENDS ON IT === ${ctx.importers.length} module(s) import this file: ` +
        ctx.importers.slice(0, 12).join(', ') +
        (ctx.importers.length > 12 ? `, and ${ctx.importers.length - 12} more` : ''),
      '',
    );
  } else {
    parts.push('=== WHAT DEPENDS ON IT === nothing in this repository imports it.', '');
  }

  parts.push('=== THE DIFF ===', excerpt(diff, 9000), '', SYSTEM);
  return parts.join('\n');
}

function verdictKey(file: string, diff: string, ctx: FileContext, choice: LlmChoice): string {
  return createHash('sha256')
    .update(
      `${ADJUDICATOR_VERSION}:${file}:${diff}:${ctx.what ?? ''}:${(ctx.importers ?? []).join(',')}:` +
        `${choice.provider}:${choice.model}`,
    )
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
      kind?: string; magnitude?: number; headline?: string; narrative?: string;
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
    const narrative = typeof o.narrative === 'string' && o.narrative.trim().length > 0
      ? o.narrative.trim()
      : headline;
    return { kind, magnitude, changed: magnitude >= 0.15, headline, narrative };
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
  diff: string,
  ctx: FileContext,
  opts: AdjudicateOptions = {},
): Promise<Adjudication> {
  const choice = resolveChoice({ provider: opts.provider, model: opts.model });
  const cacheDir = opts.cacheDir ?? path.join(defaultCacheDir(), '..', 'adjudicate');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${verdictKey(file, diff, ctx, choice)}.json`);

  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Omit<Adjudication, 'source'>;
      return { ...cached, source: 'cache' };
    } catch {
      /* a corrupt verdict is re-asked, not trusted */
    }
  }

  try {
    const reply = await runLlm(buildPrompt(file, diff, ctx), choice, opts.cwd ?? process.cwd());
    const parsed = parse(reply.text);
    if (!parsed) {
      return {
        changed: false, magnitude: 0.5, kind: 'unclear',
        headline: 'The model did not answer in a readable form, so this file is unjudged.',
        narrative: 'This file could not be interpreted on this run. The diff below is the whole of what is known about it here.',
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
      narrative: 'This file could not be interpreted on this run. The diff below is the whole of what is known about it here.',
      source: 'unavailable',
    };
  }
}
