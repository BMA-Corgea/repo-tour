# T-15 — UAT: is this what the owner MEANT?

**Intent chain:** T-12 → VSCode-LLM-Tutorial T-1 §4.1/§4.5 ("the load-bearing parts of a file" — the
ranges the dial scaffolds) and §13 (sql-gauntlet is the first live target). Evan's product thesis: "your
hands on the line the decision was about" — which requires that line to exist for every source file.

**Conformance read (agent, uat level auto; accept spent on-behalf under GA-9 — Evan's standing
"loop through it until these are created", this being a blocker found inside that loop):**

| what was meant | what was built | verdict |
| --- | --- | --- |
| every source file has load-bearing ranges to scaffold | IIFE bodies now visible to extract; exported-or-all candidate fallback; triviality filter keeps `const fs = require()` out | conforms |
| the first live target is walkable | sql-gauntlet: 35 symbol steps across all 7 named-function JS files (each at the cap of 5) | conforms |
| nothing else changes | T-12's 49-test suite byte-unchanged; Python and ESM/TS behaviour untouched; existing fixture plans identical (snapshot) | conforms |

**Gaps:** none against intent. CommonJS `module.exports` recognition stays deferred (ranking nicety, not
a blocker).
