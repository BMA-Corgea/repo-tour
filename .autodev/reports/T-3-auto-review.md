# T-3 — auto-review

**Branch:** `t3-notes-and-ask` · 2026-08-27

| check | result |
|---|---|
| `tsc` / `npm test` / `npm run build` | clean / **118 passing** / clean |
| secrets scan over the branch diff | no matches |
| invented CSS tokens in a rendered page | 0 (T-9's test still holds) |

## Reviewed

- **The notes never reach the server unless the reader asks a question.** They live in
  localStorage and are posted with a question, not persisted server-side. That is a
  deliberate boundary: notes are review material and nothing promised to store them
  anywhere else.
- **The context block labels its sections.** The reader's notes and the machine's
  interpretation are marked as such, so an answer cannot silently attribute one to the other.
- **The persona forbids the two claims that would make it untrustworthy** — having read a
  file it was not given, and inventing a note. Both pinned by test.
- **Failure text is the provider's own.** `Could not launch the claude CLI` tells the reader
  what to fix; a generic 502 tells them nothing.
- **A static export says so.** The fetch has no server behind it on a `file://` page; the
  panel says to run `repo-tour serve` rather than spinning.
- **`esc()` on every rendered note field**, and the model's reply is escaped before the only
  markup honoured (code fences) is re-applied — a reply containing angle brackets cannot
  rewrite the page.
- **Conversation trimming** matches sql-gauntlet: last 30 turns, never opening on an
  assistant turn.

## Known duplication, recorded not hidden

The repo tour still renders its notes list with its own copy of the code; only the RECORD
shape and the storage key are shared (`notes.ts`). Lifting the repo tour's working, tested
panel would be a rewrite with real regression risk and no change a reader would notice. If a
third surface ever needs notes, lift it then. Written into `notes.ts` where the next person
will see it.

## Findings — 0

Nothing raised. The two live checks (a question about a note, and a question about a file on
the repo tour) both answered correctly and both stated their own limits.
