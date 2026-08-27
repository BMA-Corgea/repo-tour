# T-5 — auto-review

**Stage:** `auto-review` · **2026-08-27** · Branch `t5-pr-mode` · PR #1

## Preflight

| check | result |
|---|---|
| `tsc -p tsconfig.json` | clean |
| `npm test` (vitest) | **91/91 passing** |
| `npm run build` | clean |
| secrets scan over the branch diff | no matches for key/secret/password/token/bearer/private-key |
| external requests in generated pages | none (asserted by existing test; 0 `<script src=>`) |

## Findings — 3 raised, 3 fixed

Found by running PR mode against three purpose-built branches, not by reading the diff.
None of the three would have been caught by the unit tests as they stood.

### 1. A rename read as a brand-new file — **fixed**

`skins.ts` → `themes.ts`, **zero lines changed**, scored **1.00 "MEANING MOVED"**.

The base side was read at the NEW path, which does not exist at the base commit, so
`beforeExtract` was undefined, every symbol looked newly added, and the public-surface
floor took the score to 1.00. A rename is the one change git explicitly tells us is *not*
a change, and the tool was reporting it as the largest possible one.

Fix: `sideAt` takes a `readAs` map — read the old path, report the new one. Same fixture
after: **0.00 steady**. Regression-tested.

### 2. A ref beginning with `-` reached git as an option — **fixed**

`resolveRef` passed user-supplied refs to `git rev-parse --verify`. A ref like
`--upload-pack=…` is read by git as an OPTION, and git has options that read and write
files. `execFileSync` prevents shell injection but not argument injection.

Fix: refuse a ref starting with `-` rather than trying to escape it. Regression-tested.

### 3. A checkpoint from another schema was read as current — **fixed**

`loadCheckpoint` never checked `schemaVersion`. Comparing against a digest written by a
different shape of the tool would report the FORMAT moving as the code moving — a false
signal in the one place this product must be trustworthy.

Fix: refuse, naming the version found and the command to run. Regression-tested.

## Reviewed and accepted as-is

- **`execFileSync` everywhere, no shell.** Every git and gh call passes an argv array.
- **PR body → page.** Untrusted text reaches the page through `embedJson` (which escapes
  `<`) and is rendered with `textContent`, not `innerHTML`. Not an injection path.
- **Temp directories.** Removed on every exit path including throws (`try/catch` in
  `sideAt`, `finally` in the CLI handler).
- **Meaning-key prefix collisions.** `k.startsWith(`${p}:`)` requires the colon, so
  `src/a.ts` cannot swallow `src/a.ts.bak`.

## Known limitation, stated not fixed

The deterministic claim comparison mis-scores an aggressive re-wording at **0.167** (worst
measured case). It is no longer the primary signal — `adjudicate.ts` is — and it now runs
only as the `--no-interpret` fallback and a second opinion. Every delta carries a `basis`
so a reader can see which produced the score. Kept as a test rather than tuned away.

## To the KB

The rename finding generalizes past this ticket and is recorded in `kb/wiki/lessons.md`.
