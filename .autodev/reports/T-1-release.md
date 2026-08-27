# T-1 — release record

**Recorded:** 2026-08-27 · **Stage:** release · **Deploy gate:** `unattended` policy

## Merged to main — yes

`main` is at `1783b85`. T-1's work landed across the commits ending there; the acceptance
commit of record is
`bf214bd1c9daf0a517ca0fcc6bbb3edbeb6bfb76`. Remote: `github.com/BMA-Corgea/repo-tour`.

## Deployment status — stated honestly, not faked green

**There is no production service to deploy to, and pretending otherwise would put a false
SUCCESS on the record.** repo-tour is a local CLI tool by deliberate design — the in-tour
chatbot runs on Evan's Claude subscription rather than an API key, which constrains the
product to something that runs on his machine (recorded constraint, 2026-08-25).

"Released", for this product, means the tool builds and runs from a clean checkout of
`main`. Verified now, on `main`, at `1783b85`:

| check | result |
|---|---|
| `npm run build` (tsc) | clean, no errors |
| `npm test` (vitest) | **64/64 passing** |
| `repo-tour` bin | present, executable, maps to `dist/cli.js` |

## Rollback path

`git revert` on a public single-branch repo with no consumers and no deployed state.
Nothing external depends on this yet; T-7 (GONS integration) is the ticket that will
change that, and it is deferred.
