# T-5 — verify

**Stage:** `verify` · **2026-08-27** · on merged `main` @ `0b9bf50`
**Landed as:** PR #1 (`eef16f8`) + PR #2 (`0b9bf50`, verify fixes)

## Suites

| check | result |
|---|---|
| `tsc -p tsconfig.json` | clean |
| `npm test` (vitest) | **93/93 passing** |
| `npm run build` | clean |

## End-to-end, on real branches

Each fixture is a real branch off `main` @ `eef16f8` containing **exactly one thing**.

> **A first round of these was invalid and is recorded here rather than quietly re-run.**
> The fixtures were originally cut from the *pre-merge* `main`, so once T-5 landed,
> comparing them against `main` diffed the whole of T-5 back out — a 15-stop tour of
> "revert the feature and rename some variables", not a test of anything. Rebuilt off
> `eef16f8`. The lesson is that a fixture pinned to a moving ref stops testing what it
> was written to test the moment the ref moves.

### Criterion 4 — a pure refactor reports near-zero meaning change

`fx-refactor`: five local variables renamed in `churnByFile`. No exports, no imports, no
behaviour.

```
meaning  lines  band     basis        path
0.00     16     steady   adjudicated  src/rank.ts
```

The stop names the actual renames: *"churnByFile renames local variables
(out→gitLogOutput, prefix→pathPrefix, line→rawLine, rel→relativePath, scanPath→scanRootPath)
with no logic change."* **PASS.**

### Criterion 5 / 3 — a small semantic change outranks a large cosmetic one

`fx-mixed`: 37 lines of documentation on `rollup.ts`, and one line taking the test
multiplier from 0.5 to 0.05 in `rank.ts`.

```
meaning  lines  band     basis        path
0.60     2      moved    adjudicated  src/rank.ts
0.05     37     steady   adjudicated  src/rollup.ts
```

**This is the product in four numbers.** GitHub sorts this PR with `rollup.ts` on top — it
is eighteen times the diff. The tour puts `rank.ts` on top and says so in its opening line.
**PASS**, and criterion 3 with it: the ordering is demonstrably not the diff's ordering.

### Rename regression (the review finding)

`fx-rename`: `skins.ts` → `themes.ts`, plus two import lines.

```
0.05     2      steady   adjudicated  src/repoview.ts
0.05     2      steady   adjudicated  src/server.ts
0.00     0      steady   adjudicated  src/themes.ts
```

Was **1.00 "MEANING MOVED"** before the fix. **PASS.**

### Criterion 1 — it refuses rather than guessing

```
repo-tour pr: cannot resolve base "nope-does-not-exist" in this repository.
  A tour built on a guessed base explains the wrong diff, so this stops here.
  Try: git rev-parse nope-does-not-exist    (and fetch first if it lives on the remote)

repo-tour pr: refusing a base that starts with "-": --upload-pack=x
```

**PASS**, both the unresolvable ref and the argument-injection shape.

### Criterion 10 — no checkpoint is told the truth

```
repo-tour pr: no digest on disk for this repository (looked in .repo-tour).
  PR mode compares a change against the interpretation you already have, so there
  has to be one. Run:  repo-tour digest .
  (--no-cold suppresses this message and exits quietly.)
```

**PASS.** It never digests a repository the reader did not ask it to.

### Criterion 9 / GitHub path

`repo-tour pr 1` toured **its own pull request** through `gh`: 14 stops, rendered in the
same GitHub-shaped page as a repo tour. That run is also what surfaced the `gh` field
incompatibility — `closingIssuesReferences` does not exist in gh 2.45, and one unknown
`--json` field fails the whole call. Every unit test used the `--base/--head` path, so only
running it against a real PR could have found it.

### Housekeeping

Temp directories left in `/tmp` after the full run: **0**.

## Defects found at verify — 2, both fixed and regression-tested (PR #2)

1. **A killed run littered.** A tour interrupted mid-model-call left its temp tree behind:
   `try/finally` covers a throw, not a Ctrl-C or a timeout kill. Now disposed on `exit`,
   `SIGINT` and `SIGTERM`.
2. **An identifier was re-cased into a symbol that does not exist.** The expanded stop text
   capitalised the first letter of the reason, turning `churnByFile` into `ChurnByFile`. In
   a tool whose whole claim is precision about code, that is worse than an uncapitalised
   sentence. Prose is still capitalised; anything that looks like code is left alone.

## Criteria status

| # | criterion | status |
|---|---|---|
| 1 | a PR resolves to a commit pair; refuses rather than guessing | **PASS** (e2e) |
| 2 | the checkpoint is reused, not rebuilt; `.repo-tour/` excluded | **PASS** (asserted in `sideAt`; reuse counts reported) |
| 3 | meaning-delta ordering differs from line-count ordering | **PASS** (e2e + unit) |
| 4 | a pure refactor reports near-zero meaning change | **PASS** (e2e + unit) |
| 5 | a small semantic change outranks a large cosmetic one | **PASS** (e2e + unit) |
| 6 | the ripple is computed, bounded and labelled | **PASS** (unit; reported on every run) |
| 7 | fork point and landing point both honest | **PASS** (reported when they differ) |
| 8 | every why is sourced or admitted | **PASS** (unit; seen live) |
| 9 | it plays in the existing surface | **PASS** (toured its own PR) |
| 10 | no checkpoint is told the truth | **PASS** (e2e) |
| 11 | every stop is tweet-sized by default | **PASS** (unit, measured on full tours) |
| 12 | expanding restores the original byte-for-byte | **PASS** (unit pins the formula) |
| 13 | the meaning signal survives compression | **PASS** (unit) |
| 14 | one narration builder, both surfaces | **PASS** (unit) |

**14 of 14.**

## Standing limitation, stated not hidden

The deterministic claim comparison mis-scores an aggressive re-wording at **0.167** worst
measured. It is no longer the primary signal — the adjudicator is — and runs only under
`--no-interpret` and as a second opinion. Every delta carries a `basis` so a reader can see
which produced the number.
