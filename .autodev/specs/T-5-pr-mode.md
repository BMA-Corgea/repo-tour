# T-5 — PR mode: tour a pull request by diffing its *interpretation* against the checkpoint

**Ticket:** T-5 (feature) · **Risk:** medium · **Ceremony:** full (isolated worktree)
**Depends on:** T-1 (digest engine) — the checkpoint this whole ticket compares against
**Deferred from:** T-1 spec §9, row "PR mode — before/after and *why*"

---

## 1. Why this exists

Evan asked for this in the first session, before a line of code existed:

> *"Must also work on PRs: explain before/after and WHY the change was made."*

T-1 deferred it on a deliberate choice — repo-first for v1 — and the digest engine that
deferral was waiting for now exists and works. This ticket spends it.

The shape of the ask sharpened on 2026-08-27. Evan, in his own words:

> *"I want to check the interpretation of the PR against the already existing
> interpretation of the checkpoint. So that's a good starting point for understanding
> what exactly changed and what that does. A summary of what happened, I agree, is at
> most pleasant instead of helpful."*

That last sentence is the scope boundary for the entire ticket. **A narrated diff is not
the deliverable.** GitHub already renders diffs; a guided walk through one is a nicer
GitHub and nothing more. The deliverable is the comparison of two *readings* of the same
system.

## 2. The idea (the thing that makes this not-a-diff-viewer)

T-1's stage 4 produces an **interpretation**: prose meaning, per file and per tier,
pinned to a commit. A digest at a pinned SHA is a **checkpoint**.

```
  checkpoint                              PR head
  (interpretation of the system           (interpretation of the same system
   as it stands today)                     with this change applied)
        │                                        │
        └──────────────┬─────────────────────────┘
                       ▼
              THE MEANING DELTA
     per file:  did what this is FOR change?
     per tier:  did what this SUBSYSTEM is for change?
     per surface: did the public contract change?
```

The tour is a walk through that delta, ordered by it.

### The property this buys, stated as the headline claim

**Diff size and meaning change are independent, and the mismatch is the signal.**

| what you see | what it means | how you should read it |
|---|---|---|
| large diff, no meaning delta | a refactor / rename / reformat | fast, low attention |
| small diff, large meaning delta | the semantics moved under a quiet change | **this is your afternoon** |
| large diff, large meaning delta | genuinely new work | budget for it |
| no diff, meaning delta | a *ripple* — see §5 | the one nobody ever catches |

GitHub sorts a PR by lines changed. This sorts it by meaning changed. That reordering is
the product; everything else in this spec is in service of it.

## 3. Where a PR comes from

Two sources, one engine. Both resolve to the same thing — **a pair of commits** — and
nothing downstream knows or cares which one was used.

| invocation | resolves | needs |
|---|---|---|
| `repo-tour pr <n>` | GitHub PR #n → head SHA, base branch, title, body, commits, linked issues | `gh` (installed here, v2.45.0) + a GitHub remote |
| `repo-tour pr --base <ref> --head <ref>` | any two git refs — a local branch before it is ever pushed | git only, no network, no auth |

The GitHub path is a **fetcher on top of** the ref path, never a parallel implementation.
Its extra value is the prose humans wrote around the change (title, body, review thread,
linked issues) — which §7 needs and git alone does not carry.

If either commit cannot be resolved, the command **refuses**. It never guesses a base.

## 4. The checkpoint: the digest you already have

**Revised 2026-08-27 on Evan's correction.** The first draft of this section had the tool
checking out a commit and digesting it. That was wrong, and his objection was right:

> *"I don't think I care about interpreting historical commits yet. That seems like a
> niche application for investigating a repo that I don't care about yet."*

Re-read his original framing and the answer was already in it — *"check the interpretation
of the PR against the **already existing** interpretation of the checkpoint."* The
checkpoint is not something PR mode computes. **It is the digest sitting in `.repo-tour/`
from the last time you ran repo-tour on this repo.** It already exists; that is the point.

