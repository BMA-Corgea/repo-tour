# T-13 — UAT: is this what the owner MEANT?

**Intent chain:** VSCode-LLM-Tutorial T-1 → spec §4.3 ("even in recreate mode the learner sees *the author
chose X; Y and Z were on the table* — that is the teaching") and §5.5 (the tutor sees the step and the
learner-vs-author diff). Evan's constraint: the other modes must be a change of defaults, not new machinery.

**Conformance read (agent, uat level auto; accept spent on-behalf under GA-8):**

| what was meant | what was built | verdict |
| --- | --- | --- |
| alternatives ride in the same interpret call, cached like everything else | `StopMeaning.alternatives`, `PROMPT_VERSION` 6, content-hash cache proven by a zero-call second run | conforms |
| options ≥ 2 once interpreted; the author's marked; why from the model with its source named | fold → `[author, alt-1, alt-2]`, `whySource: 'interpret'`; honest fallback keeps the docstring/none | conforms |
| cost reported honestly | `plan.cost` from the interpret result, `metered:false` printed as "does not report usage" | conforms |
| the tutor can see the step | `AskContext.build` rendered under its own heading with the learner diff clipped like the PR diff; persona byte-identical | conforms |
| free by default | `plan` without `--interpret` is exactly T-12's deterministic run | conforms |

**Fitness in the hands:** the live interpretation of sql-gauntlet is the extension's acceptance run (T-3),
where the cost and the alternatives are read by a person; shape steps stay `whySource: 'none'` by design
(deferred with a marker in the spec).

**Gaps:** none against intent. The builder wrote the write-ahead note in the same session as the bump rather
than as a separately landed commit — ordered correctly in history, no cache was at risk; noted, not a finding.
