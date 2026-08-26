---
name: lessons
description: Durable lessons this project has learned — one entry per lesson, newest first, each citing the ticket it came from.
type: reference
---

# lessons

One entry per lesson, newest first, each citing the ticket or incident it came from.

---

## Stage 4 is the product, and there is no template that substitutes for it (T-1, 2026-08-26)

Shown a tour stop on `main` that read *"A function at line 71. 95 lines. It is private to
cli.ts, so it can be changed in place."*, Evan said: **"that sure is saying very little
about how it works. We've explained nothing and we move on after this step."**

The instinct was to enrich the template — pull call graphs and control flow off the AST and
write a fuller sentence. That would have produced *"it parses argv, guards on the command,
calls digest(), then branches on --json"*: a narration of syntax the reader can already
see. **The "why" is not in the syntax, so no template can reach it.** Docstrings help only
where an author happened to write one; `main` had none.

Stage 4 — a model reading the actual source — is not an optimisation of the deterministic
path. It is the thing the other four stages exist to make affordable. On autoSQL it is
**5 calls and about $0.38** for a 14-stop tour, because stages 1-3 narrowed 365 files to 5.
Cached by content hash, so it is paid once.

**Rule:** when narration is thin, the answer is to interpret, not to template harder.

---

## Fit the container to the explanation, not the explanation to the container (T-1, 2026-08-26)

Stage 4's first answers were good and too long for the coachmark bubble, so the prompt was
told to "BE SHORT" — capping the explanation at 40 words to fit the UI.

Evan reversed it: **"We might need to readjust how we portray information so that we can
have longer explanations. I'm thinking like a textbook paragraph's worth of information."**

He was right, and the mistake was structural: a floating spotlight bubble is a UI for
*"click this button"* tooltips, not for teaching someone a codebase. Shrinking the teaching
to fit the tooltip was optimising the wrong side of the equation.

The guide is now a **docked third column** — tree, code, guide — sized for a real
paragraph. Explanations run 95-192 words, and the browser test asserts none of them is
clipped by the panel. The floating-bubble engine was dropped from this surface entirely;
the highlighted lines are the spotlight, so the dim overlay was never needed.

---

## I built the machinery's UI instead of the product's UI (T-1, 2026-08-26)

The first demo was a dashboard of score, churn, in-degree, LOC and classification, with a
tour that walked a viewer through *the dashboard*. Evan's verdict: **"There's no code on
the screen... This is nothing like the github repo format we were looking to recreate...
I need to know almost nothing about the score, churn, in LOG, class, or lang."**

He was right on every point, and the mistake is worth naming precisely because it is easy
to repeat.

**The metrics are how the engine DECIDES what to show you. They are not what a reader
wants to see.** They are load-bearing and they should be invisible — under the floor,
like a query planner. Putting them on screen and calling it a tour is showing someone the
scoring rubric instead of the thing being scored.

There was a second, compounding error: the demo was run against *repo-tour itself*. A
tool that reads repositories should never be demoed on its own source. The reader has no
stake in it, and it proves nothing about the hard case.

**The rule now:** the product surface is the repo — file tree, real source, line numbers,
a guide pointing at lines. Anything a reader would not care about belongs in
`repo-tour inspect`, which exists to judge digest QUALITY and is a different job.

---

## The author already wrote the "why" — read it before spending a token (T-1, 2026-08-26)

Deterministic narration can say what a function IS, how long it is, and who calls it. It
cannot say why it exists. That gap looked like it needed stage 4 (the paid stage).

It mostly does not. **Docstrings and leading comment blocks are the author explaining
their own code, and extracting them is free.** On autoSQL, 7 of 14 tour stops now quote
the author directly, including sentences no metric could ever produce: *"One pick → the
whole response body. Separated from the route so the suite drives the same code the
screen does, with no HTTP."*

Two consequences, both live in `src/codetour.ts`:

1. A stop's narration LEADS with the author's words when they exist.
2. Symbol selection **prefers documented symbols**. A documented 20-line function is a
   better stop than an undocumented 200-line one, because the reader leaves it knowing
   something.

Stage 4's job shrinks accordingly: it is for the code nobody explained, and for the
cross-file "why" no single docstring can carry.

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
