# repo-tour KB Index
<!-- autodev-kb-index -->

Read this file first. Pick the smallest set of pages you need, then follow
links only as far as the task requires — don't load the whole `wiki/` tree.
How a KB works (wiki vs NOW vs operator, reference-table shape, history-
never-deleted) is plugin doctrine — see `skills/autodev/instructions/README.md`.

## Pointer table

| Looking for... | Page | Summary |
| --- | --- | --- |
| What is being worked RIGHT NOW | [CURRENT-WORK.md](CURRENT-WORK.md) | The live edge + recent past; updated at every handoff |
| What happened, day by day | [days/](days/) | Movements generated from the event log + session summaries |

## Layout

- `kb/index.md` — this file, the pointer table (always read first)
- `kb/CURRENT-WORK.md` — the NOW layer: state of play, updated every handoff
- `kb/CODE-MAP.md` — the living code map (regenerated, never hand-edited)
- `kb/wiki/` — regenerable, LLM-maintained knowledge pages. kebab-case filenames, linked from this index.
- `kb/operator/` — the operator model: decision style, communication style, approval patterns, handoff phrasing.

## Where the past lives

Nothing is deleted; older knowledge is pointed at where it lies.

| Looking for... | Where |
| --- | --- |
| A ticket's full journey | its ticket file and `.autodev/handoffs/` |
| The event-by-event record | `events.jsonl` (append-only, forever) |
| Anything pruned from CURRENT-WORK's recent-past window | this table's other rows, plus git history |
| What has gone wrong before (and the rule each time taught) | [wiki/lessons.md](wiki/lessons.md) | Value-bearing lessons page; grown by retros, read by planners |
| The pre-flight discipline for risky changes | [wiki/hardening-checklist.md](wiki/hardening-checklist.md) | Hardening checklist; consulted before touching load-bearing paths |
| Why repo-tour is Node + TypeScript (and not Python) | [wiki/decision-implementation-language.md](wiki/decision-implementation-language.md) | Locked 2026-08-26 by the owner; binds T-1 and everything downstream |
- [ideas](wiki/ideas.md) — things considered but not built, with the reasoning kept.