So:

| side | where it comes from | cost |
|---|---|---|
| **checkpoint** | the digest already on disk | free — it is already there |
| **head** | the PR's changed files, read out of git at the head commit | proportional to the diff |

**Nothing is checked out, and no historical commit is digested.** Getting the head side
needs only the content of the files the PR touched — `git show <sha>:<path>` for the diff
set, materialised to a temp directory and run through extract + interpret. That is
`src/incremental.ts` doing exactly the job T-1 built it for, with the new content coming
from a commit instead of the working tree.

### The staleness this creates, and how it is handled

A checkpoint is a digest of *whatever you last digested*, which may be behind `main`. That
is a real fact and the tour must not hide it:

- **the tour states which commit the checkpoint represents** and how far behind `main` it
  is (commits, and whether any of them touch files this PR also touches);
- when they overlap, that overlap is **a stop in the tour**, not a footnote — it is the
  "two changes that are individually fine and jointly wrong" case;
- refreshing is the user's normal workflow (`repo-tour digest .`), not a mode this ticket
  invents.

> Superseded: the earlier decision "the checkpoint is current `main`, obtained by
> checkout". Digesting an arbitrary historical commit is **deferred** (§10) — it is a
> repo-archaeology feature, not a PR feature.

## 5. The ripple: meaning that changes without a diff

If this PR changes what module **B** is for, then module **A** — which imports B and
changed **zero characters** — may now mean something different. That is the *"what that
does"* half of the ask, and no diff-based tool can see it.

Chasing it transitively is unbounded and gets silly. The line:

- **One hop of meaning.** Direct importers of any file whose interpretation moved are
  **re-interpreted** at head. They are full stops in the tour.
- **N hops of structure.** Everything further out is shown structurally — who depends on
  what, how far the reachable set extends — and **explicitly labelled as not
  re-interpreted**. The tour states the boundary rather than implying completeness.

T-1's drift budget (spec §5) already models exactly this problem for incremental
re-digest; PR mode is its first real consumer. **The invented constants stay in config and
are not hard-coded here** — the same rule T-1 §7 set, still binding.

## 6. Cost, and the no-checkpoint case

Stage 4 is the only stage that spends tokens, and PR mode's spend is bounded by the diff:

- **With a checkpoint** (the normal case): interpret only the files the PR touched, plus
  one hop of ripple. Content-keyed stop identity (`stopKey`) means unchanged code is not
  re-read at all — it cannot even drift in wording.
- **With no checkpoint**: there is nothing to compare against. The command **says so and
  offers to digest the repo first** — the ordinary `repo-tour digest .` you would run
  anyway — rather than silently doing it. `--no-cold` makes it stop instead.

Speed is explicitly not a constraint on this project and cost is not the thing to optimise
against. Honesty about both is still required.

## 7. The *why* — and the gap we will not paper over

Before/after is mechanical. **Why is not in the code.** It lives in the PR description,
the commit messages, the linked issue, the review thread — and if the author wrote none
of those, it does not exist and cannot be recovered.

The rule: **every claim about why cites its source.** PR body, commit message, issue
ref — shown inline, attributed. Where there is no source, the tour says *the author
recorded no reason for this* and stops. It never fills the gap with a plausible story.

This is the same discipline already in `src/codetour.ts`, which states what deterministic
narration cannot know instead of inventing it. PR mode inherits it.

What §2 and §5 *do* recover is often the why someone actually needed: not the author's
motive, but **where this lands and what now depends on it.**

## 8. Two levels of explanation — skim first, depth on demand

Added 2026-08-27 at the spec gate; **corrected the same day** after the first draft got the
mechanism wrong.

Evan's ask:

> *"I need a shorter explanation mode for each step for PRs and the base as the default.
> I still want the longer explanations available with a button press, but in general, as I
> skim, I just want to know more basic information first. Otherwise it's just as easy to
> get overwhelmed."*

