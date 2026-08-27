# T-9 — verify

**On merged `main` @ `872a112`** · 2026-08-27 · driven against real PR #3 in a running server.

| check | result |
|---|---|
| `tsc` / `npm test` / `npm run build` | clean / **110 passing** / clean |
| building page polls | `jobKey = "<repo>#pr-3"`, `doneUrl = /pr?…&n=3` — **the fix** |
| the poll settles | `done` in ~2s (was: never) |
| house components on the page | `.topbar`, `.layout`, `.filehead` all present |
| invented tokens in the rendered page | **none** |
| links to the pull request | yes |
| diff reaches the page | `rank.ts` +1 −1, `rollup.ts` +38 −0, both `lang=ts` |
| a stop's opening words | *"The MULTIPLIER table previously weighted test-classified files at 0.5…"* |
| PR-mode temp dirs leaked | 0 |

## Criteria

| # | criterion | status |
|---|---|---|
| 1 | file panel shows only the PR's files | **PASS** |
| 2 | diff on screen, added/removed distinguishable | **PASS** |
| 3 | a stop anchors to a hunk, not line 1 | **PASS** |
| 4 | narration leads with what the PR is doing, from repo context | **PASS** |
| 5 | the score is a chip, not a sentence | **PASS** (test fails if a stop opens with a number) |
| 6 | links to the pull request | **PASS** |
| 7 | ahead/behind out of the default | **PASS** |
| 8 | availability visible (count on the tab) | **PASS** |
| 9 | loading visible | **PASS** — and the hang that made it useless is fixed |
| 10 | no new external requests | **PASS** |

**10 of 10.**

## The one Evan found after acceptance would have shipped

The building page hung. It is worth recording that criterion 9 was *written* before that bug
existed and would have been marked PASS on the markup alone: the page said "reading…", which
is what the criterion asked for. It said it forever. **A criterion about a loading state has
to be tested by waiting for it to finish**, not by checking that the words appear.
