# T-5 — vision conformance at acceptance

**Recorded:** 2026-08-27 · **Stage:** uat · **Gate:** `accept` cleared
**Cleared by:** `agent:claude(on-behalf:evan,GA-4)` — Evan's recorded words, my hand.

> **Why this gate was spent rather than surfaced.** GA-4, verbatim: *"Yes. Please don't ask
> me about them anymore. We can just observe the app and I'll tell you what I want changed
> afterwards at this point. Just get to work looping over it until it's complete."*
> That is an instruction not to be stopped, so the gate is discharged and the work is put
> in front of him instead. He has not seen it run at the time of writing.

## The intent it is measured against

No Direction artifact. The intent of record is Evan's own words, twice:

> *"Must also work on PRs: explain before/after and WHY the change was made."* (2026-08-25)

> *"I want to check the interpretation of the PR against the already existing interpretation
> of the checkpoint… A summary of what happened, I agree, is at most pleasant instead of
> helpful."* (2026-08-27)

The second sentence is the scope boundary, and it is the one to judge against: **a narrated
diff was explicitly not the deliverable.**

## Conformance

| what he asked for | what shipped |
|---|---|
| works on PRs | `repo-tour pr <n>` (GitHub) and `--base/--head` (no network). Toured its own PR #1 |
| before / after | both sides read out of git; nothing checked out |
| **and WHY** | sourced from PR body / commit / issue, cited inline — and **admitted** when absent |
| against the existing interpretation of the checkpoint | the checkpoint is the digest already on disk; only the diff is computed |
| **not** a summary of what happened | stops are ordered by meaning moved, never by lines. `rank.ts` at 2 lines outranks `rollup.ts` at 37 |
| shorter default, longer on a press, for PRs **and the base** | one narrator, both tour kinds; summary ≤400 chars, full text one press away, byte-identical to before |

**Verdict: conformant**, on all 14 criteria (see the verify report).

## Where it departed from the spec Evan approved — stated, not buried

**The central comparison was replaced mid-build.** The approved spec §2 said to compare the
two interpretations. That failed on real code: a pure local-variable rename scored 0.47
"meaning moved". The model had not paraphrased itself, it had written a different essay
about the same code — roughly half the content words in common. Free prose is not stable
enough to diff.

So `adjudicate.ts` asks the model the question directly instead. The *claim* the spec makes
is unchanged and is now met; the *mechanism* §2 named is not what shipped. Spec §2 should be
amended to describe what exists, and that is a documentation debt this ticket is leaving
behind, recorded here rather than glossed.

## What this ticket does NOT do — unchanged from the spec gate

T-5 makes a pull request **readable**. It does not make one **fileable**: there is still no
notes panel carrying which stop inspired a note, which is **T-3**, and which is the piece
that turns a tour into a review instrument. Evan weighed this at the spec gate and took the
narrow ticket.
