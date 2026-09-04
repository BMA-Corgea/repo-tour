# T-11 — Expose the core as a consumable package — for the VS Code front end

**Type:** feature · **Shop:** repo-tour · **Serves:** VSCode-LLM-Tutorial T-1 (`../VSCode-LLM-Tutorial/.autodev/specs/T-1-build-tutorials-v1.md` §3, §10) · **Risk:** low
**Gate:** spec_ready — spent by Evan's in-session go-ahead of 2026-09-04.

## The ticket's spec (captured, not re-composed)

WHY: VSCode-LLM-Tutorial (github.com/BMA-Corgea/VSCode-LLM-Tutorial) is the second front end on this core — Evan: 'I want it to be part of the same app.' Its extension host imports the digest, interpret, llm, ask and skins modules directly (VSCode-LLM-Tutorial spec §3, .autodev/specs/T-1-build-tutorials-v1.md in that repo). Today package.json is private:true with no exports map, dist/ is gitignored, and two modules locate assets only via import.meta.url: src/skins.ts skinsDir() and src/extract.ts grammarPath().

ACs:
1. package.json carries an exports map naming the public modules: ./digest ./interpret ./llm ./ask ./skins ./extract ./types ./rollup ./architecture ./codetour ./build (the last lands with T-12; export the path now). Check: node -e import() of each from a directory outside the repo resolves.
2. Asset roots are injectable: skinsDir and grammarPath accept an override (an options argument or REPO_TOUR_ASSETS / REPO_TOUR_GRAMMARS env) and fall back to the import.meta.url resolution. Check: a test loads skins and a grammar from a copied assets dir with the override set.
3. A prepare script builds dist/ on install, so a file: or git dependency works without a manual build. Check: npm install from a consumer directory using file:../repo-tour yields dist/.
4. A consumer smoke test (test/consumer.test.ts) imports from the package name, runs digest on a fixture, reads baseCss(), and asserts alternateCss() includes gunmetal. Check: vitest run.
5. The web app and CLI are unchanged in behaviour. Check: the existing suite passes; ./repo-tour doctor still finds its grammars with no override set.
6. No new runtime dependency. Check: package.json dependencies unchanged.

Out of scope
- Publishing to npm — deferred: who=human:evan why=a public artifact is not v1; file: serves his machine
- Bundling the core into the extension — deferred: who=agent:pm why=the extension loads the core as ESM from node_modules (VSCode-LLM-Tutorial spec §10)

## Refinement notes (2026-09-04)

- **An exports map RESTRICTS deep imports.** Today `repo-tour/dist/skins.js` resolves because there is no
  map; adding one would break that path for any consumer built before this lands (the extension's
  T-2 falls back to `dist/` paths). So the map also exports `"./dist/*": "./dist/*"`. AC1's check includes it.
- **`prepare` and `file:` links.** npm does not run `prepare` for a `file:` link; it runs for a git
  dependency and for `npm pack`. AC3's check uses `npm pack` + install from the tarball in a temp dir,
  which is what a git dependency would exercise; the `file:` case relies on `dist/` being built, and the
  README says so in one line.
- `private: true` stays — a `file:`/git dependency does not need it removed; publishing is deferred.
