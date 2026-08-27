# repo-tour — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->

  how many lines changed. Built, reviewed, **merged to `main` as `eef16f8`** (PR #1).
  91 tests green. At **verify**, then Evan's `accept` gate.
  `repo-tour pr <n>` — or `--base <ref> --head <ref>`, which needs no network.
  **Next:** verify evidence, then show him the running thing.

## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->

  stopped again mid-flight (GA-4, 2026-08-27): *"We can just observe the app and I'll tell
  you what I want changed afterwards."* So that gate is a SHOW, not a question.
  The descope still standing: T-5 makes a PR *readable*, not *reviewable* — the notes panel
  that turns a tour into a filable review is still **T-3**.

## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->

- 2026-08-27 **T-8 COMPLETE** — PR mode in the app: make the Pull requests tab live
- 2026-08-27 **T-5 COMPLETE** — PR mode: tour a pull request by diffing its interpretation against the checkpoi…
- **2026-08-27** — **T-1 COMPLETE.** Accepted by Evan (GA-3), then release and monitor.
  Both recorded honestly rather than faked green: there is no production service to deploy
  to, so "released" means the tool builds and runs from a clean `main` — verified live.
  BOTH tour kinds: a tweet-sized summary by default, the full text one press away. Why:
  every stop was an 80–140 word paragraph, and skimming thirty of them to find the two that
  mattered is the overwhelm Evan described.
- **2026-08-27** — The central comparison was rebuilt mid-build after it failed on real
  code. Why: diffing two free-prose interpretations scored a pure local-variable rename at
  0.47 "meaning moved". The model had not paraphrased itself — it wrote a *different essay*
  about the same code, ~50% overlap. Free prose is not stable enough to diff. `adjudicate.ts`
  asks the model the question directly instead, and the same fixture scores 0.00.
- **2026-08-27** — Review caught a rename scoring 1.00 with **zero** lines changed. Why: the
  base side was read at the new path, so every symbol looked newly added. The general rule
  is in `kb/wiki/lessons.md` — file identity comes from git's rename detection, never from
  matching path strings.

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