And his correction, when the first draft proposed splitting the existing `what` / `why`
fields between the two levels:

> *"I'm not asking to choose between what and why for the shorter default, I mean that we
> take the actual output and make it smaller, stripping everything but the most essential
> for something that's like the size of a tweet or two that can be expanded into the
> original explanation with a button press."*

**This applies to BOTH tour kinds** — the PR tour and the existing repo tour.

### What the two levels are

| level | what it is | size |
|---|---|---|
| **summary** (default) | the whole explanation **compressed** — everything inessential stripped | a tweet or two (target ≤400 chars) |
| **full** (one press) | **the original explanation, unchanged** | as today |

### The mechanism — and the approach that was rejected

**Rejected: selecting a field.** The first draft made the default `what` and hid `why`
behind the press. That is a *selection*, not a summary, and it fails whenever the essential
thing about a stop lives in the `why` — which on this product is often exactly where it
lives. It would have hidden the best sentence on the page half the time.

**Adopted: `StopMeaning` gains a third field.** `interpret.ts` already returns
`{ what, why }` per stop; it grows `{ what, why, summary }`, produced **in the same model
call** — one pass, a few more output tokens, no second interpretation stage and no separate
compression step. `PROMPT_VERSION` bumps (4 → 5), which correctly invalidates the existing
stop cache.

The full explanation is assembled exactly as it is today. **Nothing about it changes.** The
summary is additive.

### Rules

- **Summary is always visible; the full text is always one press away.** The expanded view
  is byte-for-byte what the tour shows today — this is a disclosure change, not a rewrite
  of the narration.
- **A global toggle** flips the whole tour to expanded for deep-read mode; the per-step
  press still works inside it.
- **On a PR tour, the `MEANING MOVED` line is part of the summary**, never behind the
  press. That signal is the entire reason the tour stopped there.
- **One narration builder serves both tour kinds** — not two implementations that drift.

> **Relationship to T-1.** This changes how the repo tour *renders*. The repo tour was
> always outside T-1's spec (T-1 §9 defers the player to T-2; it was built early on
> 2026-08-26 after a demo request), so this does not disturb what T-1 was accepted for.
> T-1 completed its pipeline on 2026-08-27, before this work starts.

## 9. Acceptance criteria

Each independently checkable by Evan at the `accept` gate.

1. **A PR resolves to a commit pair.** `repo-tour pr <n>` on this repo prints head and
   base SHAs; `repo-tour pr --base <ref> --head <ref>` does the same with the network
   off. An unresolvable ref produces a refusal, never a guessed base.
2. **The checkpoint is reused, not rebuilt.** On a repo with a checkpoint on disk, a PR
   tour re-interprets only diff-touched files plus one hop. The run reports
   files-reused vs files-re-interpreted, and reused is non-zero. `.repo-tour/` is
   excluded from its own scan (the T-1 self-scan defect must not recur).
3. **Meaning-delta ordering differs from line-count ordering.** On at least one real PR,
   the tour's stop order is demonstrably not the diff's order. Both numbers — lines
   changed and meaning delta — are shown per file, so the ordering can be argued with.
4. **A pure refactor reports near-zero meaning change.** Given a PR that renames a local
   variable across several files or reformats only, the tour reports the structural
   change and a meaning delta at or near zero, and says plainly that nothing changed
   about what the code is for.
5. **A small semantic change outranks a large cosmetic one.** Given a PR containing both,
   the semantic change is a higher stop in the tour than the cosmetic one.
6. **The ripple is computed, bounded, and labelled.** Direct importers of anything whose
   meaning moved are re-interpreted and appear as stops; the further reachable set is
   listed structurally and marked "not re-interpreted". Both counts are reported.
