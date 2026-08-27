# T-9 — Build plan

**Branch:** `t9-pr-view` · inline, serial · delivery: branch + PR to `main`.

1. **`diff.ts`** — parse `git diff -U6` into `{ file, hunks: [{ header, lines: [{kind, oldNo, newNo, text}] }] }`.
   Pure and testable; the render depends on nothing but this shape.
2. **`prview.ts`** — the page. Three panels like the repo view so it is recognisably the same
   product: PR's files (status + `+n/−n`), the diff with add/del highlighting, the tour.
   Header carries the PR title, number and a link out to GitHub.
3. **Narration with context** — `adjudicate` is given the checkpoint's own interpretation of
   the file plus its importer count, and asked for a `narrative`: *what is this PR proposing
   to change about code that does X, and what follows downstream.* This is the criterion-4
   answer to "tell me what the PR is actually doing".
4. **Demote the score** — `prtour` leads with the narrative; band and delta become a chip.
   Ahead/behind out of the default text.
5. **Affordances** — the tab shows `Pull requests · N`; a PR being interpreted says so on both
   the repo page and the PR page.
6. **Prove it by looking.** Drive the real app against real PR #3 and read the page. The
   acceptance test is Evan's own path, per the lesson T-8 recorded.

**The standing rule for this ticket:** the score is the sort order, never the sentence. If a
stop opens with a number, it is wrong.
