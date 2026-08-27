# T-5 — Location report

**Stage:** `locate` · **Written:** 2026-08-27 · **By:** agent:pm
**Purpose:** name every file, entry point and call path this ticket touches, so `build`
never has to re-explore the repo.

Unlike T-1 this is **not** greenfield: the digest engine, the interpret stage and the tour
player all exist and are load-bearing. Most of T-5 is composition. Two findings below
change the shape of the build and are the reason this report is worth reading before the
plan.

---

## Finding 1 — the summary is one new field, not a refactor of the existing text

**Corrected 2026-08-27** after Evan rejected the first reading of spec §8.

`src/interpret.ts:35` models a stop's meaning as `{ what, why }`, and `applyMeanings`
(`:318`) concatenates them and clamps to 1400 characters; `src/repoview.ts:754` renders
that string.

The first version of this report proposed splitting those two fields across the two
disclosure levels. **That was wrong** — it is a selection, not a summary, and it hides the
`why` exactly when the `why` is the point.

What the build actually does: `StopMeaning` grows a **third** field, `summary`, produced in
the same model call. The existing concatenation and clamp **stay exactly as they are** and
become the expanded view — criterion 12 requires the expanded text to be byte-identical to
what the tour renders today. `PROMPT_VERSION` (`:31`) bumps 4 → 5, which correctly
invalidates the stop cache.

So the render change is: default to `summary`, put today's string behind a press. The notes
panel reads `step.text` at `repoview.ts:506` and `:657` and must keep binding to the
**full** text, not the summary — a note captured against a compressed blurb loses the
provenance that makes T-3 worth building.

## Finding 2 — content-keyed caching makes the meaning delta cheaper and less noisy than the spec feared

`stopKey` (`src/interpret.ts:80`) keys a stop's identity by **file content hash + line
range + prompt version** — "same code, same answer, wherever it lives."

Consequence for §2: when a file is unchanged between checkpoint and head, its stops hit the
cache and are **never re-interpreted**. They therefore cannot drift in wording. The meaning
delta only spends tokens — and only risks noise — where content actually moved.

This materially reduces **risk §10**, the ticket's stated primary risk (that a model
re-wording itself would swamp the signal). It does not eliminate it: files that *did*
change are genuinely re-read, and criterion 4 (a pure refactor must report near-zero
meaning change) still has to prove the comparison can tell rewording from meaning-change on
those. But the blast radius of the risk is the diff, not the repo.

---

## Entry points

| Entry point | File | Reached by |
| --- | --- | --- |
| `repo-tour pr <n>` | `repo-tour` (bash dispatch) → `src/cli.ts` | criteria 1, 10 |
| `repo-tour pr --base <ref> --head <ref>` | same, network-free path | criterion 1 |
| `resolvePr(opts)` | **new** `src/pr.ts` | the CLI |
| `loadCheckpoint(repo)` | **new** `src/checkpoint.ts` | PR mode, the free side |
| `headSide(diffSet, sha)` | **new** `src/checkpoint.ts` | PR mode, the computed side |
| `meaningDelta(base, head)` | **new** `src/delta.ts` | the PR tour builder |
| `buildPrTour(delta, …)` | **new** `src/prtour.ts` | the CLI, the renderer |
| `narrate(step, level)` | **new** `src/narrate.ts` | **both** tour kinds (criterion 14) |

## Target files and what each owns

### New

| File | Owns |
| --- | --- |
| `src/pr.ts` | resolving a PR to a commit pair. `gh pr view --json` on the GitHub path; `git rev-parse` / `merge-base` on the ref path. Refuses rather than guessing a base (criterion 1). Also carries the human prose — title, body, commit messages, linked issues — that §7 needs |
| `src/checkpoint.ts` | loading the on-disk digest as the checkpoint, reporting which commit it represents and how far behind `main` it is (spec §4 staleness) |
| `src/delta.ts` | comparing two digests: per-file meaning delta, per-tier delta, public-surface change, and the one-hop ripple set (spec §5). Owns the delta *score* that criterion 3 orders by |
| `src/prtour.ts` | projecting a delta into `CodeStep[]`, ordered by meaning delta rather than diff order |
| `src/narrate.ts` | the two-level narration builder, shared by `codetour.ts` and `prtour.ts`. **Single implementation** — criterion 14 verifies both call it |

