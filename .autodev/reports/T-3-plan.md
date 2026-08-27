# T-3 — Build plan

**Branch:** `t3-notes-and-ask` · inline, serial · delivery: branch + PR to `main`.

1. **`ask.ts`** — persona + `buildAskPrompt(messages, ctx)`. Rules borrowed from sql-gauntlet's
   tutor and adapted: concise, plain text, no tools, and — repo-tour's own addition — never
   claim to have read code it was not given, and cite the note when answering about notes.
2. **`/api/ask`** on the server, through `runLlm` with the stored provider choice. Trim to the
   last 30 turns; drop leading assistant turns; report the provider's error text rather than
   a generic failure.
3. **`notes.ts`** — lift the existing notes client out of `repoview.ts` unchanged in behaviour,
   parameterised by storage key and anchor source, so both pages share ONE implementation.
   Repo tour must still pass its existing tests after the lift.
4. **PR page** — Notes and Ask as tabs beside the stops. A note's anchor is the selected file
   plus the hunk in view, and its `explanation` is that file's narrative.
5. **Ask on the repo tour** — same component, context built from the repo tour's stop.
6. **Prove it by using it.** Write a note on real PR #3, then ask "what have I flagged so far?"
   and check the answer cites it. Then ask something about the diff and check it is grounded.

**The rule for this ticket:** the Ask panel is only worth having if it knows what the reader is
looking at. If a question about the file in view can be answered without the page, the context
block is not doing its job.
