# T-3 — release

`main` @ `1eb0cd0` (PR #6). No production service; released means it builds and runs from a
clean `main` — `tsc` clean, 118 tests, and both panels driven live against real PR #3 and the
repo tour. The one new runtime dependency is the same `claude` CLI the digest already uses.
Rollback: `git revert`. Notes live in the reader's browser and are unaffected by one.
