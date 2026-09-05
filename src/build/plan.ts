/**
 * digest → BuildPlan — the ordered decision list VSCode-LLM-Tutorial walks a learner
 * through (spec §2, §4). Like `src/tour.ts`, this is a PROJECTION: everything below reads
 * digest data that already exists (architecture, the import graph, extracted symbols, git
 * history) and computes an order from it. Nothing here parses a file, calls a model, or
 * remembers anything between runs — regenerating a plan costs exactly what generating it
 * cost the first time, which is nothing.
 *
 * The shape of the work, in the order it happens below:
 *
 *   1. CHAPTERS  — architecture parts, ordered bottom-up (foundations first), with a
 *      fallback to raw subsystem tiers when architecture collapses to fewer than two
 *      parts (a real risk on a small repo — see the write-ahead handoff for this ticket).
 *   2. OWNERSHIP — every file assigned to a chapter by longest matching path prefix,
 *      exactly `architecture.ts`'s own rule, plus a synthetic `@misc` chapter (mirroring
 *      `codetour.ts`'s `@end`) for anything no chapter claims, so nothing a classification
 *      says should become a step is ever silently dropped.
 *   3. FILE ORDER — topological within each chapter (leaves first: you build what you
 *      import before what imports it), test files spliced in right after the file they
 *      name.
 *   4. STEPS — one `shape` per chapter, one `file` and up to five `symbol` steps per file,
 *      each a decision with the author's own choice as its only option (T-13 adds the
 *      roads not taken).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildArchitecture } from '../architecture.js';
import type { InterpretCost } from '../interpret.js';
import type { DigestResult } from '../digest.js';
import type { TierDigest } from '../rollup.js';
import type { FileExtract, FileRecord, ImportGraph, SymbolKind, SymbolRecord } from '../types.js';
import { firstCommits, NULL_WITNESS, type Witness } from './witness.js';
import type { BuildPlan, Chapter, Option, Range, Step, StepKind } from './types.js';

/** The synthetic trailing chapter for files no named part claims. See the file header. */
const MISC_KEY = '@misc';

const SYMBOL_CAP = 5;

export interface BuildPlanOptions {
  /** the absolute scan root — `BuildPlan.source.root`, and where git ran for the digest */
  root: string;
  /** compute git witnesses (default true); false skips the git walk entirely and every step's witness is null */
  witness?: boolean;
}

// -------------------------------------------------------------- generic ordering

/**
 * Kahn's algorithm, dependencies first: a node is placeable once every node it points TO
 * (its own outgoing edges, restricted to `nodes`) is already placed. A "leaf" — imports
 * nothing else in the set — is placeable immediately, which is exactly "leaves first"
 * (spec §4.1). Ties within one simultaneously-ready wave are broken by `tiebreak`.
 *
 * One function serves two granularities in this file: chapters ordered by the part-level
 * import rollup, and files ordered by the file-level import graph restricted to one
 * chapter. Both are "build what you depend on before what depends on it."
 *
 * A cycle (real for files: two modules can import each other) is broken at whichever
 * remaining node has the fewest unmet dependencies, path as the final tiebreak — arbitrary
 * but deterministic, and it never blocks forward progress.
 */
function dependencyOrder(
  nodes: string[],
  edgesWithin: Array<{ from: string; to: string }>,
  tiebreak: (a: string, b: string) => number,
): string[] {
  const set = new Set(nodes);
  const deps = new Map<string, Set<string>>();
  for (const n of nodes) deps.set(n, new Set());
  for (const e of edgesWithin) {
    if (e.from === e.to) continue;
    if (set.has(e.from) && set.has(e.to)) deps.get(e.from)!.add(e.to);
  }

  const placed = new Set<string>();
  const order: string[] = [];
  let remaining = nodes.slice();

  while (remaining.length > 0) {
    let wave = remaining.filter((n) => [...deps.get(n)!].every((d) => placed.has(d)));

    if (wave.length === 0) {
      let best = remaining[0]!;
      let bestUnmet = Infinity;
      for (const n of remaining) {
        const unmet = [...deps.get(n)!].filter((d) => !placed.has(d)).length;
        if (unmet < bestUnmet || (unmet === bestUnmet && n < best)) { best = n; bestUnmet = unmet; }
      }
      wave = [best];
    }

    wave = wave.slice().sort(tiebreak);
    for (const n of wave) { placed.add(n); order.push(n); }
    remaining = remaining.filter((n) => !placed.has(n));
  }

  return order;
}

