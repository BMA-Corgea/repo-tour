# T-1 — Location report

**Stage:** `locate` · **Written:** 2026-08-26 · **By:** agent:planner
**Purpose:** name every file, entry point and call path this ticket touches, so `build`
never has to re-explore the repo.

Greenfield ticket: nothing existed before it, so this report defines the layout rather
than discovering it. Language fixed to Node + TypeScript by `human:evan` on 2026-08-26
(`kb/wiki/decision-implementation-language.md`).

## Entry points

| Entry point | File | Reached by |
| --- | --- | --- |
| `repo-tour digest <path>` | `src/cli.ts` → `main()` | the human, and acceptance criterion 8 |
| `digest(root, opts)` | `src/digest.ts` | the CLI, the tests, and later the tour builder |

`package.json` maps the `repo-tour` bin to `dist/cli.js`; `npm run dev` runs `src/cli.ts`
through `tsx` without a build step.

## Target files and what each owns

| File | Stage | Owns |
| --- | --- | --- |
| `src/types.ts` | — | every shape crossing a stage boundary; no logic |
| `src/inventory.ts` | 1 | tree walk, nested-repo discovery, hashing, classification |
| `src/rank.ts` | 2 | churn per own-repo, normalization, composite score, deep-slice cut |
| `src/extract.ts` | 3 | tree-sitter parsers, symbols, imports, resolution, import graph |
| `src/digest.ts` | driver | runs 1→3, assembles the manifest, writes the on-disk cache |
| `src/cli.ts` | driver | argument parsing and the human-readable report |
| `test/pipeline.test.ts` | — | acceptance criteria 1, 2, 3, 4, 6, 7 against live git fixtures |

## Call path

```
cli.main()
  └─ digest(root)
       ├─ inventory(root)              stage 1 — free, exact
       │    ├─ walk()                  recursive; registers a repo at every .git
       │    ├─ gitFacts(repoAbs)       HEAD, branch, commit count, per repo
       │    ├─ readGitAttributes()     linguist-generated / linguist-vendored
       │    └─ classify()              deterministic signals only
       ├─ extract(root, files)         stage 3 — runs BEFORE rank
       │    ├─ initParsers()           web-tree-sitter + pinned wasm grammars
       │    ├─ pythonSymbols/Imports   or jsSymbols/jsImports
       │    ├─ resolveImport()         intra-repo resolution, null when it leaves
       │    └─ builds ImportGraph      edges + inDegree + self-stated coverage
       └─ rank(root, files, repos, graph)   stage 2 — needs stage 3's in-degree
            ├─ churnByFile()           one `git log` per repo root
            ├─ normalizer()            log1p, then divide by max
            └─ MULTIPLIER[class]       floors generated/vendored/lockfile to 0
```

**Ordering note that matters:** stage 2 is *numbered* before stage 3 in the spec but must
*run* after it, because the in-degree signal is a product of the import graph. `digest.ts`
calls `extract` then `rank`, and reports timings under each stage's own name.

## Dependencies pinned

- `web-tree-sitter@0.25.10` — API used: `Parser.init`, `Language.load`, `parser.parse`,
  `node.childForFieldName`, `node.startPosition/endPosition`, `tree.delete`.
- `tree-sitter-wasms@0.1.12` — grammars for `python`, `javascript`, `typescript`, `tsx`,
  resolved through `require.resolve` so the version is pinned by the lockfile (spec §10,
  grammar drift).

## Out of this ticket's reach

`src/interpret.ts` (stage 4) and `src/rollup.ts` (stage 5) are named here so the seams are
visible, but neither is written. `digest.ts` reports them under `stagesNotBuilt` rather
than omitting them, so no reader mistakes a stage-3 result for a complete digest.
