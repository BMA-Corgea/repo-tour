# T-5 — Build plan

**Stage:** `plan` · **Written:** 2026-08-27 · **Branch:** `t5-pr-mode`
**Reads:** `.autodev/specs/T-5-pr-mode.md` (14 criteria) · `.autodev/reports/T-5-locate.md`

Ordered so each phase is independently verifiable and nothing later depends on a guess
made earlier. Phase 1 is deliberately first: it is the smallest change, it serves both
tour kinds, and it is the part Evan will look at first.

---

## Phase 1 — the two-level explanation (spec §8, criteria 11–14)

Serves the existing repo tour immediately, before any PR code exists. Shippable alone.

1. `src/interpret.ts` — `StopMeaning` gains `summary: string`. Prompt asks for all three
   fields in the same call; `PROMPT_VERSION` 4 → 5 (invalidates the stop cache, correctly).
   Budget the summary at ≤400 chars in the prompt AND clamp defensively on the way out.
2. `applyMeanings` — return `{ ...s, text, summary, interpreted }`. **`text` is computed
   exactly as it is today** — same concatenation, same 1400 clamp. Criterion 12 is a
   byte-identity requirement, so this line must not be "improved" while it is being moved.
3. `src/narrate.ts` (new) — the single place that decides what a stop shows at each level,
   for both tour kinds. Deterministic fallback when a stop was never interpreted: derive a
   summary from the step's own facts rather than showing an empty bubble.
4. `src/codetour.ts` — `CodeStep` gains `summary?`.
5. `src/repoview.ts` — default render is `summary`; a per-step press reveals `text`; a
   global toggle expands all. **The notes panel (`:506`, `:657`) keeps binding to `text`.**
6. Tests: every stop has a summary; no summary > 400 chars; expanded text is byte-identical
   to the pre-change render (snapshot taken before phase 1 lands); both tour builders call
   `narrate`.

**Verify by eye:** `./repo-tour tour` on this repo — stops are tweet-sized, press expands.

## Phase 2 — resolving a PR (criterion 1)

7. `src/pr.ts` (new) — `resolvePr()` → `{ headSha, baseSha, forkSha, prose }`.
   - GitHub path: `gh pr view <n> --json headRefOid,baseRefName,title,body,commits,closingIssuesReferences`
   - ref path: `git rev-parse` + `git merge-base`, no network
   - unresolvable → **refuse**, never guess a base
   - `prose` carries title/body/commit messages/issue refs — §7's only sources for *why*
8. Tests: both paths resolve on this repo; a bad ref refuses.

## Phase 3 — the two sides (spec §4, §6, criteria 2, 7, 10)

9. `src/checkpoint.ts` (new):
   - `loadCheckpoint(root)` — read `.repo-tour/`; report the commit it represents, and how
     far behind `main` (count + whether those commits touch files this PR touches)
   - none present → say so, offer `repo-tour digest .`; `--no-cold` stops
   - `headSide(diffSet, headSha)` — `git show <sha>:<path>` per changed file into a temp
     dir, then extract + interpret **those files only**
   - **the temp dir excludes `.repo-tour/`** (T-1 self-scan rule — criterion 2)
   - the temp dir is removed on every exit path, including throws
10. `src/digest.ts` — manifest records which commit a digest represents.
11. Tests: reuse counts reported and non-zero; `.repo-tour/` never scanned; fork vs landing
    point both reported when they differ (criterion 7).

## Phase 4 — the meaning delta (spec §2, §5, criteria 3, 4, 5, 6)

The heart of the ticket, and where the primary risk sits.

12. `src/delta.ts` (new):
    - per-stop comparison of `{ what, why }` between checkpoint and head
    - **compare on extracted assertions, not raw prose similarity** (risk §10) — normalise,
      then compare claim sets, so rewording scores near zero and a changed claim scores high
    - public-surface change per file (exported symbols added/removed/changed)
    - `ripple()` — direct importers of anything whose meaning moved get re-interpreted;
      further hops collected structurally and **labelled not-re-interpreted** (criterion 6)
    - `score()` — the ordering criterion 3 checks
13. Tests: criterion 4 (pure refactor → near-zero delta) and criterion 5 (small semantic
    change outranks large cosmetic one) built as **fixture repos with real git history**,
    the way T-1's suite does it. These two are the ticket's proof; if 4 fails, §2's claim
    is wrong and that is a finding, not a bug to paper over.

## Phase 5 — the PR tour (criteria 3, 8, 9, 13)

14. `src/prtour.ts` (new) — project a delta into `CodeStep[]`, ordered by meaning delta.
    Both numbers (lines changed, meaning delta) on every stop so the order is arguable.
    `MEANING MOVED` belongs in the **summary**, never behind the press (criterion 13).
15. §7 discipline: every *why* claim carries its source inline (PR body / commit / issue);
    no source → the stop says the author recorded no reason. No unsourced motive claims.
16. `src/cli.ts` + `repo-tour` (bash) — the `pr` subcommand, `--base`/`--head`/`--no-cold`,
    and `--help`. Renders through `renderRepoView` — same surface (criterion 9).

## Phase 6 — prove it

17. Full suite green (64 existing + new), `tsc` clean.
18. Run it for real: a PR tour of an actual PR on this repo, and a repo tour, both opened
    in a browser and driven end to end. Real defects found here go back to the phase that
    owns them.

---

## Standing rules for this build

- **Criterion 12 is a byte-identity test.** Do not tidy the existing narration while moving
  it. Snapshot before phase 1 touches anything.
- **The temp dir is not the working tree.** Nothing in this ticket may check out, stash, or
  switch what the user has open.
- **`.repo-tour/` is excluded from every scan this ticket introduces.** T-1's defect was
  invisible on a single run; it will be invisible here too.
- **Honest gaps stay honest.** Where a *why* has no source, say so. Where the ripple stops,
  say where it stopped. Neither is papered over to make a nicer page.

---

## Delivery target

`github.com/BMA-Corgea/repo-tour` exists and `main` tracks it, so the delivery target is a
**branch pushed to the remote with a PR opened against `main`** — not a local-only branch.

Branch: **`t5-pr-mode`** (created 2026-08-27 off `main` @ `1783b85`).

There is a pleasing property here worth stating: **T-5's own PR is the first fixture.**
The ticket that teaches repo-tour to tour a pull request produces one, against a repo that
already has a checkpoint on disk. Phase 6 tours it.

## Delegation shape

**Inline, serial — no subagents, no worktrees.**

The phases are a dependency chain, not independent pieces: phase 3 needs phase 2's commit
pair, phase 4 needs phase 3's two sides, phase 5 needs phase 4's delta. Fanning out a chain
buys nothing and costs the context that makes each phase's decisions consistent with the
last. Phase 1 is the one genuinely separable piece, and it is small enough that spawning
for it would cost more than it saves.

Isolation is by **feature branch**, which is sufficient: the changes are additive
(five new modules) plus surgical edits to four existing ones, and no parallel writer exists
to conflict with.

## Rework posture

Criterion 4 is the one that can fail *honestly* — if the meaning comparison cannot
distinguish rewording from meaning-change, spec §2's central claim is wrong. That outcome
is a **finding to report, not a bug to hide**: it goes back through the ticket as a stall
with the measurement attached, not papered over with a looser threshold.
