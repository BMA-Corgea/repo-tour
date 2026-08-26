# Decision — repo-tour is built in Node + TypeScript

**Decided:** 2026-08-26 · **By:** human:evan, in session, on the PM's recommendation
**Status:** locked for T-1 and everything downstream
**Ticket:** T-1 (digest engine) · spec §6

## The decision

The digest engine — and the tour UI it feeds — are written in **Node + TypeScript**,
parsing with **`web-tree-sitter`** (WASM grammars).

Evan's words: *"Let's go with the recommendation for node."*

## Why

- **One language across the seam.** The digest engine and the tour player talk to each
  other constantly. A Python engine feeding a JS UI puts a serialization boundary through
  the middle of the product; Node removes it.
- **WASM grammars need no native toolchain.** No per-machine compiler setup, and the same
  parser can run in the browser later if a tour ever needs to re-parse client-side.

## What it costs, stated plainly

This is the **only non-Python repo in Evan's estate** — GUTS, GIMS and GONS are all
Python. Consequences to expect:

- No shared libraries with the rest of the estate. repo-tour reads other repos as *data*,
  never by importing their code, so this costs nothing today.
- The **GONS integration (T-7)** crosses the boundary. It was always going to be an HTTP
  call (`POST /api/events`, operator-secret gated), so the boundary is at the wire, which
  is where it belongs — not a new problem this decision created.
- Tooling muscle memory (pytest → vitest, ruff → eslint) does not carry over.

## The alternative that was rejected

Python + `py-tree-sitter`. Legitimate, and it would have matched the house stack. It was
rejected because it moves the language boundary from the wire (where it is cheap) to the
engine/UI seam (where it is crossed constantly).

## Related

- Ranking must weight LOC third — see the GUTS trial-scan finding in T-1 spec §2/§3.
- The drift-budget constants in spec §5 are invented and ship behind config until a spike
  measures them. Do not let this decision's confidence bleed into those numbers.
