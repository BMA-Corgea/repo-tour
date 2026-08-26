# repo-tour — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->
- **T-1** (feature) — The digest engine: deterministic extraction with rollup and incremental re-dige… — plan


## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->
- **T-1** — waiting at spec_ready on human:owner since 2026-08-26


## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->

- (nothing completed yet)

## Reference table (where the past lives)

| Looking for... | Where |
| --- | --- |
| Any ticket's full journey | its ticket file (by id/slug) and its handoff in `.autodev/handoffs/` |
| The event-by-event record | `events.jsonl` (append-only, forever) |
| Durable lessons and decisions | `kb/wiki/` |
| What the code looks like now | `kb/CODE-MAP.md` |
