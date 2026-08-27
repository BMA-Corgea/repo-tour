# T-1 — monitor record (final stage)

**Recorded:** 2026-08-27 · **Stage:** monitor · **Contract:** rollout window without breach

## What "rollout" means here — and what it does not

There is **no deployed surface to watch**. No error rate, no latency, no usage telemetry,
because there is no service — repo-tour is a local CLI (see the release record for why:
the in-tour chatbot runs on Evan's subscription, which pins the product to his machine).

Recording a green rollout window against infrastructure that does not exist would be the
board-lying failure in miniature. So this stage is satisfied by the only honest observable
available: **does the shipped tool still work, on real repositories, today?**

## Checked on `main` @ `1783b85`, 2026-08-27

| observable | result |
|---|---|
| `npm run build` (tsc) | clean |
| `npm test` | **64/64 passing** |
| `./repo-tour doctor` | ✓ ready — node v22.22.2, git 2.43.0, web-tree-sitter, 4 parser grammars (python, javascript, typescript, tsx) |
| real-repo exercise (recorded at verify) | cold run on GUTS: 8 repos, 11,959 files, 1,846 tiers, never seen before |
| incremental (recorded at verify) | 3 consecutive runs on this repo: 100% reuse on no-change, 97% on 1 edit + 1 rename |

**No breach. No rollback. No incident filed.**

## Follow-ups, filed rather than carried

- **T-5** — PR mode, spec accepted 2026-08-27, in build now.
- **T-3 / T-4 / T-7** — notes panel, in-tour chatbot, GONS integration: still deferred,
  still on the record in the T-1 spec §9 table.
- **The deferred drift-budget spike** (T-1 §7) — the incremental constants are still
  guesses in config, never inlined. T-5 is their first heavy consumer, which makes the
  spike more urgent, not less. Not yet ticketed.
