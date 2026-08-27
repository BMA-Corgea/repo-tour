# T-8 — Location report

**Entry point the user takes:** the served repo page → the `Pull requests` tab.

| file | line | what is there now | what it becomes |
|---|---|---|---|
| `src/repoview.ts` | 1000 | `<span class="tab off">Pull requests</span>` — dead | a link to `/prs?path=<repo>`, or a titled inert span when there is no remote |
| `src/server.ts` | 650 | the `/r` route (repo tour) | joined by `/prs` (the list) and `/pr` (one tour) |
| `src/server.ts` | 531 | `startJob()` — one job per repo path | needs a job key that distinguishes a PR tour from a repo tour |
| `src/server.ts` | 1141/1200 | `building()` / `notBuilt()` | reused for PR builds; they already take a label and lines |
| `src/pr.ts` | — | `resolvePr`, `repoSlug` | gains a PR **list** (`gh pr list --json`) |
| `src/cli.ts` | `runPrMode` | the whole PR flow, CLI-shaped | the flow must be callable from the server, so it is extracted |

## The one structural thing

`runPrMode` currently does resolve → checkpoint → sides → adjudicate → tour → **write a file
and print a table**. The server needs everything except the last step. Extract the middle as
`buildPrTour(root, opts) → { html, deltas, refs }` in a module both callers use; the CLI keeps
its printing, the server keeps its serving. No behaviour moves.

## Not touched

The digest engine, the delta, the adjudicator, the narrator. T-8 is wiring, not mechanism.
