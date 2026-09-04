# T-12 — The build-order engine: digest → BuildPlan, and the structural check

**Type:** feature · **Shop:** repo-tour · **Serves:** VSCode-LLM-Tutorial T-1 (`../VSCode-LLM-Tutorial/.autodev/specs/T-1-build-tutorials-v1.md` §4 — the data model is §4.2; implement it as written) · **Risk:** medium
**Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (GA-8).

## The ticket's spec (captured, not re-composed)

WHY: the VS Code tutorial walks a learner through BUILDING a repo by its decisions. The ordered decision list is a projection of the digest, computed the way src/tour.ts computes a tour: deterministic, free, disposable. Full design: VSCode-LLM-Tutorial .autodev/specs/T-1-build-tutorials-v1.md §4 (the data model is §4.2 — implement it as written; it is complete from day one on Evan's instruction).

ACs:
1. src/build/plan.ts exports buildPlan(digest: DigestResult, opts): BuildPlan. Chapters come from subsystem tiers ordered after the chapters they import from; files within a chapter in topological import order (leaves first), ties by first-commit date then rank score. Check: a synthetic git fixture with a known import DAG yields the expected order, exact equality.
2. Step kinds shape / file / symbol as specified; symbol steps are the exported symbols capped at 5 per file by span; test files follow the file they test; generated/vendored/lockfile files never become steps but are listed in plan.reproduce. Check: fixture assertions per kind.
3. Every step has a stable id = sha256(file + kind + symbol name) that survives regeneration and a rename-free edit. Check: regenerate after editing a body; ids unchanged.
4. Witness per step from git log --diff-filter=A on the file's own repo; a repo with no history yields nulls, never invented values. Check: fixture with history and one without.
5. scaffold ranges: loadBearing = symbol-step ranges, boilerplate = the rest; a stub generator keeps the signature line and emits a language-correct placeholder body so the file parses. Check: stubbed TS, JS and Python files each parse with zero tree-sitter ERROR nodes.
6. src/build/check.ts exports check(learnerSource, referenceExtract, language): a structural report — exported symbols (name+kind) present/missing/extra, resolved imports present/missing, parseErrors. It never compares bodies. Check: a reference body with a renamed local variable passes; a missing export is reported by name.
7. decision.options is populated with the author's option only (taken:true) and decision.why from the docstring when one exists, whySource set accordingly; interpretation (alternatives) is T-13's. Check: schema test — options.length ≥ 1 here, ≥ 2 after T-13.
8. A JSON schema for BuildPlan ships at schema/build-plan.schema.json and every generated plan validates. Check: vitest with a schema validator on fixtures.
9. CLI: repo-tour plan <path> [--json] writes <path>/.repo-tour/build/plan.json and prints chapter/step counts. Check: run on the test fixture.

Out of scope
- Alternatives per step via the model — T-13
- Mode A (idea) and divergence/replan — VSCode-LLM-Tutorial T-9 and T-10 (the enum and fields exist here; only 'recreate' is produced)
- Languages beyond the shipped grammars — deferred: who=human:evan why=repo-tour T-1 §3 fixed grammar coverage

## Refinement notes (2026-09-04)

- **Chapters come from the architecture layer, not raw tiers.** `src/architecture.ts#buildArchitecture`
  already finds parts (nested repos first, then ownership by longest path prefix) and layers them by
  peeling the import graph — ways in at the top, foundations at the bottom (lesson: "A tour made only of
  files teaches you files"). Build order is that layering **bottom-up**. Fall back to subsystem tiers only
  when the architecture yields a single part.
- **The check needs a parse of the learner's file.** `extract()` reads from disk and its parsers map is
  module-private; T-11 is editing `src/extract.ts` in parallel. So `check()` writes the learner source to
  a temp dir at the same relative path and calls `extract()` normally — no shared-file edit.
- **No `ajv`.** `package.json` is T-11's file this week and the repo has a zero-runtime-dependency
  stance. The schema test validates with a small hand-rolled checker (required keys, types, enums) in
  the test itself.
- **Ids.** First 16 hex of `sha256(file + ' ' + kind + ' ' + symbolName)` — stable across regeneration
  and across body edits; a rename changes it, which is correct (a moved file is a new decision).
