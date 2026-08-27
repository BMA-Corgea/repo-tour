# T-3 — Location report

## What exists

| where | what |
|---|---|
| `src/repoview.ts` `NOTES` (`:472`) | the whole notes panel for the repo tour — anchoring, provenance capture, localStorage, Markdown/JSON export. Keyed `repotour:notes:<repo>` |
| `src/repoview.ts` `implicitAnchor()` | a note defaults to the current stop or the visible lines, so Save is never a silent no-op |
| `src/llm.ts` `runLlm(prompt, choice, cwd)` | the provider registry — `claude` CLI, codex, ollama. Already the subscription-not-API-key path sql-gauntlet falls back to |
| `src/server.ts` `handler` | where a `POST /api/ask` belongs, beside `/api/llm` which already resolves the provider choice |

## What does not

- **`src/prview.ts` has no notes panel at all.** It is a new page and was built without one.
- **Neither surface has an Ask panel.**

## Targets

| file | change |
|---|---|
| **`src/ask.ts`** *(new)* | the persona and `buildContextBlock()` — the sql-gauntlet shape, over repo-tour's own context: PR, file, diff, the digest's reading of the file, current stop, and the reader's notes |
| **`src/notes.ts`** *(new)* | the notes panel as a shared client script, so the PR page and the repo tour cannot drift apart. `repoview.ts`'s copy is replaced by it |
| `src/server.ts` | `POST /api/ask` → `runLlm`; last 30 turns; first turn must be a user turn |
| `src/prview.ts` | Notes and Ask panes on the right, beside the stops |
| `src/repoview.ts` | the Ask pane; NOTES replaced by the shared module |

## The one thing to be careful about

The note record already carries `explanation` — the stop's own text. On a PR page that is the
**narrative**, which is what makes a note reviewable later: it records not just what the
reader flagged but what they were being told when they flagged it. That field must be filled
on the PR page too, or a PR note is worth less than a repo-tour note.
