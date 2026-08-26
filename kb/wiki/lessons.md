---
name: lessons
description: Durable lessons this project has learned — one entry per lesson, newest first, each citing the ticket it came from.
type: reference
---

# lessons

One entry per lesson, newest first, each citing the ticket or incident it came from.

---

## The digest must never digest its own cache (T-1, 2026-08-26)

Found by running the tool twice on its own repository during the `verify` stage — not by
any unit test, because a unit test never runs the tool twice against a root it just wrote
to.

Run 1 writes `.repo-tour/`. Run 2 then walks that directory and inventories ~100 cache
files as brand-new additions. The damage is not cosmetic: the incremental plan reports
fake additions, the reuse percentage is computed against a denominator the tool invented
(79 of 181 files → "44% reused" when the honest answer was 100%), and every parent tier is
marked stale by files that are the tool's own output.

`.repo-tour` is now in `NEVER_DESCEND`, and a regression test runs the digest twice and
asserts 100% reuse with zero additions.

**The general lesson:** any tool that writes into the tree it reads must exclude its own
output, and the bug is invisible to a single run. Verify by running twice.

---

## The import graph does NOT underdeliver on GUTS the way we assumed (T-1, 2026-08-26)

The T-1 spec and handoff both carry a warning that GUTS produces "124 edges across ~1M
lines" because its organs talk over HTTP contracts rather than imports, and that v1 must
not present a thin graph as a complete one.

**The real number is 3,247 edges, from 4,439 resolved imports out of 10,688 — 42%
coverage.** The 124-edge figure came from the throwaway Python probe on 2026-08-25, which
scanned far less of the tree than it appeared to (see the next lesson).

**What to keep and what to drop.** Drop the belief that the graph is nearly empty — it is
not, and design decisions made to compensate for a 124-edge graph would be solving a
problem that does not exist. **Keep the honesty requirement anyway:** 42% coverage means
6,249 imports leave the tree, and cross-service topology is still genuinely missing. The
graph states its own coverage in `digest.json` under `graphCoverage`, and that field
should never be dropped, however good the number gets.

---

## GUTS is roughly 5x larger than the design-session probe reported (T-1, 2026-08-26)

The 2026-08-25 Python probe reported **6 nested repos / 2,505 files / 1.02M LOC**. The
real inventory is **8 repositories / 11,958 files**, including a repo nested two levels
deep (`spine/L4-intent/goms/repos/Handbook-Generator`) that the probe missed entirely.

**Why it matters beyond bookkeeping:** the probe was cited as evidence in the spec's
ranking argument, and it was right about the *shape* of the problem while wrong about its
*size*. Any number inherited from that probe should be re-derived, not quoted. The
structural walk in `src/inventory.ts` is now the source of truth — it registers a repo at
every `.git` it encounters, at any depth, including `.git` files (worktrees/submodules).

---

## Stage 2 is numbered before stage 3 but must RUN after it (T-1, 2026-08-26)

The spec numbers the pipeline inventory → rank → extract, and that ordering is correct as
a *cost* argument: ranking is the cheaper idea, so it reads first.

But one of ranking's three signals is **in-degree**, and in-degree is a product of the
import graph that extraction builds. `digest.ts` therefore calls `extract` before `rank`
while reporting each under its own stage name. If a future change reorders these, ranking
silently loses 35% of its signal and every file scores as if nothing imported it — a
failure that produces plausible output and no error.

---

## Length ranks a repo backwards unless it is normalized AND weighted third (T-1, 2026-08-26)

Two separate mechanisms are required, and having only one is not enough:

1. **Weight LOC third** (churn 0.45, in-degree 0.35, size 0.20).
2. **log1p-normalize before weighting.** Plain max-normalization lets a single 38,367-line
   benchmark dump compress every real file toward zero, so the weights stop mattering.

Proven on GUTS: `manifest.yaml` — 96 lines, 134 commits — ranks **#6 of 11,958**, above
every benchmark file in the tree.

---

## A path segment alone must not classify prose as a test (T-1, 2026-08-26)

The first run of the classifier called `.autodev/specs/T-1-digest-engine.md` a `test`
because a path segment said `specs`, which damps its score by half. A design document in a
`specs/` folder may be the most valuable file in a repo.

**Rule now enforced:** a path segment (`test/`, `spec/`, `__tests__/`) only implies "test"
when the file is in a language a test can be written in. Filename patterns (`test_*.py`,
`*.test.ts`, `conftest.py`) still stand on their own. Caught by running the tool on its own
repo — worth doing after every classifier change.

---

## Churn must be counted in each file's OWN repository (T-1, 2026-08-26)

`git log` at the scan root sees only the parent repo's history. On GUTS that is 336
commits out of 1,701 across all 8 repos. `churnByFile` runs one `git log --name-only` per
discovered repo root and maps results back to scan-root-relative paths. A repo with no
commits yet yields zero churn for its files, which is true rather than an error.
