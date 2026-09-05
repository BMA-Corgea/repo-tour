# repo-tour — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->

  package (`exports` map, injectable asset roots, a `prepare` build) so
  `VSCode-LLM-Tutorial`'s extension can `import()` it as a `file:` dependency (that repo's
  T-1 spec, §3/§10). 6 commits on `feature/T-11-core-package` in worktree `../repo-tour-T-11`,
  not pushed/merged; full details and per-AC verification in `.autodev/handoffs/T-11.md`.
  **T-12** (the build-order engine this package's `./build` export will point at) is running
  in parallel in
  `../repo-tour-T-12` on disjoint files. Five of the six pieces Evan described on day one are
  shipped; the one left besides these is **T-7, GONS integration** — always the endgame
  rather than the product.
  VSCode-LLM-Tutorial ticket set's order). `src/build/{types,witness,plan,stub,check,index}.ts`:
  digest → `BuildPlan`, the ordered decision list the VS Code extension walks a learner
  through. All 9 acceptance criteria met, each with its own test in `test/build.test.ts`;
  `repo-tour plan <path> [--json]` wired into the CLI. The auto-review returned **REWORK**
  on four reproduced defects (step-id collisions, `data` files dropped from the plan,
  one-line Python stubs that real Python rejects, a null witness on a rename); all four are
  fixed on the branch, each with a test that fails when the fix is reverted — 167 tests
  green. Why it exists: repo-tour's own
  digest/architecture/extract/git-history stages already contain everything a "how was
  this built, in order" projection needs — this ticket is that projection, computed the
  way `src/tour.ts` computes a tour, never a separate hand-written artifact. Next: T-13
  (interpret: alternatives per step) reads this module's output and does not need to
  change its ordering or step shape. Full detail: `.autodev/handoffs/T-12.md`.
- Nothing else in flight here. **Five of the six pieces Evan described on day one are shipped.**
  The one left is **T-7, GONS integration** — always the endgame rather than the product.
- **The GONS side is now open on the OTHER shop.** 2026-08-27, on Evan's instruction, GUTS
  ticket **T-55** was filed ("Bring repo-tour's PR tours into the GONS Office PR section")
  with a first-hand brief at `GUTS/.autodev/handoffs/T-55.md`, and the live `guts-bridge`
  session was messaged. Its `spec_ready` was deliberately NOT cleared: how it lands in the
  Office is GUTS's decision. **repo-tour's T-7 is the counterpart and is still unopened** —
  open it when GUTS says what it needs, not before.
- **T-14** (techdebt) — Harden T-11's consumer tests: prove prepare rebuilds dist, and make alternateCs… — intake
- **T-13** (feature) — Interpret the decisions — alternatives per build step, and Ask context for a st… — auto-review
- **T-15** (bug) — Script-style JS yields no load-bearing ranges: IIFE bodies are invisible to ext… — gate
- **T-16** (feature) — Module-pattern and .call(this) IIFEs: record their body declarations too — intake

## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->

- Nothing is held. Every gate that is Evan's was spent on his own recorded go-aheads
  (GA-3 through GA-7) because he asked not to be stopped mid-flight. **The open loop is his
  read of the notes + Ask panels**, which he has not used yet at the time of writing.
- **T-13** — waiting at spec_ready on human:owner since 2026-09-05
- **T-15** — waiting at spec_ready on human:owner since 2026-09-05

## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->

- 2026-09-05 **T-12 COMPLETE** — The build-order engine — digest → BuildPlan, and the structural check
- 2026-09-04 **T-11 COMPLETE** — Expose the core as a consumable package — for the VS Code front end
- 2026-09-04 **T-10 CLOSED duplicate** — Tutor chat during a tour — context-aware Q&A on the current step
- **2026-08-27** — **T-3 COMPLETE**, the oldest ask on the project: notes carrying which stop
  inspired them, and an assistant that reads them. Why it took until now: it was deferred at
  every gate since the first spec on the reasoning that a tour has to be worth taking notes
  on before notes are worth having. A note records the NARRATIVE that was on screen, not just
  the location — that is what makes it readable a week later.
- **2026-08-27** — The Ask panel follows sql-gauntlet's tutor, which Evan pointed at: a
  persona plus a labelled context block, over the local `claude` CLI. Why labelled: the notes
  are the human's and the meaning is the machine's, and an answer confusing the two would be
  worse than none. Asked about `src/server.ts` from a summary alone, it named "loosen the
  fingerprint check → serve stale pages" as a risk — which is exactly the T-8 defect.

- 2026-08-27 **T-3 COMPLETE** — Notes with provenance on a PR, and an AI that reads them
- **2026-08-27** — **T-9 COMPLETE.** A real PR page: the PR's own files, the diff on screen
  and syntax-highlighted, a link out to GitHub, and narration that says what the PR is doing
  rather than reciting its score. Why the rebuild: the tour had been rendered through
  `renderRepoView`, so it WAS the repo page — one decision that caused five of the six faults
  Evan listed.
- **2026-08-27** — The stop text had been opening with `MEANING MOVED · 0.60 · 2 lines`.
  Why that matters more than the others: it is the same failure as the metrics demo rejected
  on 2026-08-26, whose lesson was already in `kb/wiki/lessons.md`. Now enforced by a test
  that fails if a stop opens with a number — prose in a wiki did not hold.
- **2026-08-27** — The style did not follow through: `prview.ts` invented `--panel`,
  `--hover`, `--fg` with DARK fallbacks, so a light skin got dark panels and grey-on-cream
  text. Rebuilt on house tokens; a test fails if any of the three reappears.
- **2026-08-27** — The building page hung while you watched it. Why: `building()` used one
  argument as heading, polled job key AND destination, so a PR build polled a decorated
  label, never resolved, and would have navigated to the repo tour anyway.

- 2026-08-27 **T-9 COMPLETE** — A real PR view: the diff on screen, and narration about the change not the score
- **2026-08-27** — **T-8 COMPLETE.** The app's "Pull requests" tab was a decorative span and
  PR mode only ran from the CLI, so Evan clicked it and nothing happened. Why it slipped
  through T-5: criterion 9 was verified by checking the PR tour renders through the same
  function, which is not the same as being reachable by a person. Three of the four defects
  found here were invisible to a green suite — a cache in front of the renderer (no test ran
  the server), a two-dot PR diff that reported the base's new files as deletions (every test
  built both sides by hand), and `gh` blocking the event loop (no test made a request).
