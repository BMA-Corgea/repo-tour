# T-9 — auto-review

**Branch:** `t9-pr-view` · 2026-08-27

## Preflight

| check | result |
|---|---|
| `tsc` | clean |
| `npm test` | **110/110** |
| `npm run build` | clean |
| secrets scan | no matches |
| invented CSS tokens anywhere in a rendered page | **0** (pinned by test) |

## Findings — 3, all fixed

### 1. The style did not follow through — **fixed**

`prview.ts` invented `--panel`, `--hover`, `--fg` with **dark fallbacks**. No skin defines
them, so on a light theme every one fell back: dark panels and grey-on-cream text dropped
onto Classic. T-8's tab CSS had the same defect.

Rebuilt on the house tokens (`--bg --canvas --ink --muted --line --accent --chip`) and the
house components (`.topbar`, `.layout`, `.panel > h3`, `.filehead`, `.chip`). Every colour
the page introduces is now a token defined for light **and** dark; there is no hardcoded hex
left in the file. A test fails if any of the three invented names reappears.

### 2. The building page hung — **fixed**

Reported by Evan: *"When I stayed on the page constructing the interpretation it hung. I
left and came back and it was instantly done."*

`building()` took one argument and used it as the heading, the polled job key, AND the
destination. The PR route passed a decorated label, so the page polled `/api/job` for a job
stored under `"<repo path> — PR #3"`, matched nothing, read `state:'idle'` and looped
forever. It would also have navigated to `/r` — the repo tour — on completion.

Three parameters now: `label`, `jobKey`, `doneUrl`. Verified live: `done` in ~2s, lands on
the PR tour. Both directions pinned by tests.

### 3. The diff was not syntax-highlighted — **fixed**

A grey diff beside a coloured file browser is the seam that made this read as two products.
`HIGHLIGHTER` is exported from `repoview.ts` and reused rather than duplicated, and the
highlight runs over the whole side at once so block comments and template strings stay
correctly coloured across line boundaries.

## Reviewed and accepted

- **Diff as data, not markup.** The payload carries typed rows and line numbers; the page
  renders them. Nothing user-controlled is interpolated into HTML on the server.
- **`esc()` on every interpolation** in `prview.ts`, including the model-written narrative.
- **Route inputs** unchanged from T-8: `path` checked against loaded repos, `n` a positive
  integer.

## Criteria

All ten met — see the verify report.
