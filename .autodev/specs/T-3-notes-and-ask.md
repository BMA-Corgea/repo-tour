# T-3 — Notes with provenance on a PR, and an AI that reads them

The last of the six pieces Evan described in the first session, and the one that turns a PR
you can *read* into a review you can *file*. From that session, verbatim:

> *"Side panel for notes, each note carrying metadata for WHICH TOUR STEP inspired it, so
> post-tour code review is better than LGTM. Chatbot during the tour answering questions."*

And now, 2026-08-27:

> *"Just like the AI that's used in the sql-gauntlet, let's go ahead and make it so the notes
> can be read and questions can be answered by an AI."*

## What already exists, and what does not

The **repo tour** already has a notes panel: anchoring to a file and line range, capturing
the stop index, stop title and the stop's explanation, stamping the commit, and exporting to
Markdown and JSON. That is most of T-3's original scope, built early.

Missing: **the PR page has no notes at all** (it is a new page, T-9), and **there is no AI**
on either surface.

## The sql-gauntlet pattern, read from its source

`sql-gauntlet/server.js`: a `POST /api/chat` taking `{ messages, context }`; a persona system
prompt; a `buildContextBlock(ctx)` that flattens the current state into labelled lines; the
Anthropic SDK when a key exists, otherwise `claude -p` using the existing Claude Code login.
Conversation trimmed to the last 30 turns, first turn must be a user turn.

repo-tour keeps the shape and **does not copy the backend**: `src/llm.ts` already has a
provider registry (`claude` CLI, codex, ollama) behind `runLlm`, which is the same
subscription-not-API-key constraint that shaped this product from day one.

## Acceptance criteria

1. **The PR page has a notes panel.** A note anchors to a file, a line range, and — when one
   is in view — the stop that inspired it, and records the PR number and head SHA.
2. **Provenance is on the note, not implied.** Each note carries which file, which lines,
   which stop, the stop's own explanation, the commit, and the quoted code.
3. **Notes survive.** Stored per repo+PR and still there after the tour is rebuilt.
4. **Notes export** as Markdown and JSON, provenance intact — the artifact you send someone.
5. **An Ask panel on both surfaces** — the PR page and the repo tour.
6. **The AI is given real context**: the PR (title, body), the file in view, its diff, the
   digest's own interpretation of that file, the current stop, and **the reader's notes**.
7. **It answers about the notes.** Asked "what have I flagged so far?", it answers from the
   notes it was given, citing them.
8. **It runs on the existing provider registry** — the `claude` CLI by default, no API key.
9. **Honest when it cannot help.** A static exported page has no server: the panel says so
   rather than hanging. An unreachable model reports the reason.
10. **No new external requests** in any served page.

## Out of scope

GONS integration (T-7). Posting a review back to GitHub — a different trust boundary and its
own ticket, once Evan has used the notes a few times.
