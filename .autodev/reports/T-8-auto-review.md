# T-8 — auto-review

**Branch:** `t8-pr-in-app` · **2026-08-27**

## Preflight

| check | result |
|---|---|
| `tsc` | clean |
| `npm test` | **99/99** |
| `npm run build` | clean |
| secrets scan over the branch diff | no matches |

## Findings — 4 raised, 4 fixed

Two were found by driving the app, two by reading the new code. All four would have
survived a green test suite.

### 1. The cache never noticed the renderer had changed — **fixed**

Served pages are keyed on the **tree fingerprint alone**. A repository whose code had not
changed kept getting its cached page forever, even after the renderer changed underneath
it. The new tab would have shipped and stayed **invisible** behind a stale page — the exact
failure this ticket exists to fix, reintroduced one layer down.

Now a presentation change re-renders behind the reader and serves the current copy
meanwhile. It costs no tokens: interpretation is cached by content.

### 2. `git diff base..head` is not a pull request — **fixed**

Two-dot diff reports everything the **base** gained as though the branch had deleted it.
PR #3 (two files) arrived as **eleven files with phantom deletions at the top of the tour**.

The file set is now three-dot, from the fork point. `baseSha` keeps its §4 job — the
landing point, staleness, and the overlap stop. Both directions pinned by tests on a
purpose-built fixture repo.

### 3. `gh` ran synchronously inside an HTTP handler — **fixed**

`listPrs` used `execFileSync` for a **network call**. That stops the entire server — every
other repo page, every in-flight build's progress — for as long as GitHub takes. On a slow
or hanging connection the app would simply look dead. Now async, with a 20s timeout and a
distinct "took too long" reason.

### 4. Finished PR tours accumulated without bound — **fixed**

Each rendered tour embeds the source it walks and runs close to a megabyte. A session spent
browsing pull requests grew server memory indefinitely. Bounded to the last 8; an evicted
tour rebuilds for free because every interpretation and verdict behind it is content-cached.

## Reviewed and accepted

- **Route inputs.** `path` is checked against the loaded repo list exactly as `/r` does;
  `n` must be a positive integer. No path reaches disk unvalidated.
- **Job keying.** `<repo>#pr-<n>`, not the repo path — a repo tour and a PR tour cannot
  evict each other.
- **Failure text.** `PrResolutionError` and `NoCheckpointError` messages are shown to the
  reader unchanged; both name a remedy. A stack trace would have been worth less.
- **Self-containment.** The existing no-external-requests assertion still passes.

## To the KB

Finding 1 generalizes and is recorded: a cache keyed on the INPUT must also be keyed on the
CODE that transforms it, or a change to the transformer ships invisibly.
