# repo-tour — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->
- Nothing in flight. **T-1, T-5 and T-8 are all complete.** The next move is Evan's.

## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->

- Nothing is held. Every gate was cleared; the three `accept`/`spec_ready` gates that are
  Evan's were spent on his own recorded go-aheads (GA-3, GA-4, GA-5) because he asked not to
  be stopped: *"We can just observe the app and I'll tell you what I want changed
  afterwards."* **He has not yet said what he wants changed.** That is the open loop and it
  is his — a session picking this up should not invent work, it should ask him.

## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->

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