7. **Fork point and landing point are both honest.** When `main` has moved since the
   fork, the tour reports both SHAs and names every file the PR touches that `main` also
   touched since. When they are the same commit, it says that instead of staying silent.
8. **Every why is sourced or admitted.** Run against a PR with an empty description: the
   tour contains no unsourced motive claim, and says the author recorded no reason.
   Every why it *does* state carries its source inline.
9. **It plays in the existing surface.** A PR tour opens in the same GitHub-shaped repo
   page as `repo-tour tour`, with stops anchored to line ranges at the head SHA.
10. **No checkpoint is handled honestly.** With no digest on disk, the command says so
    and offers to digest the repo first rather than silently doing it; `--no-cold` stops
    instead. It never checks out or digests a historical commit.
11. **Every stop is tweet-sized by default.** In both tour kinds, every stop has a
    summary and no summary exceeds 400 characters. Checkable by rendering a full repo
    tour and a full PR tour and measuring every stop.
12. **Expanding restores the original, byte for byte.** The expanded text of any stop is
    identical to what the tour renders today for that stop. Verified by a test that
    compares expanded output against the pre-change narration, not by reading it.
13. **The meaning signal survives compression.** On a PR tour, any stop whose
    interpretation moved says so in the summary, without expanding.
14. **One builder, both surfaces.** The repo tour and the PR tour render their two levels
    from the same narration code — verified by a test that both call it, not by
    inspection.

## 10. Out of scope — and what that costs

| deferred | ticket | why |
|---|---|---|
| notes panel with step provenance | T-3 | still the product differentiator; still its own ticket. A PR tour without it is readable but not yet a review instrument |
| in-tour chatbot | T-4 | needs the digest as a tool surface; unchanged by this ticket |
| posting review comments back to GitHub | — | this ticket **reads** a PR and explains it. Writing to a PR is a different trust boundary and belongs in its own ticket, after Evan has read a few tours |
| GONS integration | T-7 | unchanged |
| cross-service / contract graph | T-6 | still GUTS-shaped work |
| digesting an arbitrary historical commit | — | **deferred by Evan, 2026-08-27**: "a niche application for investigating a repo that I don't care about yet." It is repo archaeology, not a PR feature. PR mode needs only the changed files' content at the head commit, which git gives up without checking anything out |

> **⚠ The scope tradeoff to weigh at the spec gate.**
> This ticket ends with a PR you can *read* better than GitHub shows it. It does not end
> with a review you can *file*. The alternative is to widen T-5 to include the notes
> panel (T-3) so a tour produces something you can act on. **My recommendation is to keep
> T-5 narrow**: the meaning-delta is unproven and is where all the risk sits — shipping a
> notes panel on top of a comparison we have not yet judged means debugging two unproven
> layers at once, which is the exact argument that kept T-1 narrow and was right then.
> The cost is real: one more gate before a tour produces an artifact you can send anyone.

## 11. Risks

- **The meaning delta may be noisy.** Stage 4 is a model reading code; run twice, it may
  word things differently without anything having changed. If the delta cannot tell
  rewording from meaning-change, criterion 4 fails and the central claim of §2 collapses.
  **This is the ticket's primary risk** and criterion 4 exists specifically to catch it.
  Mitigation direction: compare on extracted assertions rather than raw prose similarity.
- **One hop may be the wrong boundary.** It is a judgment, not a measurement. Criterion 6
  makes the boundary visible so it can be argued with after Evan has read real tours.
- **The drift constants are still guesses** (T-1 §7). PR mode is their first heavy user,
  which makes the deferred spike more urgent, not less — but it stays a separate ticket.
- **`gh` auth is an external dependency.** The `--base/--head` path exists so PR mode is
  never fully blocked on it.

## 12. KB

Related pages: `kb/wiki/decision-implementation-language.md` (Node + TypeScript, binding
here), `kb/wiki/lessons.md` (the T-1 self-scan defect — criterion 2), `kb/index.md`.
