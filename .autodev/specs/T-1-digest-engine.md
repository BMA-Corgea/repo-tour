# T-1 — The digest engine

**Type:** feature · **Shop:** repo-tour · **Preset:** solo-builder-review
**Author:** PM (agent) for `human:evan` · **Written:** 2026-08-25
**Gate:** `spec_ready` — Evan approves before any code is written.

---

## 1. Why this exists

repo-tour's product promise is: *point it at a repo, and it walks you through the repo
the way a guided tour walks you through a web page* — with notes that remember which
step provoked them, so a review afterwards is deeper than "looks good to me."

None of that is buildable until something **understands the repo**. This ticket builds
only that: the layer that turns a directory of source into a queryable, current,
hierarchical understanding. Tours are projections of it and come later.

**Explicit non-goal:** this ticket ships no tour, no notes panel, no chatbot. It ships
the thing all three stand on. See §9 for why that split, and what it costs.

## 2. The two layers (the architecture decision this ticket locks)

```
DIGEST   what the code is and how it fits together
         expensive · incremental · cached · long-lived · THIS TICKET
   │
   └─ projected into ─▶  TOUR   one path through it, for one purpose
                               cheap · disposable · pinned to a commit · LATER
```

A tour is **never repaired**. If the code moved, the tour is regenerated from the
digest. This is why the digest must be cheap to keep current — the whole design rests
on regeneration being the default and healing being unnecessary.

Recorded decisions feeding this (Evan, 2026-08-25):
- **Own pages, not a GitHub overlay.**
- **Speed is not a constraint.** Verbatim: *"I'd rather get up and walk around for a few
  minutes while you enable me to understand a repo I would have had no hope of
  understanding before."* Thoroughness beats latency at every fork in this spec.
- **Deterministic extraction preferred** — parsers do the extracting, models interpret.
- **Repo-first, not PR-first.**
- **GUTS is the validation target, after the system works** — not the subject of v1.

## 3. The pipeline

Five stages. Exactly one spends tokens. Ordering is the cost-control mechanism: every
cheap, exact stage runs first and narrows the field, so the expensive stage only reads
what survived.

| # | Stage | Cost | Produces |
|---|-------|------|----------|
| 1 | **Inventory** | free | file set, nested-repo map, classification, content hashes |
| 2 | **Rank** | free | composite score per file |
| 3 | **Extract** | free | symbols, imports, call edges, public surface |
| 4 | **Interpret** | **tokens** | prose meaning, per file and per tier |
| 5 | **Roll up** | free assembly | directory / subsystem / repo digests |

### Stage 1 — Inventory
- Walk the tree. **Every nested `.git` is its own repository** with its own history;
  the parent's git sees none of it. Discovery is structural, not `git ls-files` at root.
- Per file: path, bytes, LOC, language, SHA-256 of content.
- Classify: `source` · `test` · `structural` · `generated` · `vendored` · `data` · `lockfile`.
  Deterministic signals only — `.gitattributes` linguist markers, path patterns
  (`vendor/`, `dist/`, `migrations/`, `reports/`), `@generated` / `DO NOT EDIT` headers,
  lockfile names.
- Skip binaries by null-byte probe.

### Stage 2 — Rank
Composite score per file from three free signals:

