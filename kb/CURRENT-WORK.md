# repo-tour — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->

- **T-1** (feature) — The digest engine. **COMPLETE and waiting on Evan.** All 9 acceptance
  criteria met. On `main` at github.com/BMA-Corgea/repo-tour, 28 tests green, tour verified
  in real Chromium. Sitting at **uat** — the `accept` gate is Evan's and only he can clear it.
  **Next:** he says yes or sends it back. Nothing else moves until then.


## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->

- **T-1** — waiting at the `accept` gate on `human:owner` (Evan) since 2026-08-26. The
  question that gate asks is not "does it match the spec" but "is this what you actually
  meant, and would you show it to someone?" Nothing is blocked behind it except T-1 itself.

## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->

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