/** Roll file-level edges up to chapter level: an edge survives iff it crosses chapters. */
function chapterEdges(
  fileEdges: ImportGraph['edges'],
  ownerOf: (p: string) => string | null,
): Array<{ from: string; to: string }> {
  const seen = new Set<string>();
  const out: Array<{ from: string; to: string }> = [];
  for (const e of fileEdges) {
    const a = ownerOf(e.from);
    const b = ownerOf(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a} ${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: a, to: b });
  }
  return out;
}

// -------------------------------------------------------------- chapter seeds

interface ChapterSeed {
  path: string;
  title: string;
  fileCount: number;
  loc: number;
  score: number;
}

function shortName(tierPath: string): string {
  const segs = tierPath.split('/').filter(Boolean);
  return segs.slice(-2).join('/') || '(repo root)';
}

/**
 * Primary source: the architecture layer's chosen parts (`architecture.ts`). This is
 * "chapters come from the architecture layer, not raw tiers" — a tour, or a build, made
 * only of files teaches you files, not a system.
 */
function architectureSeeds(arch: ReturnType<typeof buildArchitecture>): ChapterSeed[] {
  return arch.subsystems.map((s) => ({
    path: s.path, title: shortName(s.path), fileCount: s.fileCount, loc: s.loc, score: s.score,
  }));
}

/**
 * Fallback source: EVERY subsystem-kind tier, not just the ones `chooseSubsystems` judged
 * big enough to be an architecture "part". Used only when architecture collapses to fewer
 * than two parts — exactly AC1's original wording ("chapters come from subsystem tiers"),
 * kept alive for the case the refinement notes flagged as real on a small repo.
 *
 * `t.path !== ''` mirrors `chooseSubsystems`'s own explicit exclusion of the scan root —
 * needed here too because `rollup.ts#kindFor` cannot tell "the scan root" from "an ordinary
 * subsystem" when NO repo was found anywhere in the tree (no `RepoRef` means `isRepoRoot`
 * is false even for the root), and mislabels the root `kind: 'subsystem'` in that case.
 * Without the guard a no-git fixture grows a phantom chapter that owns no file directly
 * (`ownerOf`'s longest-prefix match always prefers the real subsystem beneath it) but
 * still gets a `shape` step from nothing — caught by the fallback fixture test.
 */
function tierSeeds(tiers: TierDigest[]): ChapterSeed[] {
  return tiers
    .filter((t) => t.kind === 'subsystem' && t.path !== '')
    .map((t) => ({ path: t.path, title: shortName(t.path), fileCount: t.fileCount, loc: t.loc, score: t.score }));
}

function chapterSubtitle(fileCount: number, loc: number): string {
  return `${fileCount} file${fileCount === 1 ? '' : 's'} · ${loc.toLocaleString()} line${loc === 1 ? '' : 's'}`;
}

// -------------------------------------------------------------- test-file placement

/**
 * The basename a test file is testing, by stripping its own marker — spec §4.1's list,
 * read off `inventory.ts`'s own `looksLikeTest` patterns so the two never drift apart.
 * A test with no name marker at all (just living under `test/`/`tests/`) falls through
 * unchanged: it is matched by plain basename against its chapter's other files.
 */
function subjectBasename(base: string): string {
  let m = /^(.+)\.(test|spec)\.([^.]+)$/.exec(base);
  if (m) return `${m[1]}.${m[3]}`;
  m = /^test_(.+\.(?:py|rb))$/.exec(base);
  if (m) return m[1]!;
  m = /^(.+)_test\.(py|go|rb|ts|js)$/.exec(base);
  if (m) return `${m[1]}.${m[2]}`;
  return base;
}

/** Insert each test file immediately after the file it names; unmatched tests go last. */
function spliceTests(order: string[], tests: string[]): string[] {
  const result = order.slice();
  for (const t of tests.slice().sort()) {
    const subj = subjectBasename(path.posix.basename(t));
    const idx = result.findIndex((p) => path.posix.basename(p) === subj);
    if (idx === -1) result.push(t);
    else result.splice(idx + 1, 0, t);
  }
  return result;
}

// -------------------------------------------------------------- ranges

/** Everything in `[1, loc]` NOT covered by `ranges` — assumes nothing calls this with overlaps. */
function complement(ranges: Range[], loc: number): Range[] {
  if (loc <= 0) return [];
  const sorted = ranges.slice().sort((a, b) => a.startLine - b.startLine);
  const out: Range[] = [];
  let cursor = 1;
  for (const r of sorted) {
    if (r.startLine > cursor) out.push({ startLine: cursor, endLine: r.startLine - 1 });
    cursor = Math.max(cursor, r.endLine + 1);
  }
  if (cursor <= loc) out.push({ startLine: cursor, endLine: loc });
  return out;
}

