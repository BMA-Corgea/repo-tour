# T-1 — Execution plan

**Stage:** `plan` · **Written:** 2026-08-26 · **By:** agent:planner
**Branch:** `T-1-digest-engine`
**Delivery target:** local-only topology — no git remote is configured in this working
tree, so the target is *the ticket branch existing locally with the plan committed*.
No draft PR is required or possible. `github.com/BMA-Corgea/repo-tour` exists and is
empty; wiring it as a remote and pushing is Evan's call, not this stage's requirement.

## Delegation shape: INLINE, SERIAL

Not parallel, and not by subagent. The reason is a hard data dependency, not caution:

```
inventory ──▶ extract ──▶ rank
   files       in-degree    score
```

Stage 2 (rank) consumes the import graph that stage 3 (extract) produces, and stage 3
consumes the file list stage 1 produces. There is no independent piece to fan out, and
splitting a three-link chain across isolated workers would cost worktree setup and a
merge for zero concurrency. No git worktrees are created.

## Sub-tasks

| # | Sub-task | Files | Proves |
| --- | --- | --- | --- |
| 1 | Project scaffold: package.json, tsconfig, deps pinned | `package.json`, `tsconfig.json` | the language decision is real |
| 2 | Shared shapes | `src/types.ts` | stage boundaries are typed, not implied |
| 3 | Stage 1 — inventory | `src/inventory.ts` | criteria 1, 2 |
| 4 | Stage 3 — extract | `src/extract.ts` | criterion 4 |
| 5 | Stage 2 — rank | `src/rank.ts` | criterion 3 |
| 6 | Driver + manifest + on-disk cache | `src/digest.ts` | criteria 6, 7 |
| 7 | CLI and human-readable report | `src/cli.ts` | criterion 7 |
| 8 | Acceptance tests on live git fixtures | `test/pipeline.test.ts` | criteria 1, 2, 3, 4, 6, 7 |
| 9 | Trial run against a real multi-repo tree | — | criteria 1, 3, 9 |

## Order, and why it is not the spec's numbering

The spec numbers rank as stage 2 and extract as stage 3, and that numbering is right for
*cost* — rank is the cheaper idea. But in-degree is a product of the import graph, so
extract must **run** first. `digest.ts` calls `extract` then `rank` while reporting each
under its own name, so the numbering stays honest and the dependency is satisfied.

## Explicitly deferred inside this ticket

| Deferred | Why | Where it surfaces |
| --- | --- | --- |
| Stage 4 — interpret | the only paid stage; the free stages must be judged first | `stagesNotBuilt` in the manifest |
| Stage 5 — roll up | consumes stage 4 output | `stagesNotBuilt` in the manifest |
| Incremental re-digest driver | needs two digests to diff; the content-hash keying it rests on is built and tested | criterion 6 partially met — see below |
| Self-contained HTML view | criterion 8; the last piece before the `accept` gate | not started |
| Drift-budget constants | invented; must be measured by a spike before they land | not written into code at all |

## Honest status of the acceptance criteria at the end of build

| # | Criterion | State |
| --- | --- | --- |
| 1 | nested repos found | **met** — tested, and proven on an 8-repo tree |
| 2 | classification honest | **met** — tested, every classification carries its signal |
| 3 | ranking beats length | **met** — tested, and proven on a real repo |
| 4 | extraction exact | **met** — hand-written expectations, exact equality |
| 5 | rollup holds | **not started** — stage 5 |
| 6 | incremental works | **partial** — content-hash keying built and tested; the diff-driven driver is not |
| 7 | cost reported | **met** — reported even when zero |
| 8 | inspectable HTML view | **not started** |
| 9 | runs on an unseen repo | **met** — ran cold on a tree it had never seen, no config |

Five of nine met, one partial, three not started. This ticket does not reach `accept`
until 5, 6 and 8 are done; that is the remaining build work, not a scope change.
