# T-5 — release record

**Recorded:** 2026-08-27 · **Deploy gate:** `unattended`

## Merged to main — yes

`main` @ `0b9bf50`. Landed as two pull requests:

- **#1** `eef16f8` — PR mode, and two-level narration
- **#2** `0b9bf50` — the two defects verify found

## Deployment status — same honest answer as T-1

There is no production service. repo-tour is a local CLI by design: the in-tour chatbot runs
on Evan's Claude subscription rather than an API key, which pins the product to his machine.
"Released" means the tool builds and runs from a clean `main`, verified on `0b9bf50`:

| check | result |
|---|---|
| `npm run build` (tsc) | clean |
| `npm test` | **93/93 passing** |
| `repo-tour pr` | ran end to end against four branches and one real GitHub PR |

## Rollback path

`git revert` on a repo with no consumers and no deployed state. The one new persistent
artifact is the adjudicator's verdict cache under `.cache/adjudicate/`, which is
content-keyed and disposable — deleting it costs a re-ask, nothing else.