/** The minimum span, in lines, a `variable`/`type` needs before it can earn its own step. */
const TRIVIAL_SPAN = 3;

/**
 * The kinds whose recorded span is always their own body/declaration rather than a
 * reference to something defined elsewhere — load-bearing at any size. `variable` and
 * `type` are the only kinds left out, and they are the only ones a one-line alias can
 * ever be.
 */
const ALWAYS_ELIGIBLE = new Set<SymbolKind>(['function', 'method', 'class', 'interface', 'enum']);

/**
 * The FALLBACK path's screen, and ONLY that path's — see `selectLoadBearing`. Once "this
 * file exports nothing" makes every recorded symbol a candidate, the file's own imports
 * become candidates too: a one-line `const fs = require('fs')` or an import alias is a
 * reference, not code a learner could fill in, and must never take a slot from a real
 * function. So on that path a `variable`/`type` earns a step only when its own span is
 * real code — a multi-line config object (T-15's `server.js`-shaped fixture) or a
 * structural type literal, never a one-liner.
 *
 * Deliberately NOT applied to the exported path (T-15 review, 2026-09-04): a file that
 * exports something keeps exactly the candidates T-12 shipped — every exported symbol, any
 * kind, any span — so a types-only module keeps its `interface`/`type`/`enum` steps and a
 * one-line exported `const` keeps its step.
 */
function isEligibleCandidate(s: SymbolRecord): boolean {
  return ALWAYS_ELIGIBLE.has(s.kind) || s.endLine - s.line + 1 >= TRIVIAL_SPAN;
}

/**
 * The symbols worth a step: biggest span first, capped at five, then restored to file
 * order for presentation. Overlapping candidates are skipped once a bigger one is taken —
 * `extract.ts` marks a class's public methods `exported` whenever the class is, so a class
 * and its own methods can both be candidates, and their ranges nest. The class (bigger
 * span, sorts first) wins the slot; its members are treated as subsumed by that same step
 * rather than double-stubbed.
 *
 * Candidates are the file's exported symbols, unfiltered — exactly what T-12 shipped —
 * UNLESS the file exports nothing at all (T-15: a plain script or a CommonJS module has no
 * ESM `export`, but its top-level functions are still exactly what a learner needs
 * stubbed), in which case every recorded symbol is a candidate instead, screened by
 * `isEligibleCandidate`. The screen belongs to that fallback alone: it exists to stop the
 * one-line requires and aliases the fallback itself made eligible, so a file that DOES
 * export something is untouched by this ticket, in every language.
 */
function selectLoadBearing(symbols: SymbolRecord[]): SymbolRecord[] {
  const exported = symbols.filter((s) => s.exported);
  const candidates = exported.length > 0 ? exported : symbols.filter(isEligibleCandidate);
  const bySpanDesc = candidates
    .slice()
    .sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line) || a.line - b.line);

  const chosen: SymbolRecord[] = [];
  for (const s of bySpanDesc) {
    if (chosen.length >= SYMBOL_CAP) break;
    if (chosen.some((c) => s.line <= c.endLine && s.endLine >= c.line)) continue;
    chosen.push(s);
  }
  return chosen.sort((a, b) => a.line - b.line);
}

// -------------------------------------------------------------- decision text

