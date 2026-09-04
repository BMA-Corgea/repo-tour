# T-11 — UAT: is this what the owner MEANT?

**Intent chain:** VSCode-LLM-Tutorial T-1 (Evan, 2026-09-04: *"I do ultimately want this to share a core
with repo-tour. I want it to be part of the same app."*) → its spec §3 "one core, two front ends", §10
"the core must accept injected asset roots… the extension loads it as ESM from node_modules, unbundled".

**Conformance read (agent, uat level auto; accept spent on-behalf under GA-8 — Evan's words: "loop
through it until these are created"):**

| what was meant | what was built | verdict |
| --- | --- | --- |
| the VS Code front end can import the core by name | `exports` map, 14 entries, proven by a subprocess import from outside the repo (`test/consumer.test.ts`) | conforms |
| deep `dist/` paths keep working for a consumer built before this landed | `"./dist/*"` wildcard, tested | conforms |
| the extension can point the core at asset roots of its choosing | `src/assets.ts` three-tier resolution; override proven by mutating a copied assets dir | conforms |
| repo-tour's own app is unchanged | 118 pre-existing tests green; CLI/server untouched (DO-NOT-TOUCH band held) | conforms |
| no new dependency | `dependencies` deep-equal, asserted by test | conforms |

**Fitness in the hands:** the consumer this exists for — the extension's T-2 doctor — resolved 7/7 modules
against the sibling checkout *before* this merged (via the `dist/` fallback); after merge it can take the
subpath route. Nothing here needs Evan's eyes before the extension does; his acceptance is the boot-up of
`start.sh` at the end of the set.

**Gaps:** none against intent. The builder's "surprise" that `./repo-tour doctor` does not exist was wrong
— it lives in the bash control script (`./repo-tour`, `cmd_doctor`), not `src/cli.ts`; no follow-up.