- **2026-08-27** — The test suite was leaving 20 directories in `/tmp`, each holding a digest
  cache and no source. Why that shape: a test deleted its fixture while a resumed background
  build was still running, and the build wrote the cache back into the deleted path. Zero now.
- **2026-08-27** — **T-5 COMPLETE.** PR mode: a pull request toured by how far its *meaning*
  moved, not how many lines changed. Also two-level narration for both tour kinds — a
  tweet-sized summary by default, full text one press away. Why: every stop was an 80–140
  word paragraph, and skimming thirty to find the two that matter is the overwhelm Evan
  described.
- **2026-08-27** — T-5's central comparison was rebuilt mid-build after it failed on real
  code. Why: diffing two free-prose interpretations scored a pure local-variable rename at
  0.47 "meaning moved" — the model had written a *different essay* about the same code, ~50%
  overlap. Free prose is not stable enough to diff. `adjudicate.ts` asks the model the
  question directly; the same fixture then scored 0.00.
- **2026-08-27** — **T-1 COMPLETE.** Accepted by Evan (GA-3), then release and monitor, both
  recorded honestly rather than faked green: there is no production service, so "released"
  means the tool builds and runs from a clean `main` — verified live.

- **2026-08-26** — Product surface rebuilt on Evan's rejection of the metrics demo. Why it
  went wrong: the ranking signals are how the engine picks what to show, not what a reader
  wants; putting them on screen showed the rubric instead of the repo. Now: repo page with
  real code, tour anchored to line ranges, narration leading with the author's own
  docstrings (7 of 14 stops on autoSQL quote the author directly).
- **2026-08-26** — T-1 completed through verify: stage 5 rollup, incremental re-digest, and
  a generated tour. Why the tour is here and not deferred: Evan asked to see a demo, and a
  tour is a projection of the digest, so it cost a renderer rather than a new subsystem.
- **2026-08-26** — verify found a defect no unit test could: the digest was scanning its own
  `.repo-tour/` cache on a second run, inventing ~100 additions and a false 44% reuse figure.
  Fixed and pinned. The general rule now recorded: a tool that writes into the tree it reads
  must exclude its own output, and one run will never show you the bug.
- **2026-08-26** — Wired to github.com/BMA-Corgea/repo-tour; `main` is the default branch.
- **2026-08-26** — Criterion 8 built: self-contained HTML digest view (`src/view.ts`).
  Why: criteria 1–7 prove the machinery, but only a human reading a page can judge whether
  the digest is any good. Self-containment is enforced by test, not intent.
- **2026-08-26** — auto-review finding fixed, not waived: `inventory()` read whole files
  into memory to hash them. Why it mattered: large repos are the entire target. Now
  chunk-hashed; verified identical output on GUTS.
- **2026-08-26** — Stages 1–3 built (inventory, extract, rank) in Node + TypeScript.
  Why this shape: ordering is the cost-control mechanism — every free, exact stage runs
  first so the paid stage only ever reads what survived.
- **2026-08-26** — Language decided: **Node + TypeScript** with `web-tree-sitter`, by Evan.
  Why: the engine and the tour UI talk constantly; Python would put a serialization seam
  through the middle of the product. Cost accepted: the only non-Python repo in the estate.
- **2026-08-26** — Onboarding closed out (3 of 4 goals; `about` left open by choice).
  Why it looked unstarted: session 1 captured every answer into the transcript but never
  marked the steps, so the board read 0/4 when it was really 3/4.
- **2026-08-25** — T-1 spec approved by Evan (GA-1), `spec_ready` cleared.

## Reference table (where the past lives)

| Looking for... | Where |
| --- | --- |
| Any ticket's full journey | its ticket file (by id/slug) and its handoff in `.autodev/handoffs/` |
| The event-by-event record | `events.jsonl` (append-only, forever) |
| Durable lessons and decisions | `kb/wiki/` |
| What the code looks like now | `kb/CODE-MAP.md` |
| Why the language is Node | `kb/wiki/decision-implementation-language.md` |
| What T-1's build actually proved | `.autodev/reports/T-1-plan.md` (per-criterion status) |