- **churn** — `git log --format= --name-only`, per that file's own repo
- **in-degree** — how many modules import it (from stage 3's graph)
- **size** — LOC, weighted *last*

Classification adjusts: `structural` files are boosted, `test` damped, `generated` /
`vendored` / `lockfile` floored to zero.

> **Why the weighting order matters.** A trial scan of GUTS on 2026-08-25 found its five
> largest files are all benchmark output — the biggest at 38,367 lines, one commit, zero
> importers. Its highest-value file is `manifest.yaml` at **96 lines with 134 commits**.
> Ranked by length those two are ~4,000 places apart with the exhaust on top. Length is
> real signal; it just has to be third, or it inverts the answer.

### Stage 3 — Extract
Parsers, never models. A parser cannot invent a function that does not exist.
- **tree-sitter** for symbols, definitions, call sites, public surface.
- Language coverage in v1: **Python, JavaScript, TypeScript** (covers Evan's stack).
  The extractor is an interface — a new language is a new grammar, not a new pipeline.
- Import graph: intra-repo edges, resolved to real files, with in-degree per node.
- **Known limit, stated up front:** services that talk over HTTP contracts rather than
  imports produce almost no edges. The import graph is *a* structure, not *the*
  structure. Cross-service topology is deferred (§9).

### Stage 4 — Interpret (the only paid stage)
Two passes, two price points, using the model routing already in `.claude/settings.json`:
- **Sweep** — `AUTODEV_MODEL_FAST` (`claude-haiku-4-5`), one line per file, every
  non-floored file. Total coverage, negligible cost.
- **Deep** — `AUTODEV_MODEL_STRONG` (`claude-fable-5`), full digest, on the ranked
  slice only (default: top 15% or score ≥ 0.30, whichever is larger).

The model is handed the stage-3 skeleton and asked only what it is genuinely better at:
**what this means and why someone would care.** It is never asked what is in the file.

### Stage 5 — Roll up
Bottom-up, hash-keyed, resumable:

```
files ──▶ directories ──▶ subsystems ──▶ repo
```

Each tier is written **from the tier below, never from source**. Consequences:
- No single step ever needs the whole repo in context — this is the answer to "too big."
- A tour can enter at any altitude: repo ("explain this system"), subsystem ("explain
  how requests get handled"), file ("walk me through this parser").
- Invalidation falls out for free: a tier is stale iff a child is.

## 4. On-disk shape

```
.repo-tour/
  digest.json          manifest: roots, repos, commit SHAs, schema version, drift ledger
  files/<sha256>.json  per-file digest, keyed by CONTENT hash — free rename/revert reuse
  tiers/<path>.json    directory / subsystem / repo digests
  graph.json           import + symbol edges
```

Keying file digests by content hash (not path) means a rename with no edit costs
nothing, and a revert re-uses the digest it had before.

## 5. Incremental re-digest

`git diff --name-status <old>..<new>` drives everything:

| change | action |
|---|---|
| unchanged | reuse — hash matches, free |
| modified | re-run stages 1–4 for that file |
| renamed, same content | carry the digest across |
| deleted | drop, invalidate ancestors |

Cost is proportional to the diff, not the repo.

**The drift budget.** Content hashes catch what changed *inside* a file. They cannot
catch a file whose *meaning* changed because something else moved — a new caller makes
a module load-bearing without editing a byte of it. So each touch-up spends from a
budget; when it is exhausted, the relational layer (tiers + graph, not file digests) is
rebuilt from scratch.

| change class | spend |
|---|---|
| rename a local variable | 1 |
| edit a function body | 2 |
| add / remove a public symbol | 8 |
| add / delete a file | 15 |
| touch a manifest, config or entrypoint | 25 |
| add / delete a directory | 40 |

Budget: 100. Hard triggers that bypass it: any structural-file change, or import-graph
edit distance over threshold.

> **Every number in that table is invented and must not be hard-coded before T-2.**
> They are a starting guess, not a finding. See §7.

## 6. Language and implementation

**Recommendation: Node + TypeScript**, with `web-tree-sitter` (WASM grammars).

- One language across engine and the eventual web UI — no Python/JS seam through the
  middle of the product.
- WASM grammars mean no native toolchain per machine, and the same parser runs in the
  browser later if a tour ever needs to re-parse client-side.
- Trade-off, stated plainly: Evan's other systems (GUTS, GIMS, GONS) are Python, so this
  is the one repo in the estate that would not be. Python + `py-tree-sitter` is a
  legitimate alternative and would match the house stack; it costs a language boundary
  at the UI instead. **This is a real fork and belongs to Evan, not to me.**

## 7. What must be measured before it is fixed (spike, not build)

The drift-budget constants cannot be guessed responsibly. The experiment:

1. Take a real repo with real history.
2. Run incremental digest forward, commit by commit.
3. Force a full re-digest at intervals; diff incremental against full.
4. The divergence *is* the drift. Set thresholds to what the measurement says.

This is a bounded investigation with a finding at the end — a **spike**, filed
separately, run before these constants land. v1 ships with the guesses **behind a
config file**, never inlined.

## 8. Acceptance criteria

Each is independently checkable by Evan at the `accept` gate.

1. **Nested repos are found.** Run against a tree containing nested `.git` directories;
   the digest reports each as its own repo with its own commit count and HEAD. Reporting
   only the parent's tracked files is a failure.
2. **Classification is honest.** Generated, vendored and lockfile content is classified
   as such and floored to score 0. A sample of 20 hand-checked files matches.
3. **Ranking beats length.** On a repo containing both large low-value data files and
   small high-churn structural files, the structural file outranks the data file. Stated
   concretely: on GUTS, `manifest.yaml` ranks above `reports/reader_bench_dev_cap40.json`.
4. **Extraction is exact.** For a fixture file with known symbols and imports, the
   extractor's output matches a hand-written expectation exactly — no missing entries,
   no invented ones.
5. **The rollup holds.** Every directory, subsystem and repo has a digest generated from
   its children, and no tier-generation step is passed raw source.
6. **Incremental works.** Digest at commit A, then at commit B; files unchanged between
   them are reused (proven by a counter in the output), and the result is identical to a
   full digest at B except for the relational layer.
7. **Cost is reported, not hidden.** Every run prints files scanned, files interpreted,
   tokens spent per model tier, and wall clock. A run that spends tokens silently fails
   this criterion.
8. **It is inspectable by a human.** `repo-tour digest <path>` produces a local,
   self-contained HTML view of the digest tree that Evan can open and browse — tiers,
   scores, per-file digests, the graph. This is how he judges quality without reading JSON.
9. **It runs on a repo it has never seen** — a fresh clone of a public repo, no config,
   no prior state, and produces a complete digest.

## 9. Out of scope — and the honest cost of that

Deferred, each to its own ticket, none silently dropped:

| deferred | ticket | why |
|---|---|---|
| tour player over the digest | T-2 | needs a digest to project from |
| notes panel with step provenance | T-3 | the actual product differentiator |
| in-tour chatbot on Evan's subscription | T-4 | needs the digest as its tool surface |
| PR mode — before/after and *why* | T-5 | repo-first was chosen; this follows |
| contract / cross-service graph | T-6 | GUTS-specific topology; deferred with the GUTS work |
| GONS integration | T-7 | `POST /api/events`, operator-secret gated |

> **⚠ The scope tradeoff Evan should weigh at this gate.**
> This ticket ends with a digest and an inspectable HTML view — *useful*, but it is not
> yet the product he described. The alternative is to widen T-1 to include a minimal
> tour player, so v1 ends with something that actually walks him through a repo.
> **My recommendation is to keep T-1 narrow**: the digest is where all the risk lives,
> and shipping a tour on a digest we have not yet judged the quality of means debugging
> two unproven layers at once. But it means one more gate before he sees a tour, and
> that is a real cost, not a rounding error.

## 10. Risks

- **Interpretation quality is unmeasurable by tests.** Criteria 1–7 prove the machinery;
  only Evan reading criterion 8's HTML view proves the digest is any *good*. That
  judgment is the point of the `accept` gate.
- **tree-sitter grammar drift** — grammars version independently; pin them.
- **The import graph may underdeliver on service-shaped repos.** Already true of GUTS
  (124 edges across ~1M lines). v1 must not present a thin graph as a complete one — it
  states its own coverage.
- **Token cost on a large first run is unbounded until measured.** Mitigation: the ranked
  slice is a hard cap with a `--budget` ceiling, and cost is reported (criterion 7).
