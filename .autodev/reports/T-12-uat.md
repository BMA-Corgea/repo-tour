# T-12 — UAT: is this what the owner MEANT?

**Intent chain:** VSCode-LLM-Tutorial T-1 → spec §2 (the one abstraction: an ordered decision list), §4
(a projection of the digest — deterministic, free, disposable), §4.2 (the data model complete from day
one — Evan: "we also need to know that it's going to have the other modes be part of it"), §9 #1–#4.

**Conformance read (agent, uat level auto; accept spent on-behalf under GA-8 — "loop through it until these
are created"):**

| what was meant | what was built | verdict |
| --- | --- | --- |
| every source file becomes a step, in dependency order | topological, leaves-first within chapters; chapters bottom-up from the architecture layers; deterministic on cycles (review-tested) | conforms |
| the data model carries the other modes now, not later | `mode` enum, `source` union, `chosen`, `options`, `whySource`, `witness`, `scaffold`, `dependsOn` — implemented verbatim (review angle 1, complete) | conforms |
| nothing invented: why from the docstring or an honest "not inferable" | `whySource: 'docstring' \| 'none'`; interpret comes with T-13 | conforms |
| automated mode can reproduce the repo byte-for-byte | after rework: every inventoried file is a step or in `plan.reproduce` (invariant asserted on all 16 fixture plans) | conforms |
| the check never fails you for naming a variable differently | structural only; renamed local passes; parse failures now carry a reason | conforms |
| the witness never lies | `--diff-filter=AR` finds rename-introduced files; nulls without history | conforms |

**Fitness in the hands:** `repo-tour plan <fixture>` writes `plan.json` a person can read — questions read
as questions, the author's option is marked. The first real target (sql-gauntlet) is the orchestrator's
acceptance run once the extension's start screen (T-3) exists to drive it.

**Gaps:** none against intent. Advisory items recorded in the handoff (chapter ordering duplicates
`architecture.ts` layering; a multi-line brace-less arrow is left un-hidden by the stub) — neither changes
what a learner sees in v1.
