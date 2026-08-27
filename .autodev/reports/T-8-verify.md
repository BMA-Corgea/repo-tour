# T-8 — verify

**On merged `main` @ `0a29fe6`** · 2026-08-27

## Suites

| check | result |
|---|---|
| `tsc` | clean |
| `npm test` | **99/99** |
| `npm run build` | clean |

## The acceptance test is a click, from the app

Driven against a real running server on merged `main`, with real PR #3.

| step | result |
|---|---|
| 1 — the repo page's tab | `<a class="tab off live" href="/prs?path=…">Pull requests</a>` — live after a ~3s background re-render |
| 2 — clicking it | HTTP 200, lists **#3** with title, author `BMA-Corgea`, branch `demo-ranking-tweak` |
| 3 — clicking the PR | building page → tour, settled in ~8s, **4 stops** |
| 4 — PR-mode temp dirs left in /tmp | **0** |

The tour it produced, at the default level:

> *2 files changed. 1 moved in meaning, 1 did not. The biggest diff is rollup.ts; the biggest
> change of meaning is rank.ts.*
>
> *MEANING MOVED · 0.60 · 2 lines. MULTIPLIER.test drops from 0.5 to 0.05, pushing test files
> far down the rank score.*
>
> *Meaning steady · 0.00 · 38 lines. Adds a 30-line repetitive JSDoc comment block above
> `TierKind`; no code, types, or logic change.*
>
> *2 files import something whose meaning moved, without changing a character. 15 more sit
> beyond that and were NOT re-interpreted.*

## Criteria

| # | criterion | status |
|---|---|---|
| 1 | tab live with a remote; inert **with a stated reason** without one | **PASS** (both branches unit-tested) |
| 2 | lists number, title, author, branch | **PASS** |
| 3 | clicking builds and serves inside the app | **PASS** |
| 4 | a build in progress shows the building page | **PASS** (observed on the first request) |
| 5 | no checkpoint refused honestly | **PASS** (`NoCheckpointError` surfaced verbatim on the failure page) |
| 6 | no new external requests | **PASS** (existing assertion still green) |
| 7 | `gh` absent/unauthenticated is a stated reason, not an empty list | **PASS** (three distinct outcomes, unit-tested) |

**7 of 7.**

## Defect found at verify — 1, fixed

**The test suite was littering `/tmp`.** Twenty directories had accumulated, each containing
a `.repo-tour/` cache and **no source**. That shape was the diagnosis: a test removed its
fixture while a resumed background build was still running, and the build wrote the cache
back into the path that had just been deleted.

Pre-existing, not introduced by T-8 — but found by counting what was actually in `/tmp`
rather than trusting that a green suite meant a clean one, and fixed here because leaving
litter is the same fault T-8 already fixed twice in production code. A full suite run now
leaves **zero**.

## Note on scope

Three of the four review findings (the stale cache, the two-dot diff, the synchronous `gh`)
were **not** in T-8's spec. They were found by driving the feature and each would have made
it ship broken or invisible. They are recorded in the auto-review report rather than filed
as separate tickets, because none of them is separable from "the tab works".