### Changed

| File | Change |
| --- | --- |
| `src/interpret.ts` | `StopMeaning` grows `summary`; the prompt asks for it in the same call; `PROMPT_VERSION` 4 → 5. `applyMeanings` keeps today's concatenation as the expanded text, unchanged |
| `src/codetour.ts` | `CodeStep` gains `summary`; existing `text` is untouched and becomes the expanded view |
| `src/repoview.ts` | render `summary` by default, today's `text` behind a per-step press, plus a global expand toggle (§8). Line 754 is the render point; the notes panel at 506/657 keeps binding to the FULL text |
| `src/cli.ts` | the `pr` subcommand, its flags (`--base`, `--head`, `--no-cold`), and the cold-repo cost report (criterion 10) |
| `repo-tour` (bash) | dispatch `pr`; add it to `--help` |
| `src/digest.ts` | the manifest records which commit the digest represents, so a checkpoint can report its own staleness |
| `test/pipeline.test.ts` | criteria 1–14; currently 64 tests, all passing |

## The one real gap — reading the head side without a checkout

**Corrected 2026-08-27.** The first version of this report proposed `git worktree add
--detach` to digest the base commit. Evan deferred that whole idea as repo archaeology, and
re-reading his original framing showed it was never needed: the checkpoint is *the digest
already on disk*, so only the **head** side has to be computed.

`digest()` (`src/digest.ts:83`) resolves a filesystem path and walks the working tree, and
`extract()` reads files from disk — so the head side still needs its files to exist
somewhere. But that is the **diff set**, not the repo:

```
git diff --name-status <checkpointSha>..<headSha>     the file list (incremental.ts already speaks this)
git show <headSha>:<path>                             the content, per changed file
  → materialise the diff set to a temp dir
  → extract + interpret those files only
  → planIncremental() patches them into the checkpoint
```

Nothing is checked out. The user's working tree and index are never touched. The temp dir
holds tens of files, not the repository, and it lives for one run.

The **T-1 self-scan rule still applies**: the temp dir must exclude `.repo-tour/`, or PR
mode re-invents the exact defect criterion 2 exists to catch.

## Call path

```
cli.main()
  └─ pr(argv)
       ├─ resolvePr()                    src/pr.ts — → { baseSha, headSha, forkSha, prose }
       ├─ loadCheckpoint()               src/checkpoint.ts — the digest already on disk
       │    └─ none? say so, offer `repo-tour digest .`         (criterion 10)
       ├─ headSide(diffSet, headSha)     git show → temp dir → extract + interpret
       │    └─ planIncremental()         src/incremental.ts, unchanged — diff-sized
       ├─ meaningDelta(base, head)       src/delta.ts
       │    ├─ perFile()                 what/why compared per stop
       │    ├─ ripple()                  one hop re-interpreted, N hops structural only
       │    └─ score()                   the ordering criterion 3 checks
       ├─ buildPrTour(delta)             src/prtour.ts → CodeStep[]
       │    └─ narrate(step, level)      src/narrate.ts — shared with buildCodeTour
       └─ renderRepoView(...)            src/repoview.ts — unchanged surface, criterion 9
```

## Not touched

`src/inventory.ts`, `src/rank.ts`, `src/extract.ts`, `src/rollup.ts`, `src/architecture.ts`,
`src/skins.ts`, `src/library.ts`, `src/server.ts`, `src/view.ts`. The digest engine itself
does not change; T-5 composes it. `src/incremental.ts` is used as-is — PR mode is its first
heavy consumer, which is why the deferred drift-budget spike (T-1 §7) matters here, but the
constants stay in config and are not touched by this ticket.

---

## Revision history

- **2026-08-27, first draft** — proposed `git worktree add --detach` to digest the base
  commit, and proposed splitting the existing `what` / `why` fields across the two
  disclosure levels.
- **2026-08-27, corrected** — both were wrong, on Evan's correction at the spec gate.
  The checkpoint is the digest already on disk (no checkout, no historical digest), and
  the summary is a **new third field** compressing the whole explanation rather than a
  selection between two existing ones. Findings 1 and 2 and the "one real gap" section
  were rewritten; the file/owner tables were updated to match. Spec §4, §6 and §8 carry
  the same correction.
