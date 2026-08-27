# T-8 — Build plan

**Branch:** `t8-pr-in-app` · **Delivery:** branch + PR to `main` · **Delegation:** inline, serial
**Ceremony:** proportional — this is wiring over machinery that already works and is tested.

1. **Extract the flow.** `src/prflow.ts` — `runPrTour(root, opts)` returning `{ html, deltas,
   refs, checkpoint }`. `cli.ts` calls it and prints; nothing else changes. Suite must stay green
   before anything new is added.
2. **List PRs.** `listPrs(root)` in `pr.ts` via `gh pr list --json number,title,author,headRefName`.
   Distinguish three outcomes and never collapse them: a list, an empty list, and a failure
   (no `gh`, not authed, no remote) — criterion 7.
3. **Routes.** `/prs?path=` renders the list; `/pr?path=&n=` builds one on a job and serves it.
   Reuse `building()` for an in-flight build (criterion 4). Job key becomes `path` or `path#pr-n`.
4. **The tab.** `repoview.ts` line 1000 becomes a link when a remote exists, an inert span with a
   `title=` reason when it does not (criterion 1).
5. **Prove it.** Tests for the three list outcomes, the route wiring, the no-checkpoint refusal,
   and the existing self-containment assertion. Then drive the real app against real PR #3.

**The rule for this ticket, learned the hard way on T-5:** "renders through the same function"
is not "reachable by a person". The acceptance test is a click, from the app, ending at a tour.
