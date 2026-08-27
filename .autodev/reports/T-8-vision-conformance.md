# T-8 — vision conformance at acceptance

**Cleared by:** `agent:claude(on-behalf:evan,GA-5)` — his question *"Why can't I see the PR?"*
plus the standing GA-4 instruction not to be stopped. He has not seen it run at the time of
writing; the running thing goes to him with this.

## The intent

One sentence, and it was a question rather than a request: **"Why can't I see the PR?"**

The honest answer was that the Pull requests tab was a decorative span and PR mode lived
only on the command line. T-5 had verified "plays in the existing surface" by checking the
renderer, which was true and was not the thing he was asking about.

## Conformance

He can now click Pull requests, see PR #3, click it, and read the tour — without leaving the
app or being handed a file path. Verified on merged `main` against a real PR. **Conformant.**

## What this ticket taught, beyond itself

Three of the four review findings were invisible to a green test suite, and all three lived
in the gap between what tests construct and what a person touches:

- the served page had a **cache** in front of the renderer, and no test ran the server;
- the PR diff was **two-dot**, and every test built both sides by hand;
- `gh` ran **synchronously in a request handler**, and no test made a request.

That is the same gap as the T-1 self-scan defect and the T-5 rename defect. It is now three
for three, and the lesson is in `kb/wiki/lessons.md`: **a feature is not verified until
someone has reached it the way a user would.**

## Still not done

Unchanged: a PR tour is **readable**, not **fileable**. The notes panel is T-3.
