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
import { digest, CACHE_DIR } from './digest.js';
import { renderView } from './view.js';
import { buildTourSteps } from './tour.js';
import { buildCodeTour } from './codetour.js';
import { renderRepoView } from './repoview.js';
import type { RankedFile } from './types.js';

interface Args {
  command: string;
  target: string;
  top: number;
  write: boolean;
  json: boolean;
  view: string | null;
  maxRows: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'help', target: '.', top: 25, write: true, json: false,
    view: null, maxRows: 750,
  };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--top') { args.top = Number(rest[++i] ?? 25); }
    else if (a === '--no-write') { args.write = false; }
    else if (a === '--json') { args.json = true; }
    else if (a === '--view') { args.view = rest[++i] ?? ''; }
    else if (a === '--max-rows') { args.maxRows = Number(rest[++i] ?? 750); }
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command !== 'digest' && args.command !== 'tour' && args.command !== 'inspect') {
    console.log('usage: repo-tour digest <path> [--top N] [--view FILE] [--max-rows N] [--no-write] [--json]');
    console.log('       repo-tour tour <path> [--view FILE] [--no-write]        the repo page + a tour of the code');
    console.log('       repo-tour inspect <path> [--view FILE] [--top N]        the digest quality view (scores, signals)');
    process.exit(args.command === 'help' ? 0 : 1);
  }

  const result = await digest(args.target, { write: args.write });
  const m = result.manifest;
  const quiet = args.command === 'tour';

  // `tour` is `digest` plus a projection of it — never a separate artifact.
  const isTour = args.command === 'tour';
  const codeTour = isTour ? buildCodeTour(result) : null;
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
  console.log(`  files interpreted  ${padStart(String(m.cost.filesInterpreted), 8)}   (stage 4 not built)`);
  console.log(`  tokens fast        ${padStart(String(m.cost.tokens.fast), 8)}`);
  console.log(`  tokens strong      ${padStart(String(m.cost.tokens.strong), 8)}`);
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
        ? renderRepoView(result, { steps: codeTour.steps, itinerary: codeTour.itinerary })
        : renderView(result, { maxRows: args.maxRows, tour: steps }),
    );
    const kb = Math.round(fs.statSync(viewPath).size / 1024);
    console.log(`\n  view               ${viewPath}  (${kb} KB, self-contained)`);
    if (codeTour) {
      console.log(`  tour               ${codeTour.steps.length} stops through ${codeTour.itinerary.length} files:`);
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
