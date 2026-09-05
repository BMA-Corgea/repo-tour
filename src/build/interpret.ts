/**
 * Fold repo-tour's interpret stage into a `BuildPlan` — VSCode-LLM-Tutorial spec §4.3.
 *
 * `buildPlan` (plan.ts) can only ever report the author's OWN choice: git history and the
 * AST show what happened, never what else could have. That is the one thing this
 * repository cannot answer from its own bytes, so it is the one thing worth paying a model
 * for — and it is asked in the SAME call that already writes `what`/`why`/`summary`
 * (`src/interpret.ts`), never a second one: two other reasonable ways this could have been
 * done, and what each would have cost. Even in `recreate` mode the learner sees "the author
 * chose X; Y and Z were on the table" — that is the teaching, and it is what makes
 * divergence (T-9/T-10) a change of defaults rather than new machinery.
 *
 * This is a second PROJECTION layered on the first: `interpretPlan` takes a `BuildPlan`
 * (already free to build — plan.ts's own doctrine) and the digest it came from, and returns
 * a NEW plan with its `symbol` and `file` steps folded with what the model said. `shape`
 * steps are left alone: `interpretArchitecture` writes one brief for the whole system, not
 * one per chapter, and mapping it onto a chapter's own `why` is a separate, smaller piece
 * of work (refinement notes, 2026-09-04) rather than something to half-do here. Nothing
 * here mutates its input — same rule as `buildPlan`, for the same reason: a plan is
 * disposable and regenerable, never hand-repaired.
 */

import type { DigestResult } from '../digest.js';
import type { CodeStep } from '../codetour.js';
import {
  interpretStops, stepKey, type InterpretCost, type InterpretOptions, type StopMeaning,
} from '../interpret.js';
import type { BuildPlan, Option, Step } from './types.js';

/** `interpretStops` needs the real files on disk; the plan alone never carries them. */
export interface InterpretPlanOptions extends InterpretOptions {
  /** the scan root — same one `buildPlan`'s own `BuildPlanOptions.root` names */
  root: string;
}

export interface InterpretPlanResult {
  plan: BuildPlan;
  cost: InterpretCost;
}

/**
 * A `file` step's own range: lines 1 through what a file says about itself before any one
 * symbol does — imports, exports, the shape of the module — capped so a 3,000-line file
 * costs the same one call as a 30-line one. `null` when there is nothing to read (an empty
 * file `inventory.ts` still recorded as a step target).
 */
const FILE_HEAD_LINES = 120;

function fileHeadRange(loc: number): { startLine: number; endLine: number } | null {
  return loc > 0 ? { startLine: 1, endLine: Math.min(loc, FILE_HEAD_LINES) } : null;
}

/**
 * The range a `Step` occupies, in the same terms `interpretStops` keys its answers by — or
 * `null` for a step this ticket does not interpret: a `shape` step (see the file header),
 * or one with nothing to show (an empty file; a `symbol` step somehow missing its range,
 * which a real `buildPlan` output never produces but this function does not trust blindly).
 *
 * Shared by both the request side (`codeStepsFor`) and the fold side (`interpretPlan`'s own
 * map loop) so the two can never silently compute a different range for the same step.
 */
function rangeOf(step: Step, locByPath: ReadonlyMap<string, number>): { startLine: number; endLine: number } | null {
  if (step.kind === 'symbol') {
    const { startLine, endLine } = step.target;
    return startLine != null && endLine != null ? { startLine, endLine } : null;
  }
  if (step.kind === 'file') return fileHeadRange(locByPath.get(step.target.file) ?? 0);
  return null; // shape
}

/**
 * The `CodeStep[]` `interpretStops` actually reads, built from a plan's own `symbol` and
 * `file` steps. Deduplicated by `stepKey`: two steps can only land on the exact same lines
 * when a file's head range coincides with its one symbol's full span (a tiny, single-
 * function file with no leading blank line before it) — real, cheap to guard against, and
 * otherwise a wasted second call for lines the model already explained once.
 */
function codeStepsFor(plan: BuildPlan, locByPath: ReadonlyMap<string, number>): CodeStep[] {
  const seen = new Set<string>();
  const out: CodeStep[] = [];
  for (const step of plan.steps) {
    const range = rangeOf(step, locByPath);
    if (!range) continue;
    const key = stepKey(step.target.file, range.startLine, range.endLine);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      file: step.target.file,
      startLine: range.startLine,
      endLine: range.endLine,
      title: step.decision.question,
      text: '', // interpretStops never reads a CodeStep's own text; only the range and title
    });
  }
  return out;
}

/**
 * `authorOnlyDecision`'s inverse: fold a model's answer INTO a decision that already holds
 * the author's own choice as its one option. The author's `id`/`label`/`taken` survive
 * untouched — only its `consequence` is upgraded from the deterministic one-liner `plan.ts`
 * wrote to the model's own summary of what the code actually does. The alternatives become
 * new options, `taken: false`, with small stable-within-this-step ids — they are never
 * claimed to mean anything outside this one decision, unlike a step's own `id` (plan.ts).
 */
function foldMeaning(step: Step, meaning: StopMeaning): Step {
  const author = step.decision.options.find((o) => o.id === step.decision.authorChoice)!;
  const options: Option[] = [
    { ...author, consequence: meaning.summary || author.consequence },
    ...meaning.alternatives.map((a, i): Option => ({
      id: `alt-${i + 1}`, label: a.label, consequence: a.consequence, taken: false,
    })),
  ];
  return {
    ...step,
    decision: {
      ...step.decision,
      options,
      why: meaning.why || step.decision.why,
      whySource: 'interpret',
    },
  };
}

/**
 * `buildPlan`'s output, with the model's own answer folded into every `symbol`/`file` step
 * it could actually interpret. A step it could not — nothing cached under `cachedOnly`,
 * every provider unreachable, an empty file — keeps exactly what `buildPlan` gave it: the
 * docstring, or the honest "not inferable from the source" (AC2). Never mutates `plan`;
 * returns a new one, with `cost` and `generatedAt` refreshed — the same projection doctrine
 * `buildPlan` itself follows.
 */
export async function interpretPlan(
  plan: BuildPlan,
  digest: DigestResult,
  opts: InterpretPlanOptions,
): Promise<InterpretPlanResult> {
  const locByPath = new Map(digest.inventory.files.map((f) => [f.path, f.loc] as const));
  const codeSteps = codeStepsFor(plan, locByPath);

  const { meanings, cost } = await interpretStops(
    opts.root, codeSteps, digest.inventory.files, digest.extracts, digest.graph.edges, opts,
  );

  const steps = plan.steps.map((step) => {
    const range = rangeOf(step, locByPath);
    if (!range) return step;
    const meaning = meanings.get(stepKey(step.target.file, range.startLine, range.endLine));
    return meaning ? foldMeaning(step, meaning) : step;
  });

  return { plan: { ...plan, steps, cost, generatedAt: new Date().toISOString() }, cost };
}
