# T-9 — monitor (final)

On `main` @ `872a112`: build clean, 110 tests, PR page served correctly against real PR #3,
building-page poll settles in ~2s, zero temp dirs leaked. No breach, no rollback.

## Follow-ups
- **T-3** — the notes panel. Still what turns a readable PR into a fileable review.
- **T-5 spec §2** is still out of date (describes comparing interpretations; the shipped
  mechanism is direct adjudication). Documentation debt, unticketed.
- **The drift-budget spike** (T-1 §7) — unticketed.
- **PR #3 / `demo-ranking-tweak`** stays open deliberately, as a fixture.

## Live observation, recorded at close

Taken from the running server on `main` @ `872a112`, 2026-08-27:

```
building page  jobKey  "/home/corgea/…/repo-tour#pr-3"
               doneUrl "/pr?path=…&n=3"
/api/job       done after ~2s      (before the fix: never)
PR page        house components present, invented tokens: none
diff           src/rank.ts  lang=ts  +1 −1
               src/rollup.ts lang=ts +38 −0
stop 1 opens   "The MULTIPLIER table previously weighted test-classified files at 0.5…"
temp dirs      0
```

The last two lines are the ones worth watching in future: a stop opening with a number, or a
non-zero temp-dir count, are the two regressions this ticket exists to prevent and both are
cheap to check by eye on any run.
