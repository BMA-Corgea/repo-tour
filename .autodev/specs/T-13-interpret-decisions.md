# T-13 — Interpret the decisions: alternatives per build step, and Ask context for a step

**Type:** feature · **Shop:** repo-tour · **After:** T-12 · **Serves:** VSCode-LLM-Tutorial T-1 (`../VSCode-LLM-Tutorial/.autodev/specs/T-1-build-tutorials-v1.md` §4.3, §5.5) · **Risk:** low
**Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04 (GA-8).

## The ticket's spec (captured, not re-composed)

WHY: even in recreate mode the learner must see 'the author chose X; Y and Z were on the table' — that is the teaching, and it is what makes Mode A and divergence a change of defaults rather than new machinery (VSCode-LLM-Tutorial spec §4.3, §7). Same interpret call, one more ask.

ACs:
1. StopMeaning gains alternatives: Array<{label, consequence}> (2 by default) written in the SAME call as what/why/summary; PROMPT_VERSION bumps so old cache entries are recomputed. Check: the interpret prompt test asserts the field and the version bump.
2. src/build/plan.ts applies interpreted meanings to steps: decision.options becomes the author's option + the alternatives, decision.why = meaning.why with whySource 'interpret'; an uninterpreted step keeps the docstring or 'not inferable' honestly. Check: fixture with a stubbed provider yields options.length === 3.
3. Cost lands on plan.cost with provider, metered flag, tokens and usd — zeros only when metered:false. Check: manifest field test.
4. AskContext gains an optional build block: { question, options, why, learnerDiff } and buildContextBlock renders it under a labelled heading, learner diff clipped like the PR diff. Check: unit test on the rendered block; ASK_PERSONA unchanged.
5. Cached by content hash exactly as stops are — planning a repo already toured pays only for the new prompt version. Check: second run reports cachedStops === interpretedStops of the first.

Out of scope
- Model-written build ORDER — deferred: who=agent:pm why=order is deterministic from the graph (T-12); the model interprets, never orders
- Replanning after divergence — VSCode-LLM-Tutorial T-10

## Refinement notes (2026-09-04, against T-12's actual code)

- **The call already exists.** `src/interpret.ts#interpretStops(root, steps: CodeStep[], files, extracts, edges, opts)`
  groups excerpts per file (one call per file), keys results by `stepKey(file, start, end)` and caches by
  `stopKey(sha, start, end, choice)` — which includes `PROMPT_VERSION`. T-13 feeds it `CodeStep`s built from
  the plan's `symbol` steps (their ranges) and `file` steps (lines 1 … min(loc, 120) — the part of a file that
  says what it owns and imports), then folds the answers back into a NEW plan object (projection doctrine:
  never mutate the input; `buildPlan` output stays pure and free).
- **`StopMeaning` grows `alternatives: Array<{ label; consequence }>`** and `PROMPT_VERSION` goes 5 → 6.
  The SYSTEM prompt asks, in the same call: "two other reasonable ways this could have been done, and what
  each would have cost". `parseAnswer` accepts the field (default `[]` — a model that omits it is not a
  failure, it is a cache entry with no roads-not-taken, and `options.length` stays 1 for that step; AC7's
  "≥ 2" is asserted on the fixture with the stubbed runner, and reported honestly per step otherwise).
- **Shape steps stay `whySource: 'none'` in this ticket.** `interpretArchitecture` writes one brief for the
  whole system, not one per part; mapping it onto chapters is a separate small piece of work — deferred
  with a marker below rather than half-done here.
- **Testability without a model.** `InterpretOptions` gains `runner?: typeof runLlm` (an injectable runner,
  defaulting to the real one) so the suite can feed canned JSON. This is the one edit outside the
  prompt/parse path, and it is the reason `src/interpret.ts` is in T-13's touched set at all.
- **Ask.** `AskContext.build?: { question; options: Array<{ label; consequence; taken }>; why; learnerDiff? }`
  rendered by `buildContextBlock` under `--- THE BUILD STEP ---`, learner diff clipped at 8,000 chars exactly
  like the PR diff. `ASK_PERSONA` is untouched; the extension (VSCode-LLM-Tutorial T-6) is the consumer.
- **CLI.** `plan <path> --interpret [--cached-only] [--provider p] [--model m]` — the `plan` verb T-12 added
  grows the flag; without it, `plan` stays free and deterministic exactly as T-12 shipped it.

## Out of scope (T-13)
- Per-chapter `why` for `shape` steps from `interpretArchitecture` — deferred: who=agent:pm why=the architecture brief is whole-system; per-part mapping is its own small ticket once the walk shows whether shape steps need it
- Replanning after divergence — VSCode-LLM-Tutorial T-10