/** At most `max` items, comma-joined, with an honest "and N more" rather than a silent cut. */
function listPhrase(items: string[], max = 4): string {
  if (items.length === 0) return 'nothing';
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

function fileDecisionText(ex: FileExtract | undefined): { question: string; consequence: string } {
  if (!ex) {
    return {
      question: 'Why does this file exist on its own, as this kind of file?',
      consequence: 'Not parsed by the shipped grammars, so its exports and imports are not visible here.',
    };
  }
  const exports = ex.symbols.filter((s) => s.exported).map((s) => s.name);
  const imports = ex.imports.map((i) => i.raw);
  return {
    question:
      `This module exports ${listPhrase(exports)} and imports ${listPhrase(imports)} — ` +
      `why does this get its own module?`,
    consequence:
      `Owns ${exports.length} exported symbol${exports.length === 1 ? '' : 's'} and depends on ` +
      `${imports.length} import${imports.length === 1 ? '' : 's'}.`,
  };
}

function symbolDecisionText(sym: SymbolRecord): { question: string; consequence: string } {
  const span = sym.endLine - sym.line + 1;
  return {
    question: `Fill in ${sym.name} — how should this ${sym.kind} do its job?`,
    consequence: `${sym.name} is ${span} line${span === 1 ? '' : 's'} of ${sym.kind}, load-bearing in this file.`,
  };
}

function shapeDecisionText(title: string, fileCount: number, loc: number): { question: string; consequence: string } {
  return {
    question: `Why does ${title} exist as its own part, rather than living inside another one?`,
    consequence:
      `${title} becomes its own chapter: ${fileCount} file${fileCount === 1 ? '' : 's'}, ` +
      `${loc.toLocaleString()} line${loc === 1 ? '' : 's'}.`,
  };
}

/** The only option a `recreate`-mode plan can populate: what the author actually did. */
function authorOnlyDecision(
  question: string, consequence: string, why: string, whySource: Step['decision']['whySource'],
): Step['decision'] {
  const options: Option[] = [{ id: 'author', label: 'What the author did', consequence, taken: true }];
  return { question, options, authorChoice: 'author', chosen: 'author', why, whySource };
}

/** `sha256(file + ' ' + kind + ' ' + symbolName)`, first 16 hex — refinement notes, 2026-09-04. */
function stepId(file: string, kind: StepKind, symbolName: string): string {
  return createHash('sha256').update(`${file} ${kind} ${symbolName}`).digest('hex').slice(0, 16);
}

/**
 * The recipe above, plus the one property it cannot give on its own: uniqueness.
 *
 * Two distinct symbols can legally share a name inside one file — a Python top-level
 * `def f` redefined further down, a conditionally-defined function under
 * `if TYPE_CHECKING` — and neither overlaps the other, so `selectLoadBearing` keeps both
 * and both become steps. The recipe hashes only (file, kind, name), so both would hash to
 * the SAME id, and an id is a key everywhere else in this model: `dependsOn` points at
 * one, `fileStepId`/`shapeStepId` are maps of them, and a consumer's TreeView keys on
 * one. A duplicate id is not a cosmetic clash, it is a broken foreign key.
 *
 * So: the n-th LATER occurrence of the same (file, kind, name) — n counted from 1, in
 * the order steps are emitted, which for symbols is the file's own line order — hashes
 * `… + ' #' + n` instead. The FIRST occurrence is left exactly as the recipe says, so
 * every id a collision-free file already had is byte-identical to what it was before this
 * disambiguation existed. A body edit still cannot move an id: it changes neither the
 * file, the kind, the name, nor which occurrence within the file a symbol is.
 */
function stepIdMinter(): (file: string, kind: StepKind, symbolName: string) => string {
  const seen = new Map<string, number>();
  return (file, kind, symbolName) => {
    const key = `${file} ${kind} ${symbolName}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return stepId(file, kind, n === 0 ? symbolName : `${symbolName} #${n}`);
  };
}

function sumLoc(paths: string[], fileByPath: Map<string, FileRecord>): number {
  return paths.reduce((sum, p) => sum + Math.max(0, fileByPath.get(p)?.loc ?? 0), 0);
}

// -------------------------------------------------------------- the driver

export async function buildPlan(digest: DigestResult, opts: BuildPlanOptions): Promise<BuildPlan> {
  const witnessMap: Map<string, Witness> =
    opts.witness === false ? new Map() : firstCommits(digest.manifest.repos);

  const arch = buildArchitecture(digest);
  const rawSeeds: ChapterSeed[] =
    arch.subsystems.length >= 2 ? architectureSeeds(arch) : tierSeeds(digest.tiers);

  const roots = rawSeeds.map((s) => s.path).sort((a, b) => b.length - a.length);
  const ownerOf = (p: string): string | null => roots.find((r) => p === r || p.startsWith(`${r}/`)) ?? null;

  // ---- 1. bucket every file. There are exactly TWO destinations and every inventoried
  // file reaches one of them: taught (it gets a step) or reproduced (`plan.reproduce`).
  //
  //   source, structural -> steps
  //   test               -> steps, spliced in after the file they name
  //   generated, vendored, lockfile, data — and anything binary -> reproduce
  //
  // `data` used to fall through both and vanish, which is the one outcome this bucketing
  // may never produce: the parent spec's §9 criterion 3 is that walking every step in
  // AUTOMATED mode reproduces the reference byte-for-byte, and a file in neither bucket is
  // a file the automated writer is never told about. An image, a font, a CSV is not code
  // to write — but it is very much bytes to copy, so `reproduce` is where it belongs.
  // Anything else new that inventory.ts learns to classify lands there too, by default:
  // the test says "reproduce it", never "drop it".
  const chapterSourceFiles = new Map<string, string[]>();
  const chapterTestFiles = new Map<string, string[]>();
  for (const s of rawSeeds) { chapterSourceFiles.set(s.path, []); chapterTestFiles.set(s.path, []); }
  const miscSource: string[] = [];
  const miscTest: string[] = [];
  const reproduce: string[] = [];

  for (const f of digest.inventory.files) {
    const teachable =
      !f.binary &&
      (f.classification === 'source' || f.classification === 'structural' || f.classification === 'test');
    if (!teachable) {
      reproduce.push(f.path);
      continue;
    }

    const owner = ownerOf(f.path);
    const isTest = f.classification === 'test';
    if (owner === null) (isTest ? miscTest : miscSource).push(f.path);
    else (isTest ? chapterTestFiles : chapterSourceFiles).get(owner)!.push(f.path);
  }
  reproduce.sort();

  // A seed that owns nothing DIRECTLY (every file under it matched a more specific seed
  // first, via longest-prefix) never becomes a chapter — no shape step for an empty part.
  // Real on a repo with zero git history anywhere: see tierSeeds' doc comment.
  const seeds = rawSeeds.filter((s) => {
    const owned = (chapterSourceFiles.get(s.path)?.length ?? 0) + (chapterTestFiles.get(s.path)?.length ?? 0);
    return owned > 0;
  });

  // ---- 2. chapter order: bottom-up over the part-level import rollup
  const scoreByPath = new Map(seeds.map((s) => [s.path, s.score] as const));
  const chEdges = chapterEdges(digest.graph.edges, ownerOf);
  const chapterTiebreak = (a: string, b: string): number => {
    const sa = scoreByPath.get(a) ?? 0, sb = scoreByPath.get(b) ?? 0;
    return sa !== sb ? sb - sa : (a < b ? -1 : a > b ? 1 : 0);
  };
  const chapterPathOrder = dependencyOrder(seeds.map((s) => s.path), chEdges, chapterTiebreak);
  const hasMisc = miscSource.length > 0 || miscTest.length > 0;
  const fullChapterOrder = hasMisc ? [...chapterPathOrder, MISC_KEY] : chapterPathOrder;

  const seedByPath = new Map(seeds.map((s) => [s.path, s] as const));
  const chapters: Chapter[] = fullChapterOrder.map((p) => {
    if (p === MISC_KEY) {
      const n = miscSource.length + miscTest.length;
      const loc = sumLoc([...miscSource, ...miscTest], new Map(digest.inventory.files.map((f) => [f.path, f] as const)));
      return { key: MISC_KEY, title: 'Everything else', subtitle: chapterSubtitle(n, loc), tierPath: MISC_KEY };
    }
    const seed = seedByPath.get(p)!;
    return { key: seed.path, title: seed.title, subtitle: chapterSubtitle(seed.fileCount, seed.loc), tierPath: seed.path };
  });

  // ---- 3. steps, chapter by chapter, file by file
  const fileByPath = new Map(digest.inventory.files.map((f) => [f.path, f] as const));
  const extractByPath = new Map(digest.extracts.map((e) => [e.path, e] as const));
  const rankByPath = new Map(digest.ranked.map((r) => [r.path, r.score] as const));

  const fileTiebreak = (a: string, b: string): number => {
    const da = witnessMap.get(a)?.date ?? null, db = witnessMap.get(b)?.date ?? null;
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : 1;
    }
    const ra = rankByPath.get(a) ?? 0, rb = rankByPath.get(b) ?? 0;
    if (ra !== rb) return rb - ra;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  const steps: Step[] = [];
  const mintId = stepIdMinter();
  const fileStepId = new Map<string, string>();
  const shapeStepId = new Map<string, string>();
  const fileImportsResolved = new Map<string, string[]>();
  let ordinal = 0;

  for (const chapterPath of fullChapterOrder) {
    const isMisc = chapterPath === MISC_KEY;
    const title = isMisc ? 'Everything else' : seedByPath.get(chapterPath)!.title;
    const sourceFiles = isMisc ? miscSource : chapterSourceFiles.get(chapterPath)!;
    const testFiles = isMisc ? miscTest : chapterTestFiles.get(chapterPath)!;
    const chapterFileCount = sourceFiles.length + testFiles.length;
    const chapterLoc = sumLoc([...sourceFiles, ...testFiles], fileByPath);

    // ---- shape step
    ordinal++;
    const sId = mintId(chapterPath, 'shape', '');
    shapeStepId.set(chapterPath, sId);
    const shapeText = shapeDecisionText(title, chapterFileCount, chapterLoc);
    steps.push({
      id: sId, ordinal, chapter: chapterPath, kind: 'shape',
      decision: authorOnlyDecision(shapeText.question, shapeText.consequence, 'not inferable from the source', 'none'),
      target: { file: chapterPath },
      scaffold: { loadBearing: [], boilerplate: [] },
      dependsOn: [], // resolved below, once every chapter's shape id exists
      witness: witnessMap.get(chapterPath) ?? NULL_WITNESS,
    });

    // ---- files: topological within the chapter, tests spliced after their subject
    const sourceSet = new Set(sourceFiles);
    const localEdges = digest.graph.edges.filter((e) => sourceSet.has(e.from) && sourceSet.has(e.to));
    const order = dependencyOrder(sourceFiles, localEdges, fileTiebreak);
    const finalOrder = spliceTests(order, testFiles);

    for (const filePath of finalOrder) {
      const ex = extractByPath.get(filePath);
      const capped = ex ? selectLoadBearing(ex.symbols) : [];
      const loadBearing = capped.map((s) => ({ startLine: s.line, endLine: s.endLine }));
      const fileLoc = Math.max(0, fileByPath.get(filePath)?.loc ?? 0);
      const boilerplate = complement(loadBearing, fileLoc);

      const fText = fileDecisionText(ex);
      const fWhy = ex ? ex.symbols.find((s) => s.exported && s.doc !== null)?.doc ?? null : null;

      ordinal++;
      const fId = mintId(filePath, 'file', '');
      fileStepId.set(filePath, fId);
      if (ex) {
        fileImportsResolved.set(
          filePath,
          [...new Set(ex.imports.map((i) => i.resolved).filter((r): r is string => r !== null && r !== filePath))],
        );
      }

      steps.push({
        id: fId, ordinal, chapter: chapterPath, kind: 'file',
        decision: authorOnlyDecision(fText.question, fText.consequence, fWhy ?? 'not inferable from the source', fWhy ? 'docstring' : 'none'),
        target: { file: filePath },
        scaffold: { loadBearing, boilerplate },
        dependsOn: [], // resolved below
        witness: witnessMap.get(filePath) ?? NULL_WITNESS,
      });

      for (const sym of capped) {
        ordinal++;
        const symId = mintId(filePath, 'symbol', sym.name);
        const sText = symbolDecisionText(sym);
        steps.push({
          id: symId, ordinal, chapter: chapterPath, kind: 'symbol',
          decision: authorOnlyDecision(sText.question, sText.consequence, sym.doc ?? 'not inferable from the source', sym.doc ? 'docstring' : 'none'),
          target: { file: filePath, startLine: sym.line, endLine: sym.endLine },
          scaffold: { loadBearing: [{ startLine: sym.line, endLine: sym.endLine }], boilerplate: [] },
          dependsOn: [fId],
          witness: witnessMap.get(filePath) ?? NULL_WITNESS,
        });
      }
    }
  }

  // ---- 4. cross-references, now that every step id in the plan exists
  for (const step of steps) {
    if (step.kind === 'shape') {
      step.dependsOn = chEdges
        .filter((e) => e.from === step.chapter)
        .map((e) => shapeStepId.get(e.to))
        .filter((id): id is string => id !== undefined);
    } else if (step.kind === 'file') {
      step.dependsOn = (fileImportsResolved.get(step.target.file) ?? [])
        .map((r) => fileStepId.get(r))
        .filter((id): id is string => id !== undefined);
    }
  }

  const repoHead = digest.manifest.repos.find((r) => r.root === '')?.head ?? null;
  const cost: InterpretCost = {
    // No model ran (interpretation is T-13's) — 'none'/false say so plainly rather than
    // reporting a zero that could be mistaken for "measured and free".
    provider: 'none', metered: false, calls: 0, cachedStops: 0, interpretedStops: 0,
    inputTokens: 0, outputTokens: 0, usd: 0, model: 'none', failures: [],
  };

  return {
    schemaVersion: 1,
    source: { kind: 'repo', root: opts.root, head: repoHead },
    mode: 'recreate',
    chapters,
    steps,
    generatedAt: new Date().toISOString(),
    cost,
    reproduce,
  };
}
