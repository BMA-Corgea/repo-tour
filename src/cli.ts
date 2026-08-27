#!/usr/bin/env node
/**
 * repo-tour CLI.
 *
 *   repo-tour digest <path> [--top N] [--no-write] [--json]
 *
 * Stages 1-3 only for now; the report says so out loud rather than implying a
 * complete digest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, CACHE_DIR } from './digest.js';
import { renderView } from './view.js';
import { buildTourSteps } from './tour.js';
import { buildCodeTour, buildArchitectureSteps } from './codetour.js';
import { buildArchitecture, architectureBrief } from './architecture.js';
import { renderRepoView } from './repoview.js';
import { interpretStops, applyMeanings, interpretArchitecture, DEFAULT_MODEL } from './interpret.js';
import { saveTour, listTours, findTour, newestFor, renderLibrary } from './library.js';
import { RepoTourServer } from './server.js';
import { surveyProviders } from './llm.js';
import { execFileSync } from 'node:child_process';
import type { RankedFile } from './types.js';
import { resolvePr, diffSet, lineCounts, hunks, PrResolutionError, type Hunk } from './pr.js';
import { loadCheckpoint, sideAt, staleness, NoCheckpointError } from './checkpoint.js';
import { fileDelta, ripple, orderByMeaning, type FileDelta } from './delta.js';
import { buildPrTour, band } from './prtour.js';
import { adjudicate, type Adjudication } from './adjudicate.js';
import type { StopMeaning } from './interpret.js';

interface Args {
  command: string;
  target: string;
  top: number;
  write: boolean;
  json: boolean;
  view: string | null;
  maxRows: number;
  interpret: boolean;
  model: string;
  port: number;
  /** rebuild even when a tour for this exact commit already exists */
  fresh: boolean;
  /** which LLM writes the explanations; null uses the stored choice */
  provider: string | null;
  /**
   * Where the app keeps its list of loaded repositories.
   *
   * Overridable because it must be: a throwaway server started for a test used to write to
   * the real list, and clearing that list between test runs quietly wiped the repositories
   * someone had actually loaded. A test server points this somewhere disposable.
   */
  state: string | null;
  /** PR mode: the GitHub pull request number */
  pr: number | null;
  /** PR mode: explicit refs, the path that needs no network */
  base: string | null;
  head: string | null;
  /** PR mode: refuse to proceed when there is no checkpoint, rather than explaining how to make one */
  noCold: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help', target: '.', top: 25, write: true, json: false,
    view: null, maxRows: 750, interpret: true, model: DEFAULT_MODEL, fresh: false, port: 7788, state: null, provider: null,
    pr: null, base: null, head: null, noCold: false,
  };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--top') { args.top = Number(rest[++i] ?? 25); }
    else if (a === '--no-write') { args.write = false; }
    else if (a === '--json') { args.json = true; }
    else if (a === '--view') { args.view = rest[++i] ?? ''; }
    else if (a === '--max-rows') { args.maxRows = Number(rest[++i] ?? 750); }
    else if (a === '--no-interpret') { args.interpret = false; }
    else if (a === '--fresh') { args.fresh = true; }
    else if (a === '--port') { args.port = Number(rest[++i] ?? 7788); }
    else if (a === '--state') { args.state = rest[++i] ?? null; }
    else if (a === '--model') { args.model = rest[++i] ?? DEFAULT_MODEL; }
    else if (a === '--provider') { args.provider = rest[++i] ?? null; }
    else if (a === '--base') { args.base = rest[++i] ?? null; }
    else if (a === '--head') { args.head = rest[++i] ?? null; }
    else if (a === '--no-cold') { args.noCold = true; }
    else if (a === '--pr') { args.pr = Number(rest[++i] ?? NaN); }
    else if (args.command === 'pr' && args.pr === null && /^\d+$/.test(a)) { args.pr = Number(a); }
    else if (!a.startsWith('-')) { args.target = a; }
  }
  return args;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function ms(n: number): string {
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(2)}s`;
}

function printRanked(ranked: RankedFile[], top: number): void {
  console.log(`\n  ${pad('#', 4)}${pad('score', 8)}${pad('churn', 7)}${pad('in', 5)}${pad('loc', 8)}${pad('class', 12)}path`);
  console.log(`  ${'-'.repeat(78)}`);
  ranked.slice(0, top).forEach((r, i) => {
    console.log(
      `  ${pad(String(i + 1), 4)}${pad(r.score.toFixed(3), 8)}${padStart(String(r.churn), 5)}  ` +
      `${padStart(String(r.inDegree), 3)}  ${padStart(String(r.loc), 6)}  ${pad(r.classification, 12)}${r.path}`,
    );
  });
}

/** The commit a repository is on right now, or null when it has none. */
function headOf(repoPath: string): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/** True when the working tree has changes git would report — a tour cannot pin to a commit then. */
function isDirty(repoPath: string): boolean {
  try {
    return execFileSync('git', ['-C', repoPath, 'status', '--porcelain'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch { return false; }
}


/**
 * PR mode.
 *
 * The checkpoint is free — it is the digest already on disk. Only the changed files are
 * read out of git and interpreted, so the cost of touring a pull request is the size of
 * the pull request, not the size of the repository.
 */
async function runPrMode(args: Args): Promise<void> {
  const root = path.resolve(args.target);

  let refs;
  try {
    refs = resolvePr(root, { pr: args.pr ?? undefined, base: args.base ?? undefined, head: args.head ?? undefined });
  } catch (err) {
    if (err instanceof PrResolutionError) {
      console.error(`\nrepo-tour pr: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  let checkpoint;
  try {
    checkpoint = loadCheckpoint(root);
  } catch (err) {
    if (err instanceof NoCheckpointError) {
      if (args.noCold) process.exit(3);
      console.error(`\nrepo-tour pr: ${err.message}\n`);
      process.exit(3);
    }
    throw err;
  }

  const changes = diffSet(root, refs.baseSha, refs.headSha).filter((c) => !c.path.startsWith(`${CACHE_DIR}/`));
  if (changes.length === 0) {
    console.log('\n  nothing changed between those two commits.\n');
    return;
  }
  const lines = lineCounts(root, refs.baseSha, refs.headSha);
  const paths = changes.map((c) => c.path);

  console.log(`\nrepo-tour — pull request`);
  console.log(`  head               ${refs.headSha.slice(0, 12)}  ${refs.headLabel}`);
  console.log(`  base               ${refs.baseSha.slice(0, 12)}  ${refs.baseLabel}`);
  if (refs.forkSha) console.log(`  forked at          ${refs.forkSha.slice(0, 12)}  (base has moved ${refs.baseAhead} since)`);
  console.log(`  checkpoint         ${checkpoint.sha?.slice(0, 12) ?? 'unrecorded'}  taken ${checkpoint.generatedAt.slice(0, 16).replace('T', ' ')}`);
  console.log(`  changed            ${changes.length} files`);

  const stale = staleness(root, checkpoint.sha, refs.baseSha, paths);
  if (stale.overlap.length) {
    console.log(`  ⚠ checkpoint is ${stale.behind} commits behind, and ${stale.overlap.length} of the files it missed are touched here`);
  }

  // Both sides of the changed files. Nothing is checked out; this is the diff on disk.
  const beforeSide = await sideAt(root, refs.baseSha, paths);
  const afterSide = await sideAt(root, refs.headSha, paths);

  try {
    const hunksByFile = new Map<string, Hunk[]>();
    for (const p of paths) hunksByFile.set(p, hunks(root, refs.baseSha, refs.headSha, p));

    const stopsFor = (side: typeof beforeSide) =>
      side.files.map((f) => {
        const hs = hunksByFile.get(f.path) ?? [];
        const first = hs[0];
        const last = hs[hs.length - 1];
        return {
          file: f.path,
          startLine: first ? Math.max(1, first.start - 3) : 1,
          endLine: Math.min(f.loc || 1, last ? last.end + 3 : 60),
          title: path.basename(f.path),
          text: '',
        };
      });

    let beforeMeanings = new Map<string, StopMeaning>();
    let afterMeanings = new Map<string, StopMeaning>();
    if (args.interpret) {
      console.log(`  interpreting       ${beforeSide.files.length} files, both sides`);
      const b = await interpretStops(beforeSide.dir, stopsFor(beforeSide), beforeSide.files, beforeSide.extracts, [], { model: args.model, provider: args.provider ?? undefined });
      const a = await interpretStops(afterSide.dir, stopsFor(afterSide), afterSide.files, afterSide.extracts, [], { model: args.model, provider: args.provider ?? undefined });
      beforeMeanings = b.meanings;
      afterMeanings = a.meanings;
      console.log(`  interpreted        ${a.cost.interpretedStops + b.cost.interpretedStops} stops, ${a.cost.cachedStops + b.cost.cachedStops} reused from cache`);
    } else {
      console.log('  interpreting       skipped (--no-interpret) — scores rest on structure alone');
    }

    const beforeExtracts = new Map(beforeSide.extracts.map((e) => [e.path, e] as const));
    const afterExtracts = new Map(afterSide.extracts.map((e) => [e.path, e] as const));

    // Ask the model the actual question, per changed file: did what this code is FOR
    // change? See adjudicate.ts — comparing two free-prose interpretations scored a pure
    // variable rename at 0.47, and no tuning of that comparison recovers a signal the
    // inputs do not carry.
    const verdicts = new Map<string, Adjudication>();
    if (args.interpret) {
      const readSide = (dir: string, rel: string): string => {
        try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; }
      };
      let judged = 0;
      let reused = 0;
      for (const c of changes) {
        const v = await adjudicate(c.path, readSide(beforeSide.dir, c.path), readSide(afterSide.dir, c.path), {
          model: args.model, provider: args.provider ?? undefined, cwd: root,
        });
        verdicts.set(c.path, v);
        if (v.source === 'cache') reused++; else if (v.source === 'model') judged++;
      }
      console.log(`  judged             ${judged} files compared before/after, ${reused} reused from cache`);
    }

    const deltas: FileDelta[] = changes.map((c) => {
      const collect = (m: Map<string, StopMeaning>, p: string) =>
        [...m.entries()].filter(([k]) => k.startsWith(`${p}:`)).map(([, v]) => v);
      return fileDelta({
        path: c.path,
        status: c.status,
        linesChanged: lines.get(c.path) ?? 0,
        before: collect(beforeMeanings, c.path),
        after: collect(afterMeanings, c.path),
        beforeExtract: beforeExtracts.get(c.path),
        afterExtract: afterExtracts.get(c.path),
        adjudication: verdicts.get(c.path),
      });
    });

    const movedPaths = deltas.filter((d) => band(d.meaningDelta) === 'moved').map((d) => d.path);
    const rip = ripple(checkpoint.graph, movedPaths);

    const plan = buildPrTour({ refs, deltas, ripple: rip, staleness: stale, hunksByFile });

    // The tour renders through the SAME surface as a repo tour (criterion 9), over the
    // checkpoint's digest so the page has the repository around the change.
    const html = renderRepoView(checkpoint.result, { steps: plan.steps, itinerary: plan.itinerary });
    const out = args.view ?? path.join(root, CACHE_DIR, `pr-${refs.headSha.slice(0, 8)}.html`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);

    const ordered = orderByMeaning(deltas);
    console.log(`\n  ${pad('meaning', 9)}${pad('lines', 7)}${pad('band', 9)}${pad('basis', 13)}path`);
    console.log(`  ${'-'.repeat(78)}`);
    for (const d of ordered.slice(0, 20)) {
      console.log(`  ${pad(d.meaningDelta.toFixed(2), 9)}${pad(String(d.linesChanged), 7)}${pad(band(d.meaningDelta), 9)}${pad(d.basis, 13)}${d.path}`);
    }
    console.log(`\n  ripple             ${rip.reinterpret.length} re-interpreted (one hop), ${rip.structuralOnly.length} reachable beyond and NOT re-interpreted`);
    console.log(`  tour               ${plan.steps.length} stops`);
    console.log(`  page               ${out}\n`);
  } finally {
    beforeSide.dispose();
    afterSide.dispose();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'pr') {
    await runPrMode(args);
    return;
  }

  // ---- the app: repositories stay loaded, and a refresh re-reads them
  if (args.command === 'serve' || args.command === 'app') {
    const server = new RepoTourServer({
      port: args.port, interpret: args.interpret,
      ...(args.state ? { statePath: args.state } : {}),
      ...(args.provider || args.model !== DEFAULT_MODEL
        ? { llm: { ...(args.provider ? { provider: args.provider } : {}), model: args.model } }
        : {}),
    });
    const { port, close } = await server.listen();
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  repo-tour is running at ${url}`);
    console.log(`  Load a repository there; it stays loaded, and refreshing a tour re-reads it.`);
    console.log(`\n  Ctrl-C to stop.\n`);

    // Shut down when asked, and promptly.
    //
    // Under `tsx watch` the app restarts on every source change, so this runs constantly. A
    // process that ignores the signal gets force-killed after five seconds and nothing comes
    // back listening — which reads as the app being broken rather than as a slow stop.
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) { process.exit(0); }   // a second Ctrl-C means now
      stopping = true;
      console.log(`\n  ${signal} — stopping.`);
      void close().then(() => process.exit(0));
      // The last resort, so a wedged handle cannot outlive the request to stop.
      setTimeout(() => process.exit(0), 2500).unref();
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    return new Promise<void>(() => { /* the listening socket keeps this alive */ });
  }

  // ---- verbs that read the library rather than a repository
  if (args.command === 'providers') {
    const survey = await surveyProviders();
    console.log('');
    for (const p of survey) {
      console.log(`  ${p.availability.ok ? '✓' : '✗'} ${pad(p.id, 10)} ${pad(p.label, 16)} ${p.availability.detail}`);
      console.log(`    ${' '.repeat(10)} ${p.note}`);
      console.log(`    ${' '.repeat(10)} models: ${p.models.join(', ')}`);
    }
    console.log('');
    return;
  }

  if (args.command === 'list' || args.command === 'open' || args.command === 'library') {
    const tours = listTours();

    if (args.command === 'list') {
      if (!tours.length) { console.log('\nNo tours yet. Run: repo-tour tour <path>\n'); return; }
      console.log(`\n${tours.length} tour${tours.length === 1 ? '' : 's'}:\n`);
      for (const t of tours) {
        console.log(`  ${pad(t.id, 12)} ${pad(t.repoName, 18)} ${padStart(String(t.stops), 3)} stops  ${t.generatedAt.slice(0, 16).replace('T', ' ')}`);
        console.log(`  ${' '.repeat(12)} ${t.page}`);
      }
      console.log('');
      return;
    }

    if (args.command === 'open') {
      const wanted = args.target !== '.' ? findTour(args.target) : newestFor(process.cwd());
      if (!wanted) {
        console.error(args.target !== '.' ? `no tour matching "${args.target}"` : 'no tour for this directory yet — run: repo-tour tour .');
        process.exit(1);
      }
      console.log(wanted.page);
      return;
    }

    // library: regenerate the index over every known tour and print its path
    const heads: Record<string, string | null> = {};
    for (const t of tours) heads[t.repoPath] = headOf(t.repoPath);
    const libPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'library.html');
    fs.mkdirSync(path.dirname(libPath), { recursive: true });
    fs.writeFileSync(libPath, renderLibrary(tours, heads, Date.now()));
    console.log(libPath);
    return;
  }

  if (args.command !== 'digest' && args.command !== 'tour' && args.command !== 'inspect') {
    console.log('usage: repo-tour digest <path> [--top N] [--view FILE] [--max-rows N] [--no-write] [--json]');
    console.log('       repo-tour tour <path> [--view FILE] [--no-write]        the repo page + a tour of the code');
    console.log('       repo-tour inspect <path> [--view FILE] [--top N]        the digest quality view (scores, signals)');
    console.log('       repo-tour serve [--port N] [--state FILE]               THE APP: load repos, refresh to see changes');
    console.log('       repo-tour providers                                     which LLMs can write explanations here');
    console.log('       repo-tour list                                          every tour you have made');
    console.log('       repo-tour open [id]                                     print the path of a saved tour');
    console.log('       repo-tour library                                       rebuild and print the index of all tours');
    process.exit(args.command === 'help' ? 0 : 1);
  }

  // A tour is pinned to a commit. If one already exists for this exact commit and nothing
  // has changed since, there is nothing to redo — reuse it instead of rebuilding the page.
  if (args.command === 'tour' && !args.fresh && args.view === null) {
    const abs = path.resolve(args.target);
    const head = headOf(abs);
    const existing = newestFor(abs);
    if (head && existing && existing.head === head && !isDirty(abs)) {
      console.log(`\n  This commit already has a tour, and nothing has changed since.`);
      console.log(`  ${existing.stops} stops · made ${existing.generatedAt.slice(0, 16).replace('T', ' ')}`);
      console.log(`\n  ${existing.page}`);
      console.log(`\n  Use --fresh to rebuild it anyway.\n`);
      return;
    }
  }

  const result = await digest(args.target, { write: args.write });
  const m = result.manifest;
  const quiet = args.command === 'tour';

  // `tour` is `digest` plus a projection of it — never a separate artifact.
  const isTour = args.command === 'tour';
  const codeTour = isTour ? buildCodeTour(result) : null;

  // Stage 4 — the only stage that spends tokens, and it only ever sees the itinerary.
  let tourSteps: Array<(typeof codeTour extends null ? never : NonNullable<typeof codeTour>['steps'][number]) & { interpreted?: boolean }> = [];
  let interpretCost: Awaited<ReturnType<typeof interpretStops>>['cost'] | null = null;
  const arch = isTour ? buildArchitecture(result) : null;

  if (codeTour) {
    const opts = {
      model: args.model,
      ...(args.provider ? { provider: args.provider } : {}),
      cachedOnly: !args.interpret,
      onProgress: (msg: string) => console.log(`  ${msg}`),
    };

    // The system first, then the code. Both go through stage 4; the architecture call sees
    // only the parts and the flow between them, never a file's contents.
    const archSteps = arch
      ? buildArchitectureSteps(arch, path.basename(m.root) || m.root, result.inventory.files.length)
      : [];

    if (arch && archSteps.length) {
      const brief = architectureBrief(arch, path.basename(m.root) || m.root, result.inventory.files.length);
      const { meaning, cost } = await interpretArchitecture(m.root, brief, opts);
      if (meaning) {
        arch.overview = meaning.overview;
        for (const sub of arch.subsystems) sub.purpose = meaning.purposes[sub.path] ?? null;
        for (const step of archSteps) {
          const part = step.architecture?.part ?? null;
          const text = part === null ? meaning.overview : meaning.purposes[part];
          if (text) {
            // Keep the hard numbers, lead with the explanation.
            (step as { text: string; interpreted?: boolean }).text = `${text}\n\n${step.text}`;
            (step as { interpreted?: boolean }).interpreted = true;
          }
        }
      }
      interpretCost = cost;
    }

    const interp = await interpretStops(
      m.root, codeTour.steps, result.inventory.files, result.extracts, result.graph.edges, opts,
    );
    if (interpretCost) {
      interpretCost = {
        ...interp.cost,
        calls: interpretCost.calls + interp.cost.calls,
        cachedStops: interpretCost.cachedStops + interp.cost.cachedStops,
        interpretedStops: interpretCost.interpretedStops + interp.cost.interpretedStops,
        inputTokens: interpretCost.inputTokens + interp.cost.inputTokens,
        outputTokens: interpretCost.outputTokens + interp.cost.outputTokens,
        usd: interpretCost.usd + interp.cost.usd,
        failures: [...interpretCost.failures, ...interp.cost.failures],
      };
    } else {
      interpretCost = interp.cost;
    }

    tourSteps = [...archSteps, ...applyMeanings(codeTour.steps, result.inventory.files, interp.meanings)];
  }
  const steps = args.command === 'inspect' ? buildTourSteps(result) : undefined;

  if (args.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }

  console.log(`\nrepo-tour digest — ${m.root}`);
  console.log(`stages run: ${m.stagesRun.join(', ')}   not built yet: ${m.stagesNotBuilt.join(', ')}`);

  console.log(`\nREPOSITORIES (${m.repos.length})`);
  for (const repo of m.repos) {
    const label = repo.root === '' ? '. (scan root)' : repo.root;
    const head = repo.head ? repo.head.slice(0, 8) : 'no commits';
    console.log(`  ${pad(label, 46)} ${padStart(String(repo.commitCount), 6)} commits  ${head}${repo.pointer ? '  (worktree/submodule)' : ''}`);
  }

  console.log(`\nINVENTORY`);
  const cls = Object.entries(m.counts.byClassification).sort((a, b) => b[1] - a[1]);
  console.log(`  ${m.counts.files} files`);
  for (const [k, v] of cls) console.log(`    ${pad(k, 12)} ${padStart(String(v), 6)}`);

  console.log(`\nEXTRACTION`);
  console.log(`  parsed          ${padStart(String(m.counts.parsed), 6)} files`);
  console.log(`  symbols         ${padStart(String(m.counts.symbols), 6)}`);
  console.log(`  import edges    ${padStart(String(m.counts.edges), 6)}`);
  const cov = m.graphCoverage;
  const pct = cov.totalImports === 0 ? 0 : Math.round((cov.resolvedInternal / cov.totalImports) * 100);
  console.log(`  coverage        ${padStart(String(pct), 6)}%  (${cov.resolvedInternal}/${cov.totalImports} imports resolved inside the tree, ${cov.leftTheTree} left it)`);
  if (cov.filesWithParseErrors > 0) {
    console.log(`  parse errors    ${padStart(String(cov.filesWithParseErrors), 6)} files had at least one`);
  }
  console.log(`  note: ${cov.note}`);

  printRanked(result.ranked, args.top);

  console.log(`\nCOST`);
  console.log(`  files scanned      ${padStart(String(m.cost.filesScanned), 8)}`);
  console.log(`  files interpreted  ${padStart(String(interpretCost ? interpretCost.calls : 0), 8)}`);
  if (interpretCost) {
    const ic = interpretCost;
    console.log(`  interpreted        ${padStart(String(ic.interpretedStops), 8)} stops in ${ic.calls} call(s) on ${ic.model}`);
    console.log(`  reused (cached)    ${padStart(String(ic.cachedStops), 8)} stops — paid for on an earlier run`);
    console.log(`  tokens in / out    ${padStart(ic.inputTokens + ' / ' + ic.outputTokens, 8)}`);
    console.log(`  cost               ${padStart('$' + ic.usd.toFixed(4), 8)}`);
    for (const f of ic.failures) console.log(`  ! ${f}`);
  } else {
    console.log(`  tokens fast        ${padStart(String(m.cost.tokens.fast), 8)}`);
    console.log(`  tokens strong      ${padStart(String(m.cost.tokens.strong), 8)}`);
  }
  console.log(`  wall clock         ${padStart(ms(m.cost.wallMs), 8)}   (inventory ${ms(m.cost.inventoryMs)}, extract ${ms(m.cost.extractMs)}, rank ${ms(m.cost.rankMs)})`);
  console.log(`  deep slice         ${padStart(String(m.counts.deepSlice), 8)} files would enter stage 4`);
  console.log(`  sweep eligible     ${padStart(String(m.counts.sweepEligible), 8)} files scored above zero`);
  console.log(`  tiers rolled up    ${padStart(String(m.counts.tiers), 8)}   (rollup ${ms(m.cost.rollupMs)})`);
  if (m.incremental) {
    const inc = m.incremental;
    console.log(`\nINCREMENTAL (vs. the digest already on disk)`);
    console.log(`  reused             ${padStart(String(inc.reused), 8)}   ${inc.reusePercent}% of the tree cost nothing`);
    console.log(`  recomputed         ${padStart(String(inc.recomputed), 8)}`);
    console.log(`  carried (renamed)  ${padStart(String(inc.carried), 8)}`);
    console.log(`  added / deleted    ${padStart(inc.added + ' / ' + inc.deleted, 8)}`);
  }

  // Criterion 8: a self-contained HTML view the human can open and browse.
  const viewPath = args.view !== null && args.view !== ''
    ? path.resolve(args.view)
    : args.write
      ? path.join(path.resolve(args.target), CACHE_DIR, 'view.html')
      : null;
  if (viewPath) {
    fs.mkdirSync(path.dirname(viewPath), { recursive: true });
    fs.writeFileSync(
      viewPath,
      codeTour
        ? renderRepoView(result, {
            steps: tourSteps,
            itinerary: codeTour.itinerary,
            architecture: arch ?? undefined,
          })
        : renderView(result, { maxRows: args.maxRows, tour: steps }),
    );
    const kb = Math.round(fs.statSync(viewPath).size / 1024);
    console.log(`\n  view               ${viewPath}  (${kb} KB, self-contained)`);

    // Tours are entities, not loose files: record this one and refresh the library.
    if (codeTour && args.write) {
      const abs = path.resolve(args.target);
      const dirty = isDirty(abs);
      const repoHead = m.repos.find((x) => x.root === '');
      const record = saveTour(
        abs,
        fs.readFileSync(viewPath, 'utf8'),
        {
          repoName: path.basename(abs) || abs,
          repoPath: abs,
          head: dirty ? null : repoHead?.head ?? null,
          branch: repoHead?.branch ?? null,
          stops: tourSteps.length,
          architectureStops: tourSteps.filter((s) => s.architecture).length,
          files: codeTour.itinerary,
          interpreted: tourSteps.some((s) => s.interpreted),
        },
        new Date().toISOString(),
      );

      const all = listTours();
      const heads: Record<string, string | null> = {};
      for (const t of all) heads[t.repoPath] = headOf(t.repoPath);
      const libPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'library.html');
      fs.mkdirSync(path.dirname(libPath), { recursive: true });
      fs.writeFileSync(libPath, renderLibrary(all, heads, Date.now()));

      console.log(`  saved as           ${record.id}${dirty ? '  (uncommitted tree — not pinned to a commit)' : ''}`);
      console.log(`                     ${record.page}`);
      console.log(`  all your tours     ${libPath}`);
    }
    if (codeTour) {
      const archCount = tourSteps.filter((s) => s.architecture).length;
      console.log(`  tour               ${tourSteps.length} stops — ${archCount} on the system, ${codeTour.steps.length} through ${codeTour.itinerary.length} files:`);
      if (arch) for (const sub of arch.subsystems) console.log(`                       [part] ${sub.path}`);
      for (const f of codeTour.itinerary) console.log(`                       ${f}`);
    }
    if (steps) console.log(`  overlay            ${steps.length} steps over the metrics view`);
  }
  console.log('');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
