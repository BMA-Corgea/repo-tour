# T-8 — release record

`main` @ `0a29fe6` (PR #4), plus the test-litter fix. No production service — same as T-1
and T-5: "released" means it builds and runs from a clean `main`. Verified: `tsc` clean,
**99/99** tests, and the click-path driven end to end against real PR #3 in a running server.

Rollback: `git revert`. The one new persistent artifact is the adjudicator verdict cache,
already present from T-5 and disposable.
