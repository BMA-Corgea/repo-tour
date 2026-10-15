# repo-tour — CURRENT WORK

Present tense only. Updated at EVERY handoff (see the handoff procedure).
Target size: ~2 pages. The live edge is never pruned; the recent past keeps
~15 items or ~30 days, one line each with the WHY; anything older is dropped
here and found via the reference table below.

## Live edge

<!-- What is in motion right now: one line per active ticket/effort —
     what, why, where it stands, what is next. Never pruned while live. -->

- **Next foreman: read `.autodev/foreman/RESUME.md` first** (local; `.autodev/` is gitignored). The run of
  2026-10-14/15 wound down at the shared meter's 90% line; T-30 is its first unfinished move.
- **Foreman run 2026-10-14 (GA-14: the owner's sign-off form, then "go ahead and get started on a
  foreman loop"):** the owner accepted **T-14, T-20 and T-16**, now complete. **T-29 is on main**
  (`7d36f02`) and waits at uat: a cached tour page is reused only while the code that made it runs, and
  Rebuild re-renders. It also took in T-32's three cross-site guards (closed done-elsewhere). **T-31 is on main**
  (`062c9b8`) and waits at uat: one file never stops a digest, and the repo page says which file was
  not read and why. **T-30** is in build: its rework fixed the three blockers its review found (a cut
  can parse and still hide the wrong block), and one regression is left before a fresh review. T-21 is "not now" (the owner, GA-14) and T-19 stays
  parked. The seats found more that main has too, all waiting on the owner's go: T-33, T-34, T-36, T-37,
  T-38 and T-44 (below). **All six pieces the owner described on day one are shipped**: the sixth, GONS
  integration, was built on the GUTS side (below), so **T-7 is not needed**.
- **GONS integration: built on the GUTS side, so this repo has nothing to do.** 2026-08-27, on the owner's instruction, GUTS
  ticket **T-55** was filed ("Bring repo-tour's PR tours into the GONS Office PR section")
  with a first-hand brief at `GUTS/.autodev/handoffs/T-55.md`, and the live `guts-bridge`
  session was messaged. Its `spec_ready` was deliberately NOT cleared: how it lands in the
  Office is GUTS's decision. **Update 2026-10-07: GUTS built it, so T-7 is not needed.** GUTS
  closed T-55 on 2026-09-27 and folded it into GUTS **T-212** (slice C3: open a change's
  repo-tour from its ticket page). C3 landed on gons `main` `a518a49` on 2026-10-05 and is
  switched on (`GONS_FOREMAN_ACT`). GONS runs THIS checkout's CLI (`pr <tree> --base <sha>
  --head <sha>`, in a temp dir) and reads `DEFAULT_MODEL` from `dist/interpret.js`
  (`gons/backend/app/foreman_tour.py`). So keep `dist/` built and that CLI shape stable.
  Known gap, logged LOW on GUTS's side: the Ask panel in a GONS-served tour needs this repo's
  own server running.
- **T-19** (bug) — The codex provider still gets a shell: its read-only sandbox is not 'no tools' — intake
- **T-21** (bug) — A Ctrl-C in the first second of a model call, through the ./repo-tour launcher,… — intake
- **T-29** (bug) — Cached tour pages outlive the code that made them: the page version hashes 5 of… — uat
- **T-30** (bug) — Build scaffolds that do not parse: a step whose first brace opens inside an unc… — build
- **T-44** (techdebt) — T-20's signal tests fail under heavy load: a 3 s exit budget against a startup … — intake
- **T-31** (bug) — One file with a long expression chain aborts the whole digest: the import walk … — uat
- **T-33** (bug) — After an update every open tour reloads at once, and each waits behind the rebu… — intake
- **T-34** (bug) — Another site's page can start a tour's rebuild with a plain GET of /r (an image… — intake
- **T-36** (bug) — A file name with a double quote runs script on the repo page and the digest vie… — intake
- **T-37** (bug) — PR tours: a file not read on one side reads as its whole public surface added o… — intake
- **T-38** (techdebt) — Parser memory: a file near the parser's limit still peaks at about 4 GB, and wo… — intake

## Waiting on

<!-- Holds: "waiting at <gate> on <keyholder> since <date>, ping sent to
     <channel>" — no session should discover a hold by archaeology (ruling 24). -->

- **T-29, T-31** — waiting at accept on the owner since 2026-10-15; the foreman brings both in one form
  at the end of the run.
- **T-33, T-34, T-36, T-37, T-38, T-44** — at intake, waiting on the owner's go (the same form).
- **T-21** — the owner said "not now" (GA-14). **T-19** — parked by the owner (GA-13).

## Recent past (~15 items / ~30 days)

<!-- One line per completed item, WITH the why. Newest first. Prune from the
     bottom; the permanent record lives in tickets, events.jsonl, and wiki. -->

- 2026-10-15 **T-31 landed** (`062c9b8`, at uat) — the import walk is iterative, so a 20,000-term chain
  digests and its far-end `require()` is found; a file that cannot be read is listed with its reason, on the
  repo page too, and the rest of the tour goes on. Why the parser runtime is replaced after a failure: it is
  one per process, so a file too big for it used to fail every later file, and its 2 GiB is now let go.
- 2026-10-15 **T-29 landed** (`7d36f02`, at uat) — the page version hashes the whole running build, once,
  at load, so a cached page is reused only while the code that made it runs; the owner's 2026-09-22
  autoSQL page now rebuilds behind them on the next open, with the T-18 tutor panel, and its 34
  interpreted stops cost 0 model calls. Rebuild re-renders. Why it grew: the review showed that forcing
  the build routes let any site trigger paid re-renders, so they answer only repo-tour's own pages.
- 2026-10-15 **T-32 CLOSED done-elsewhere** (T-29's AC8, `7d36f02`) — `/api/add`, `/api/remove` and
  `/api/llm-set` acted on another site's request; with codex logged in, a page anywhere could switch the
  provider and send a toured repo's source to another vendor. Folded into T-29: same file, same rule.
- 2026-10-14 **T-16 COMPLETE** (accepted by the owner, GA-14; landed `85ef244`) — a top-level
  `const x = (function () {...})()`, and `(function () {...}).call(this)` with its `.apply`/`.bind`
  forms, give up their inner functions as symbols, tour stops and build steps.
- 2026-10-14 **T-20 COMPLETE** (accepted, GA-14; landed `83eba8e`) — each model call stands in its own
  empty folder; and `repo-tour pr`, which GONS stops by signal on timeout, now cleans up and ends by the
  signal (130/143) instead of paying on.
- 2026-10-14 **T-14 COMPLETE** (accepted, GA-14; landed `0a6c5b0`) — the pack test packs a temp copy, so
  it no longer rewrites the `dist/` GONS runs; a wrong asset root fails loudly.
- 2026-10-07 **T-18 COMPLETE** — the tutor, accepted by the owner (GA-12: "it looks good. I approve")
  after a rework from his first test drive: a silent stream Firefox closed on a network change,
  and every model call running as a full agent inside the toured repo. Why two review rounds:
  `--safe-mode` looked like a sandbox and is not; only standing outside the repo closes the class.
- 2026-09-05 **T-17 COMPLETE** — The owner's name leaves the public repo
- 2026-09-05 **T-13 COMPLETE** — Interpret the decisions — alternatives per build step, and Ask context for a st…
- 2026-09-05 **T-15 COMPLETE** — Script-style JS yields no load-bearing ranges: IIFE bodies are invisible to ext…
- 2026-09-05 **T-12 COMPLETE** — The build-order engine — digest → BuildPlan, and the structural check
- 2026-09-04 **T-11 COMPLETE** — Expose the core as a consumable package — for the VS Code front end
- 2026-09-04 **T-10 CLOSED duplicate** — Tutor chat during a tour — context-aware Q&A on the current step
- **2026-08-27** — **T-3 COMPLETE**, the oldest ask on the project: notes carrying which stop
  inspired them, and an assistant that reads them. Why it took until now: it was deferred at
  every gate since the first spec on the reasoning that a tour has to be worth taking notes
  on before notes are worth having. A note records the NARRATIVE that was on screen, not just
  the location — that is what makes it readable a week later.
- **2026-08-27** — The Ask panel follows sql-gauntlet's tutor, which the owner pointed at: a
  persona plus a labelled context block, over the local `claude` CLI. Why labelled: the notes
  are the human's and the meaning is the machine's, and an answer confusing the two would be
  worse than none. Asked about `src/server.ts` from a summary alone, it named "loosen the
  fingerprint check → serve stale pages" as a risk — which is exactly the T-8 defect.

- 2026-08-27 **T-3 COMPLETE** — Notes with provenance on a PR, and an AI that reads them
- **2026-08-27** — **T-9 COMPLETE.** A real PR page: the PR's own files, the diff on screen
  and syntax-highlighted, a link out to GitHub, and narration that says what the PR is doing
  rather than reciting its score. Why the rebuild: the tour had been rendered through
  `renderRepoView`, so it WAS the repo page — one decision that caused five of the six faults
  The owner listed.
- **2026-08-27** — The stop text had been opening with `MEANING MOVED · 0.60 · 2 lines`.
  Why that matters more than the others: it is the same failure as the metrics demo rejected
  on 2026-08-26, whose lesson was already in `kb/wiki/lessons.md`. Now enforced by a test
  that fails if a stop opens with a number — prose in a wiki did not hold.
- **2026-08-27** — The style did not follow through: `prview.ts` invented `--panel`,
  `--hover`, `--fg` with DARK fallbacks, so a light skin got dark panels and grey-on-cream
  text. Rebuilt on house tokens; a test fails if any of the three reappears.
- **2026-08-27** — The building page hung while you watched it. Why: `building()` used one
  argument as heading, polled job key AND destination, so a PR build polled a decorated
  label, never resolved, and would have navigated to the repo tour anyway.

- 2026-08-27 **T-9 COMPLETE** — A real PR view: the diff on screen, and narration about the change not the score
- **2026-08-27** — **T-8 COMPLETE.** The app's "Pull requests" tab was a decorative span and
  PR mode only ran from the CLI, so the owner clicked it and nothing happened. Why it slipped
  through T-5: criterion 9 was verified by checking the PR tour renders through the same
  function, which is not the same as being reachable by a person. Three of the four defects
  found here were invisible to a green suite — a cache in front of the renderer (no test ran
  the server), a two-dot PR diff that reported the base's new files as deletions (every test
  built both sides by hand), and `gh` blocking the event loop (no test made a request).
- **2026-08-27** — The test suite was leaving 20 directories in `/tmp`, each holding a digest
  cache and no source. Why that shape: a test deleted its fixture while a resumed background
  build was still running, and the build wrote the cache back into the deleted path. Zero now.
- **2026-08-27** — **T-5 COMPLETE.** PR mode: a pull request toured by how far its *meaning*
  moved, not how many lines changed. Also two-level narration for both tour kinds — a
  tweet-sized summary by default, full text one press away. Why: every stop was an 80–140
  word paragraph, and skimming thirty to find the two that matter is the overwhelm the owner
  described.
- **2026-08-27** — T-5's central comparison was rebuilt mid-build after it failed on real
  code. Why: diffing two free-prose interpretations scored a pure local-variable rename at
  0.47 "meaning moved" — the model had written a *different essay* about the same code, ~50%
  overlap. Free prose is not stable enough to diff. `adjudicate.ts` asks the model the
  question directly; the same fixture then scored 0.00.
- **2026-08-27** — **T-1 COMPLETE.** Accepted by the owner (GA-3), then release and monitor, both
  recorded honestly rather than faked green: there is no production service, so "released"
  means the tool builds and runs from a clean `main` — verified live.

- **2026-08-26** — Product surface rebuilt on the owner's rejection of the metrics demo. Why it
  went wrong: the ranking signals are how the engine picks what to show, not what a reader
  wants; putting them on screen showed the rubric instead of the repo. Now: repo page with
  real code, tour anchored to line ranges, narration leading with the author's own
  docstrings (7 of 14 stops on autoSQL quote the author directly).
- **2026-08-26** — T-1 completed through verify: stage 5 rollup, incremental re-digest, and
  a generated tour. Why the tour is here and not deferred: the owner asked to see a demo, and a
  tour is a projection of the digest, so it cost a renderer rather than a new subsystem.
- **2026-08-26** — verify found a defect no unit test could: the digest was scanning its own
  `.repo-tour/` cache on a second run, inventing ~100 additions and a false 44% reuse figure.
  Fixed and pinned. The general rule now recorded: a tool that writes into the tree it reads
  must exclude its own output, and one run will never show you the bug.
- **2026-08-26** — Wired to github.com/BMA-Corgea/repo-tour; `main` is the default branch.
- **2026-08-26** — Criterion 8 built: self-contained HTML digest view (`src/view.ts`).
  Why: criteria 1–7 prove the machinery, but only a human reading a page can judge whether
  the digest is any good. Self-containment is enforced by test, not intent.
- **2026-08-26** — auto-review finding fixed, not waived: `inventory()` read whole files
  into memory to hash them. Why it mattered: large repos are the entire target. Now
  chunk-hashed; verified identical output on GUTS.
- **2026-08-26** — Stages 1–3 built (inventory, extract, rank) in Node + TypeScript.
  Why this shape: ordering is the cost-control mechanism — every free, exact stage runs
  first so the paid stage only ever reads what survived.
- **2026-08-26** — Language decided: **Node + TypeScript** with `web-tree-sitter`, by the owner.
  Why: the engine and the tour UI talk constantly; Python would put a serialization seam
  through the middle of the product. Cost accepted: the only non-Python repo in the estate.
- **2026-08-26** — Onboarding closed out (3 of 4 goals; `about` left open by choice).
  Why it looked unstarted: session 1 captured every answer into the transcript but never
  marked the steps, so the board read 0/4 when it was really 3/4.
- **2026-08-25** — T-1 spec approved by the owner (GA-1), `spec_ready` cleared.

## Reference table (where the past lives)

| Looking for... | Where |
| --- | --- |
| Any ticket's full journey | its ticket file (by id/slug) and its handoff in `.autodev/handoffs/` |
| The event-by-event record | `events.jsonl` (append-only, forever) |
| Durable lessons and decisions | `kb/wiki/` |
| What the code looks like now | `kb/CODE-MAP.md` |
| Why the language is Node | `kb/wiki/decision-implementation-language.md` |
| What T-1's build actually proved | `.autodev/reports/T-1-plan.md` (per-criterion status) |
