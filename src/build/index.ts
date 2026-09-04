/**
 * The build-order engine's public surface — the one import path everything outside this
 * directory should use (`./build/index.js`, and via package.json's `./build` export the
 * one a consumer outside this repo uses too — T-11).
 */

export { buildPlan, type BuildPlanOptions } from './plan.js';
export { stubFile, type StubQuestion } from './stub.js';
export { check } from './check.js';
export { firstCommits, NULL_WITNESS, type Witness } from './witness.js';
export type {
  BuildPlan, Chapter, Step, StepKind, Option, Range, CheckReport,
} from './types.js';
