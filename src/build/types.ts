/**
 * The build-order engine's data model — VSCode-LLM-Tutorial spec §4.2, implemented as
 * written and in full on day one. Evan's instruction (T-1 §7): v1 produces only
 * `mode: 'recreate'`, but `mode` is already an enum, `source` already a union, `chosen`
 * already a field, and `decision.options` is always populated (one entry, `taken: true`,
 * until T-13's interpret pass adds the roads not taken). Not because THIS version needs
 * the extra shape — because a data model built for one mode has to be migrated for the
 * next one, and a migration nobody can observe from outside is the one kind a spec can
 * prevent outright by just writing the whole shape down first.
 *
 * Everything below is a PROJECTION of a repo-tour digest, exactly like `src/tour.ts`:
 * computed at plan time, true only of the digest that produced it, disposable and
 * regenerable. A `BuildPlan` is never hand-edited and never repaired in place — when the
 * reference repo moves, `buildPlan` (plan.ts) is run again, which is only affordable
 * because — like every stage before stage 4 — it costs nothing.
 */

import type { InterpretCost } from '../interpret.js';
import type { SymbolKind } from '../types.js';

/** A 1-indexed, inclusive line range — the unit `extract()` already reports symbols in. */
export interface Range {
  startLine: number;
  endLine: number;
}

/**
 * One way a decision could have gone. In `recreate` mode only the author's own choice is
 * known, so `taken: true` on exactly one option and `options.length === 1` — until T-13's
 * interpret pass asks the same model call for two roads not taken and raises the floor to
 * `>= 2` (AC7). The schema and every consumer are built for `>= 2` from day one so that
 * arrival is a new prompt, never a new shape.
 */
export interface Option {
  id: string;
  label: string;
  consequence: string;
  taken: boolean;
}

/**
 * A chapter is a subsystem or a tier, never a raw directory listing — `architecture.ts`'s
 * header again: a tour (or a build) made only of files teaches you files, not a system.
 * `key` is the stable id steps point back to (`Step.chapter`); `tierPath` names the digest
 * tier or architecture part this chapter renders, so a caller can always find the numbers
 * a chapter's `shape` step is talking about. The two coincide for every real chapter; only
 * the synthetic catch-all (`@misc` — files no named part claimed) has no tier behind it,
 * and says so honestly with the same sentinel in both fields, the way `codetour.ts` uses
 * `@end` for its own synthetic closing chapter.
 */
export interface Chapter {
  key: string;
  title: string;
  subtitle: string;
  tierPath: string;
}

export type StepKind = 'shape' | 'file' | 'symbol';

export interface Step {
  /**
   * Stable: first 16 hex of `sha256(file + ' ' + kind + ' ' + symbolName)`. It survives
   * regeneration and a body edit — neither changes the file, the kind, or the symbol's
   * name. A rename DOES change it, which is correct: a moved file is a new decision, not
   * the same one continuing under a new name (refinement notes, 2026-09-04).
   *
   * It is also UNIQUE across a plan, which the recipe alone does not guarantee: two
   * distinct symbols may legally share a name in one file (a Python top-level `def f`
   * redefined further down), and (file, kind, name) cannot tell them apart. The n-th
   * LATER occurrence of the same (file, kind, name) — n from 1, in the file's own line
   * order — hashes `… + ' #' + n` instead. The first occurrence is untouched, so
   * disambiguation costs no stability: an id moves only when the file, kind, name, or the
   * symbol's position among its same-named siblings actually moves.
   */
  id: string;
  ordinal: number;
  chapter: string;
  kind: StepKind;
  decision: {
    question: string;
    /** ALWAYS >= 1 here; T-13's interpret pass raises the floor to >= 2 (AC7). */
    options: Option[];
    /** the option id that is the ground truth — always `taken: true` on that option */
    authorChoice: string;
    /** recreate mode: === authorChoice. The field exists now for Mode A / divergence (T-9, T-10) */
    chosen: string | null;
    /** interpret's why, else the docstring, else the honest fallback — never invented */
    why: string;
    whySource: 'interpret' | 'docstring' | 'none';
  };
  target: { file: string; startLine?: number; endLine?: number };
  /** from `extract()`'s symbol ranges — always non-overlapping and sorted (spec §4.5) */
  scaffold: { loadBearing: Range[]; boilerplate: Range[] };
  /** step ids, from the import graph — never a guess about what "should" come first */
  dependsOn: string[];
  /** null, never invented, when the file's own repo has no history for it (AC4) */
  witness: { sha: string | null; date: string | null; subject: string | null };
}

export interface BuildPlan {
  schemaVersion: 1;
  source:
    | { kind: 'repo'; root: string; head: string | null }
    | { kind: 'idea'; text: string }
    | { kind: 'both'; root: string; head: string | null; text: string };
  /** v1 (this ticket) produces only 'recreate'; the enum exists now for T-9 (idea) and T-10 (guided/divergence) */
  mode: 'recreate' | 'guided' | 'idea';
  chapters: Chapter[];
  /** flat, ordered; each step names its chapter rather than nesting, so ordinal is a plain index */
  steps: Step[];
  generatedAt: string;
  /** repo-tour's own cost shape; `metered: false` here is an honest "no model ran", never a zero pretending to be a measurement */
  cost: InterpretCost;
  /**
   * Every inventoried path that is copied rather than taught: generated, vendored,
   * lockfile, `data`, and anything binary (AC2). Together with the `file` steps' targets
   * this covers EVERY file the digest inventoried, with no overlap — the invariant that
   * makes automated mode able to reproduce the reference byte-for-byte (T-1 spec §9-3).
   */
  reproduce: string[];
}

/**
 * `check()`'s report — structural only, and it says so in what it is ABLE to hold: no
 * field here can express "the body does something different", because nothing upstream
 * of it ever looks at a body (spec §4.4).
 */
export interface CheckReport {
  symbols: Array<{ name: string; kind: SymbolKind; status: 'present' | 'missing' | 'extra' }>;
  imports: Array<{ raw: string; status: 'present' | 'missing' }>;
  parseErrors: number;
  ok: boolean;
}
