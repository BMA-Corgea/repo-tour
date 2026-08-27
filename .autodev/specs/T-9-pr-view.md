# T-9 — A real PR view: the diff on screen, and narration about the change

## What went wrong

T-8 made the tab reachable. Evan opened it and listed six faults, and five of them trace to
**one decision**: the PR tour was rendered as a projection over the repo page
(`renderRepoView(checkpoint.result, …)`). That inherited the whole-repo file tree, the
whole-file source view, no diff, no PR link, and stops anchored to a file rather than to a
change.

The sixth is worse and is its own mistake. His words:

> *"it's only telling me about this fucking math about what's going on instead of what the
> PR is actually doing… It needs to use the context of what's actually going on to tell us
> what the PR is proposing to change about it."*

The meaning-delta was made **the subject of the narration** when it was only ever meant to
be **the sort order**. A stop reading `MEANING MOVED · 0.60 · 2 lines` puts the rubric on
screen instead of the change — the same failure as the metrics demo rejected on 2026-08-26,
whose lesson is already recorded in `kb/wiki/lessons.md`. Shipping it again is the finding
that matters most in this ticket.

## Acceptance criteria

1. **The file panel shows the PR's files and nothing else** — each with its change kind and
   `+n/−n`. No unrelated repo files.
2. **The diff is on screen and highlighted.** Added and removed lines are visually distinct,
   with enough surrounding context to read them. Not a whole file with no marks on it.
3. **A stop anchors to a hunk**, not to line 1 of a file.
4. **The narration leads with what the PR is DOING** — in prose, grounded in what the digest
   knows about the code being changed (what the file is for, who depends on it), not in the
   commit message alone and not in the score.
5. **The score is a chip, not a sentence.** `meaningDelta` and the band may appear as a small
   marker; they may not be the opening words of a stop.
6. **The page links to the pull request** on GitHub.
7. **Ahead/behind is not in the default narration.** (Kept in the data; not shown for now —
   Evan: *"I don't really want to know about how far ahead or behind it is for now."*)
8. **Availability is visible.** The repo page shows that pull requests can be toured, and how
   many are open — not a tab that looks identical to the dead ones beside it.
9. **Loading is visible.** While a PR interpretation builds, the app says so — on the repo
   page and on the PR page — rather than looking idle.
10. **No new external requests** in any served page.

## Out of scope

The notes panel (**T-3**) is still not this ticket.
