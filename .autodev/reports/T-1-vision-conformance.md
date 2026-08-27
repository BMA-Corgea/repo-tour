# T-1 — vision conformance at acceptance

**Recorded:** 2026-08-27 · **Stage:** uat · **Gate:** `accept` cleared
**Accepted by:** human:evan, recorded as GA-3, cleared by `agent:claude(on-behalf:evan,GA-3)`
**Question this answers:** not "does it match the spec" but "does it match the INTENT?"

## The intent it is measured against

There is no Direction artifact (`links.intent` is empty); T-1 predates one. The intent
of record is Evan's own statement of the product, captured at onboarding (2026-08-25/26,
`.autodev/onboarding.json` transcript):

> *"Take a repo, digest/understand it, and deliver a guided TOUR of it… Side panel for
> notes, each note carrying metadata for WHICH TOUR STEP inspired it… Chatbot during the
> tour… Must also work on PRs… Endgame: integrate into GONS."*

Six pieces. **T-1 was deliberately scoped to the first one only** — the digest — on the
recorded reasoning that all the risk lives there and shipping a tour on an unjudged
digest means debugging two unproven layers at once (T-1 spec §9).

## Conformance

| vision piece | state | where |
|---|---|---|
| digest / understand a repo | **shipped** — T-1 | 32 tests green, cold run on GUTS: 8 repos, 11,959 files |
| guided tour of the repo | **shipped early, outside T-1's spec** | see the scope addition below |
| notes panel with step provenance | deferred | T-3 |
| in-tour chatbot | deferred | T-4 |
| PR mode | **in build** | T-5 (spec accepted 2026-08-27) |
| GONS integration | deferred | T-7 |

**Verdict: conformant.** T-1 delivered what T-1 was scoped to deliver, and the acceptance
question was answered against the real product surface rather than a metrics page —
Evan read an actual tour of actual code before saying yes.

## Reconciliation delta — the one scope movement, stated not buried

T-1's spec deferred the tour player to T-2. It was **built early**, on 2026-08-26, after
Evan rejected the first demo ("there's no code on the screen"). This is a scope
**addition**, not drift: it cost a renderer rather than a new subsystem, because a tour
is a projection of the digest and the digest already existed.

The honest consequence: T-2's original scope is now largely consumed by work that landed
under T-1's number. Anyone reading the T-1 spec's §9 table should read this note beside
it — the row "tour player over the digest | T-2" was satisfied ahead of its ticket.

## Acceptance context worth keeping

- The accept gate did its job. The first demo was **rejected** at this same gate for
  showing the ranking rubric instead of the repo — score, churn and in-degree are how the
  engine decides what to show, not what a reader wants. That rejection produced the
  product's actual surface.
- The lesson already recorded in `kb/wiki/lessons.md`: a tool that writes into the tree it
  reads must exclude its own output, and one run will never show you the bug.
