# T-3 — monitor (final)

On `main` @ `1eb0cd0`: build clean, **118 tests**, both panels driven live.

```
/api/ask       200, provider claude, model claude-sonnet-5
PR page        Notes + Ask panes, key repotour:notes:repo-tour#pr-3
repo tour      Ask pane, key repotour:notes:repo-tour  (no PR suffix)
context (PR)   pr, file, diff, digest meaning, 2 importers, notes
context (repo) file, digest meaning for 8 files, importers for 29
failure paths  invalid JSON / ask something first / provider's own text
```

**No breach, no rollback, no incident.**

## What to watch

The one thing that would quietly ruin this is the assistant answering confidently from a
context it was not given. Both live checks ended with it stating its own limit, unprompted —
that is the behaviour to spot-check on any future run, and it is cheaper to read than to test.

## Follow-ups

- **T-7 — GONS integration.** The last of the six, and the only one left.
- **Posting a review back to GitHub** — deliberately not built. Different trust boundary;
  its own ticket, once Evan has used the notes and knows what he wants sent.
- **T-5 spec §2** still describes comparing interpretations rather than direct adjudication.
- **The drift-budget spike** (T-1 §7) — still unticketed.
- The repo tour's notes list is still its own implementation; only the record shape is shared.
