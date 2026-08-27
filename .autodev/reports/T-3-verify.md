# T-3 — verify

**On merged `main` @ `1eb0cd0`** · 2026-08-27 · driven live against real PR #3 and the repo tour.

| check | result |
|---|---|
| `tsc` / `npm test` / `npm run build` | clean / **118 passing** / clean |
| Notes + Ask panes on the PR page | present, notes key `repotour:notes:repo-tour#pr-3` |
| Ask pane on the repo tour | present, key `repotour:notes:repo-tour` (no PR suffix) |
| the assistant's context on the PR page | PR, file, diff, digest's reading, importers, notes |
| the assistant's context on the repo tour | file, digest's reading, importers, current stop |
| `/api/ask` failure paths | `invalid JSON`, `ask something first`, provider's own error text |

## Criteria

| # | criterion | status |
|---|---|---|
| 1 | notes panel on the PR page | **PASS** |
| 2 | provenance on the note, not implied | **PASS** — file, lines, stop, narrative, commit, quote |
| 3 | notes survive a rebuild | **PASS** — keyed per repo+PR, not per commit |
| 4 | export as Markdown and JSON | **PASS** |
| 5 | Ask on both surfaces | **PASS** |
| 6 | the AI is given real context, notes included | **PASS** |
| 7 | it answers about the notes | **PASS** — see below |
| 8 | runs on the existing provider registry | **PASS** — `claude` / `claude-sonnet-5`, no API key |
| 9 | honest when it cannot help | **PASS** |
| 10 | no new external requests | **PASS** |

**10 of 10.**

## Criterion 7, verbatim

One note attached to PR #3 reading *"0.05 feels too aggressive — on a repo that is mostly
tests, won't this hide the only code there is?"*. Asked *"What have I flagged so far, and do
you agree with my concern?"*:

> You've flagged one thing: the note on `rank.ts:24`, about the `test` weight dropping from
> 0.5 to 0.05. Your concern holds up. This multiplier is applied uniformly regardless of the
> repo's composition — nothing in what I can see suggests it adjusts based on how much of the
> repo is test code… **I can't tell from the diff alone how severe this is in practice** —
> that depends on how MULTIPLIER interacts with the other factors and what threshold
> `digest.ts` uses.

It cites the note by location, grounds its agreement in what it was handed, names the
interacting factors it was told about, and states its own limit.

## Criterion 9, verbatim

On the repo tour, asked about `src/server.ts` with only the digest's summary available:

> **I don't have the actual body of `src/server.ts` in front of me, just this summary** — so
> I can't tell you exactly what the fingerprint hashes or where the in-memory cache is keyed.

Worth recording: in the same answer it named *"loosen or drop the fingerprint check →
refreshes start serving stale pages"* as a failure mode to watch. That is **exactly the T-8
defect**, derived from a prose summary rather than the code.
