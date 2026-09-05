# T-15 - Script-style JS yields no load-bearing ranges

**Type:** bug · **Shop:** repo-tour · **Intent:** T-12 · **Risk:** medium
**Gate:** spec_ready - spent by Evan's standing go-ahead of 2026-09-04 (GA-9); this is a blocker found inside the loop he asked for.

## The ticket's spec (captured)

SYMPTOM (found 2026-09-04 running 'repo-tour plan' on the first live target, sql-gauntlet): 26 steps, ZERO symbol steps. Every public/*.js file is wrapped in an IIFE '(function () { ... })()' and extract records 0 symbols for it; server.js and tools/*.js have 19/18/8 top-level symbols but none are 'exported' (plain scripts / CommonJS), so plan.ts finds no candidates. Result: no scaffold ranges, so the dial (VSCode-LLM-Tutorial T-5) would have nothing to stub on the very repo the product is accepted against. Spec §4.1/§4.5 assume 'the load-bearing parts of a file' exist for every source file.

ACs:
1. extract: the direct declarations inside a TOP-LEVEL IIFE body (a top-level expression statement calling a function expression or arrow, including the '(function(){...})()' and '(() => {...})()' forms and '!function(){}()' ) are recorded as symbols with their real ranges, exported:false. Non-IIFE nested functions stay unrecorded as today. Check: a fixture of sql-gauntlet's shape yields the IIFE's named functions; a plain nested helper inside a normal function is still absent.
2. plan: symbol-step candidates are the exported symbols; when a file exports nothing, candidates are its recorded symbols instead. In both cases a candidate must be a function/method/class, or a variable spanning >= 3 lines — a one-line 'const fs = require(..)' or an import alias never becomes a step. Cap 5 by span with overlap-skip as today. Check: server.js-shaped fixture gets symbol steps for its handlers and none for its requires.
3. Running 'plan' on sql-gauntlet gives >= 1 symbol step for every .js file that defines a named function (public/app.js, chat.js, engine.js, xray.js, server.js, tools/*). Check: run it and count.
4. The nothing-vanishes invariant, id stability, and every existing test stay green; the T-12 review fixtures unchanged. Check: full suite.
5. No change to interpret.ts, ask.ts, cli.ts, build/interpret.ts (T-13 is editing them in parallel); new tests live in test/build-scripts.test.ts, not in test/build.test.ts.

Out of scope
- Recognising CommonJS 'module.exports'/'exports.x' as exported — deferred: who=agent:pm why=the exported-or-all fallback already yields the right steps; marking CJS exports is a nicety for ranking, not a blocker
- Python and TS/ESM behaviour — unchanged by design

## Refinement notes (2026-09-04)

- Evidence from the live run: for public/app.js, chat.js, engine.js, xray.js and every public/data/*.js the digest's extract has 0 symbols (all code sits inside an IIFE); server.js has 19 symbols / 0 exported, tools/validate.js 18 / 0, tools/xray-test.js 8 / 0. The plan produced 5 shape + 21 file steps and no symbol steps.
- Repro-test-first (bug lane): write the failing tests (an IIFE fixture yielding no symbols; a CJS fixture yielding no symbol steps) and COMMIT THEM RED before the fix.
- extract.ts is the walker T-11 already touched (only grammarPath then); this ticket touches its symbol walk. plan.ts is T-12's candidate selection. Neither file is in T-13's touched set, so the two tickets run in parallel from the same base (main a8828e5).
