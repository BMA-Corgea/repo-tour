/**
 * Acceptance criteria 1-4 and 6, against fixtures built on the fly.
 *
 * Every fixture is a real git repository with real commits, because the signals under
 * test (nested-repo discovery, churn) do not exist without one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inventory } from '../src/inventory.js';
import { extract } from '../src/extract.js';
import { rank } from '../src/rank.js';
import { digest } from '../src/digest.js';
import { renderView } from '../src/view.js';
import { rollup } from '../src/rollup.js';
import { planIncremental } from '../src/incremental.js';
import { buildTourSteps } from '../src/tour.js';
import { buildCodeTour, buildArchitectureSteps } from '../src/codetour.js';
import { buildArchitecture } from '../src/architecture.js';
import { renderRepoView } from '../src/repoview.js';
import { fingerprint } from '../src/server.js';
import { applyMeanings, fullText, stepKey, SUMMARY_MAX } from '../src/interpret.js';
import { narrate, compress } from '../src/narrate.js';
import { meaningDistance, vocabularyOf, fileDelta, orderByMeaning, ripple, type FileDelta } from '../src/delta.js';
import { buildPrTour, whyFor, band } from '../src/prtour.js';
import { issueRefs, resolvePr, listPrs, diffSet } from '../src/pr.js';
import { loadCheckpoint, staleness } from '../src/checkpoint.js';
import type { FileExtract, SymbolRecord } from '../src/types.js';

let root: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}


/**
 * Wait for a server's background build to finish before deleting its fixture.
 *
 * Without this the test removes the directory while a resumed build is still running, and
 * the build writes `.repo-tour/` straight back — leaving a directory in /tmp containing a
 * digest cache and no source. Twenty of them had accumulated before anyone looked.
 */
async function settle(server: { listRepos(): Array<{ running: boolean }> }, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!server.listRepos().some((r) => r.running)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'fixture@test.local');
  git(dir, 'config', 'user.name', 'fixture');
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message, '--allow-empty');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-fixture-'));

  // ---- outer repo -------------------------------------------------------
  initRepo(root);

  // A small, high-churn structural file. This is the `manifest.yaml` shape.
  write(path.join(root, 'manifest.yaml'), 'name: fixture\nversion: 1\n');

  // A huge, single-commit data file with no importers. This is the benchmark-exhaust shape.
  write(
    path.join(root, 'reports/bench_dump.json'),
    JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ i, v: i * 2 })) }, null, 2),
  );

  write(
    path.join(root, 'src/core.py'),
    [
      'import os',
      'from .helpers import shout',
      '',
      'MAX_RETRIES = 3',
      '_PRIVATE = 1',
      '',
      '',
      'def run(job):',
      '    """Send a job through the shouter.',
      '',
      '    Args: job — the thing to shout.',
      '    """',
      '    return shout(job)',
      '',
      '',
      'def _internal():',
      '    pass',
      '',
      '',
      'class Engine:',
      '    def start(self):',
      '        pass',
      '',
      '    def _stop(self):',
      '        pass',
      '',
    ].join('\n'),
  );

  write(
    path.join(root, 'src/helpers.py'),
    ['def shout(s):', '    return str(s).upper()', ''].join('\n'),
  );

  // Two more importers of helpers.py, so in-degree is a real number.
  write(path.join(root, 'src/alpha.py'), 'from .helpers import shout\n');
  write(path.join(root, 'src/beta.py'), 'from src.helpers import shout\n');

  write(
    path.join(root, 'src/app.ts'),
    [
      "import { shout } from './util.js';",
      "import express from 'express';",
      '',
      'export interface Options { loud: boolean }',
      'export type Name = string;',
      '',
      'export function greet(n: Name): string {',
      '  return shout(n);',
      '}',
      '',
      'export const VERSION = 2;',
      '',
      'export class Server {',
      '  listen() {}',
      '  _private() {}',
      '}',
      '',
      'function notExported() {}',
      '',
    ].join('\n'),
  );

  write(path.join(root, 'src/util.ts'), 'export function shout(s: string) { return s.toUpperCase(); }\n');

  // Things that must be floored to zero (criterion 2).
  write(path.join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n');
  write(path.join(root, 'vendor/leftpad/index.js'), 'module.exports = function () {};\n');
  write(path.join(root, 'dist/bundle.js'), 'console.log(1);\n');
  write(path.join(root, 'src/schema_pb2.py'), 'DESCRIPTOR = None\n');
  write(path.join(root, 'src/marked.py'), '# @generated by a tool\nX = 1\n');

  // A document that lives in a `specs/` folder and is NOT a test.
  write(path.join(root, 'specs/design.md'), '# Design\n\nProse, not a test.\n');

  // A real test file.
  write(path.join(root, 'tests/test_core.py'), 'def test_run():\n    assert True\n');

  commitAll(root, 'initial');

  // Churn: touch manifest.yaml many times, the dump never again.
  for (let i = 0; i < 9; i++) {
    write(path.join(root, 'manifest.yaml'), `name: fixture\nversion: ${i + 2}\n`);
    commitAll(root, `bump ${i}`);
  }

  // ---- nested repo, two levels down ------------------------------------
  const nested = path.join(root, 'services', 'inner');
  initRepo(nested);
  write(path.join(nested, 'main.py'), 'def main():\n    pass\n');
  commitAll(nested, 'inner initial');
  write(path.join(nested, 'main.py'), 'def main():\n    return 1\n');
  commitAll(nested, 'inner second');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('criterion 1 — nested repos are found', () => {
  it('reports each repo with its own commit count and HEAD', () => {
    const inv = inventory(root);
    const roots = inv.repos.map((r) => r.root).sort();
    expect(roots).toEqual(['', 'services/inner']);

    const outer = inv.repos.find((r) => r.root === '')!;
    const inner = inv.repos.find((r) => r.root === 'services/inner')!;

    expect(outer.commitCount).toBe(10);
    expect(inner.commitCount).toBe(2);
    expect(outer.head).toMatch(/^[0-9a-f]{40}$/);
    expect(inner.head).toMatch(/^[0-9a-f]{40}$/);
    expect(outer.head).not.toBe(inner.head);
  });

  it('assigns each file to its nearest enclosing repo', () => {
    const inv = inventory(root);
    const innerFile = inv.files.find((f) => f.path === 'services/inner/main.py')!;
    const outerFile = inv.files.find((f) => f.path === 'src/core.py')!;
    expect(innerFile.repo).toBe('services/inner');
    expect(outerFile.repo).toBe('');
  });
});

describe('criterion 2 — classification is honest', () => {
  it('classifies each fixture the way a human would', () => {
    const inv = inventory(root);
    const at = (p: string) => inv.files.find((f) => f.path === p)!;

    expect(at('package-lock.json').classification).toBe('lockfile');
    expect(at('vendor/leftpad/index.js').classification).toBe('vendored');
    expect(at('dist/bundle.js').classification).toBe('generated');
    expect(at('src/schema_pb2.py').classification).toBe('generated');
    expect(at('src/marked.py').classification).toBe('generated');
    expect(at('tests/test_core.py').classification).toBe('test');
    expect(at('manifest.yaml').classification).toBe('structural');
    expect(at('src/core.py').classification).toBe('source');
    expect(at('reports/bench_dump.json').classification).toBe('generated');
  });

  it('does not call a document in specs/ a test', () => {
    const inv = inventory(root);
    expect(inv.files.find((f) => f.path === 'specs/design.md')!.classification).toBe('data');
  });

  it('records the signal that produced every classification', () => {
    const inv = inventory(root);
    for (const f of inv.files) expect(f.signals.length).toBeGreaterThan(0);
    expect(inv.files.find((f) => f.path === 'src/marked.py')!.signals).toContain('generated-header');
  });
});

describe('criterion 4 — extraction is exact', () => {
  it('matches a hand-written expectation for python', async () => {
    const inv = inventory(root);
    const { extracts } = await extract(root, inv.files);
    const core = extracts.find((e) => e.path === 'src/core.py')!;

    expect(core.parseErrors).toBe(0);
    expect(core.symbols).toEqual([
      { name: 'MAX_RETRIES', kind: 'variable', line: 4, endLine: 4, exported: true, doc: null },
      // The docstring is read, and the `Args:` section is cut — a tour wants the sentence,
      // not the parameter table.
      { name: 'run', kind: 'function', line: 8, endLine: 13, exported: true,
        doc: 'Send a job through the shouter.' },
      { name: '_internal', kind: 'function', line: 16, endLine: 17, exported: false, doc: null },
      { name: 'Engine', kind: 'class', line: 20, endLine: 25, exported: true, doc: null },
      { name: 'start', kind: 'method', line: 21, endLine: 22, exported: true, doc: null },
      { name: '_stop', kind: 'method', line: 24, endLine: 25, exported: false, doc: null },
    ]);

    expect(core.imports.map((i) => [i.raw, i.resolved])).toEqual([
      ['os', null],
      ['.helpers', 'src/helpers.py'],
    ]);
  });

  it('matches a hand-written expectation for typescript', async () => {
    const inv = inventory(root);
    const { extracts } = await extract(root, inv.files);
    const app = extracts.find((e) => e.path === 'src/app.ts')!;

    expect(app.parseErrors).toBe(0);
    expect(app.symbols).toEqual([
      { name: 'Options', kind: 'interface', line: 4, endLine: 4, exported: true, doc: null },
      { name: 'Name', kind: 'type', line: 5, endLine: 5, exported: true, doc: null },
      { name: 'greet', kind: 'function', line: 7, endLine: 9, exported: true, doc: null },
      { name: 'VERSION', kind: 'variable', line: 11, endLine: 11, exported: true, doc: null },
      { name: 'Server', kind: 'class', line: 13, endLine: 16, exported: true, doc: null },
      { name: 'listen', kind: 'method', line: 14, endLine: 14, exported: true, doc: null },
      { name: '_private', kind: 'method', line: 15, endLine: 15, exported: false, doc: null },
      { name: 'notExported', kind: 'function', line: 18, endLine: 18, exported: false, doc: null },
    ]);

    // `./util.js` on the wire is `./util.ts` on disk; `express` leaves the tree.
    expect(app.imports.map((i) => [i.raw, i.resolved])).toEqual([
      ['./util.js', 'src/util.ts'],
      ['express', null],
    ]);
  });

  it('invents nothing — every symbol name appears in the source text', async () => {
    const inv = inventory(root);
    const { extracts } = await extract(root, inv.files);
    for (const ex of extracts) {
      const text = fs.readFileSync(path.join(root, ex.path), 'utf8');
      for (const sym of ex.symbols) expect(text).toContain(sym.name);
    }
  });

  it('counts in-degree from resolved edges only', async () => {
    const inv = inventory(root);
    const { graph } = await extract(root, inv.files);
    // core.py, alpha.py and beta.py all import helpers.py
    expect(graph.inDegree['src/helpers.py']).toBe(3);
    expect(graph.coverage.leftTheTree).toBeGreaterThan(0);
  });
});

describe('criterion 3 — ranking beats length', () => {
  it('ranks the small high-churn structural file above the huge data dump', async () => {
    const inv = inventory(root);
    const { graph } = await extract(root, inv.files);
    const { ranked } = rank(root, inv.files, inv.repos, graph);

    const order = ranked.map((r) => r.path);
    const manifestAt = order.indexOf('manifest.yaml');
    const dumpAt = order.indexOf('reports/bench_dump.json');

    const manifest = ranked[manifestAt]!;
    const dump = ranked[dumpAt]!;

    // The premise of the test: the dump really is far bigger, and really is untouched.
    expect(dump.loc).toBeGreaterThan(manifest.loc * 100);
    expect(manifest.churn).toBeGreaterThan(dump.churn);

    expect(manifestAt).toBeLessThan(dumpAt);
    expect(manifest.score).toBeGreaterThan(dump.score);
  });

  it('floors generated, vendored and lockfile content to zero', async () => {
    const inv = inventory(root);
    const { graph } = await extract(root, inv.files);
    const { ranked } = rank(root, inv.files, inv.repos, graph);
    const at = (p: string) => ranked.find((r) => r.path === p)!;

    expect(at('package-lock.json').score).toBe(0);
    expect(at('vendor/leftpad/index.js').score).toBe(0);
    expect(at('dist/bundle.js').score).toBe(0);
  });

  it('counts churn in the file’s own repo, not the parent’s', async () => {
    const inv = inventory(root);
    const { graph } = await extract(root, inv.files);
    const { ranked } = rank(root, inv.files, inv.repos, graph);
    // The outer repo cannot see this file at all; only the nested repo's log has it.
    expect(ranked.find((r) => r.path === 'services/inner/main.py')!.churn).toBe(2);
  });
});

describe('criterion 6 — content-hash keying', () => {
  it('gives an unchanged file the same key across two runs, and a changed file a new one', async () => {
    const before = inventory(root).files.find((f) => f.path === 'src/helpers.py')!;
    const stableBefore = inventory(root).files.find((f) => f.path === 'src/core.py')!;

    write(path.join(root, 'src/helpers.py'), 'def shout(s):\n    return str(s).upper() + "!"\n');
    commitAll(root, 'edit helpers');

    const after = inventory(root).files.find((f) => f.path === 'src/helpers.py')!;
    const stableAfter = inventory(root).files.find((f) => f.path === 'src/core.py')!;

    expect(after.sha256).not.toBe(before.sha256);
    expect(stableAfter.sha256).toBe(stableBefore.sha256);
  });
});

describe('criterion 7 — cost is reported, not hidden', () => {
  it('reports token spend explicitly even when it is zero', async () => {
    const { manifest } = await digest(root, { write: false });
    expect(manifest.cost.tokens).toEqual({ fast: 0, strong: 0 });
    expect(manifest.cost.filesInterpreted).toBe(0);
    expect(manifest.cost.filesScanned).toBeGreaterThan(0);
    expect(manifest.cost.wallMs).toBeGreaterThanOrEqual(0);
    expect(manifest.stagesNotBuilt).toContain('4-interpret');
  });

  it('states the import graph’s own coverage', async () => {
    const { manifest } = await digest(root, { write: false });
    expect(manifest.graphCoverage.totalImports).toBeGreaterThan(0);
    expect(manifest.graphCoverage.note).toMatch(/not the structure/);
  });
});

describe('criterion 8 — inspectable by a human', () => {
  it('renders a genuinely self-contained page: no external requests at all', async () => {
    const result = await digest(root, { write: false });
    const html = renderView(result);

    // Any absolute URL means the page needs the network to render correctly.
    const external = html.match(/(?:https?:)?\/\/[a-zA-Z0-9.-]+/g) ?? [];
    expect(external).toEqual([]);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
  });

  it('says out loud that the digest is partial rather than implying completeness', async () => {
    const result = await digest(root, { write: false });
    const html = renderView(result);
    expect(html).toMatch(/Nothing on this page was written by a model/);
    expect(html).toMatch(/4-interpret — not built/);
    expect(html).toMatch(/not the structure/);
  });

  it('never truncates silently — a capped table says what it dropped', async () => {
    const result = await digest(root, { write: false });
    const capped = renderView(result, { maxRows: 3 });
    const dropped = result.ranked.length - 3;
    expect(capped).toMatch(/rows are not[\s\S]*?embedded/);
    expect(capped).toContain(dropped.toLocaleString());
  });

  it('embeds every ranked row with the components that produced its score', async () => {
    const result = await digest(root, { write: false });
    const html = renderView(result);
    const payload = /window\.__DIGEST__ = (\{[\s\S]*?\});/.exec(html);
    expect(payload).not.toBeNull();
    const data = JSON.parse(payload![1]!) as { rows: Array<Record<string, unknown>> };
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      expect(row).toHaveProperty('components');
      expect(row).toHaveProperty('signals');
      expect(row).toHaveProperty('symbols');
    }
  });
});

describe('criterion 5 — the rollup holds', () => {
  it('gives every directory, subsystem and repo a digest built from its children', async () => {
    const r = await digest(root, { write: false });
    const paths = new Set(r.tiers.map((t) => t.path));

    expect(paths.has('')).toBe(true);
    expect(paths.has('src')).toBe(true);
    expect(paths.has('services')).toBe(true);
    expect(paths.has('services/inner')).toBe(true);

    // A repo root is a 'repo'; a directory directly under one is a 'subsystem'.
    expect(r.tiers.find((t) => t.path === '')!.kind).toBe('repo');
    expect(r.tiers.find((t) => t.path === 'services/inner')!.kind).toBe('repo');
    expect(r.tiers.find((t) => t.path === 'src')!.kind).toBe('subsystem');

    // Every tier declares, in its own data, that it was built from children.
    for (const t of r.tiers) expect(t.sourcedFrom).toBe('children');
  });

  it('rolls counts upward: a parent equals the sum of its children', async () => {
    const r = await digest(root, { write: false });
    const byPath = new Map(r.tiers.map((t) => [t.path, t] as const));
    const rootTier = byPath.get('')!;

    const sumOfChildren =
      rootTier.childTiers.reduce((n, c) => n + byPath.get(c)!.fileCount, 0) +
      rootTier.childFiles.length;
    expect(rootTier.fileCount).toBe(sumOfChildren);
    expect(rootTier.fileCount).toBe(r.inventory.files.length);
  });

  it('hashes a tier from its children only, so a tier is stale iff a child is', async () => {
    const before = await digest(root, { write: false });
    const beforeByPath = new Map(before.tiers.map((t) => [t.path, t.hash] as const));

    write(path.join(root, 'src/helpers.py'), 'def shout(s):\n    return str(s).upper() + "?"\n');
    commitAll(root, 'edit helpers again');

    const after = await digest(root, { write: false });
    const afterByPath = new Map(after.tiers.map((t) => [t.path, t.hash] as const));

    // src changed, so src and the root are stale...
    expect(afterByPath.get('src')).not.toBe(beforeByPath.get('src'));
    expect(afterByPath.get('')).not.toBe(beforeByPath.get(''));
    // ...but an untouched sibling subtree is byte-identical and can be reused.
    expect(afterByPath.get('services/inner')).toBe(beforeByPath.get('services/inner'));
  });
});

describe('criterion 6 — incremental works', () => {
  it('reuses unchanged files and reports the count', async () => {
    const first = await digest(root, { write: false });
    const prior = first.inventory.files.map((f) => ({ path: f.path, sha256: f.sha256 }));

    write(path.join(root, 'src/core.py'), 'import os\n\n\ndef run(job):\n    return job\n');
    commitAll(root, 'rewrite core');
    const second = await digest(root, { write: false });

    const plan = planIncremental(prior, second.inventory.files, second.tiers);
    expect(plan.counts.recomputed).toBe(1);
    expect(plan.recompute).toEqual(['src/core.py']);
    expect(plan.counts.reused).toBe(plan.counts.total - 1);
    expect(plan.counts.reusePercent).toBeGreaterThan(90);
  });

  it('carries a renamed file across for free instead of recomputing it', async () => {
    const first = await digest(root, { write: false });
    const prior = first.inventory.files.map((f) => ({ path: f.path, sha256: f.sha256 }));

    fs.renameSync(path.join(root, 'src/alpha.py'), path.join(root, 'src/renamed_alpha.py'));
    commitAll(root, 'rename alpha');
    const second = await digest(root, { write: false });

    const plan = planIncremental(prior, second.inventory.files, second.tiers);
    expect(plan.carried).toEqual([
      { from: 'src/alpha.py', to: 'src/renamed_alpha.py', sha256: expect.any(String) },
    ]);
    expect(plan.recompute).toEqual([]);
    expect(plan.deleted).toEqual([]);
  });

  it('does not digest its own cache — a second run with no edits reuses everything', async () => {
    // Found by running the tool twice on its own repo: run 1 writes .repo-tour/, and
    // run 2 then inventoried ~100 cache files as brand-new additions.
    const cache = path.join(root, '.repo-tour');
    fs.rmSync(cache, { recursive: true, force: true });

    const first = await digest(root, { write: true });
    expect(fs.existsSync(cache)).toBe(true);

    const second = await digest(root, { write: true });
    expect(second.inventory.files.length).toBe(first.inventory.files.length);
    expect(second.inventory.files.some((f) => f.path.startsWith('.repo-tour/'))).toBe(false);
    expect(second.plan).not.toBeNull();
    expect(second.plan!.counts.added).toBe(0);
    expect(second.plan!.counts.recomputed).toBe(0);
    expect(second.plan!.counts.reusePercent).toBe(100);

    fs.rmSync(cache, { recursive: true, force: true });
  });

  it('drops a deleted file and marks its ancestors stale', async () => {
    const first = await digest(root, { write: false });
    const prior = first.inventory.files.map((f) => ({ path: f.path, sha256: f.sha256 }));

    fs.rmSync(path.join(root, 'src/beta.py'));
    commitAll(root, 'delete beta');
    const second = await digest(root, { write: false });

    const plan = planIncremental(prior, second.inventory.files, second.tiers);
    expect(plan.deleted).toEqual(['src/beta.py']);
    expect(plan.invalidatedTiers).toContain('src');
    expect(plan.invalidatedTiers).toContain('');
    expect(plan.invalidatedTiers).not.toContain('services/inner');
  });
});

describe('the tour is a projection of the digest, not a separate artifact', () => {
  it('generates steps whose claims are backed by digest numbers', async () => {
    const r = await digest(root, { write: false });
    const steps = buildTourSteps(r);

    expect(steps.length).toBeGreaterThan(3);
    for (const s of steps) {
      expect(s.target).toBeTruthy();
      expect(s.text.length).toBeGreaterThan(20);
    }
    // The opening step states the real file count.
    expect(steps[0]!.text).toContain(r.inventory.files.length.toLocaleString());
    // Any step pointing at a file row points at a file that actually exists.
    for (const s of steps) {
      if (!s.filterTo) continue;
      expect(r.ranked.some((x) => x.path === s.filterTo)).toBe(true);
    }
  });

  it('inlines the tour engine with no external requests', async () => {
    const r = await digest(root, { write: false });
    const html = renderView(r, { tour: buildTourSteps(r) });
    expect(html).toMatch(/window\.__TOUR__/);
    expect(html).toMatch(/Tour\.start/);
    expect((html.match(/(?:https?:)?\/\/[a-zA-Z0-9.-]+/g) ?? [])).toEqual([]);
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });
});

describe('the tour walks CODE, not metrics', () => {
  it('anchors every step to a real file and a real line range', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);

    expect(plan.steps.length).toBeGreaterThan(2);
    const byPath = new Map(r.inventory.files.map((f) => [f.path, f] as const));

    for (const s of plan.steps) {
      const f = byPath.get(s.file);
      expect(f, `step points at a file that is not in the tree: ${s.file}`).toBeDefined();
      expect(s.startLine).toBeGreaterThanOrEqual(1);
      expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
      // never point past the end of the file
      expect(s.endLine).toBeLessThanOrEqual(f!.loc + 1);
      expect(plan.itinerary).toContain(s.file);
    }
  });

  it('quotes the author when the author left a docstring', async () => {
    // Its own tree: the shared fixture is mutated by the incremental tests above, and a
    // test that depends on their leftovers is a test that fails for the wrong reason.
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-doc-'));
    try {
      initRepo(own);
      write(
        path.join(own, 'pipeline.py'),
        [
          'def run(job):',
          '    """Send a job through the shouter.',
          '',
          '    Args: job — ignored here.',
          '    """',
          '    return job',
          '',
        ].join('\n'),
      );
      commitAll(own, 'add pipeline');

      const r = await digest(own, { write: false });
      const plan = buildCodeTour(r);
      const quoted = plan.steps.filter((s) => s.text.includes('The author says'));

      expect(quoted.length).toBeGreaterThan(0);
      // the sentence is kept, the Args: section is cut
      expect(quoted[0]!.text).toContain('Send a job through the shouter.');
      expect(quoted[0]!.text).not.toContain('Args:');
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });

  it('closes with an honest account of what it did and did not cover', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const last = plan.steps[plan.steps.length - 1]!;

    // It names the coverage rather than implying the tour was the whole repo...
    expect(last.text).toContain(r.inventory.files.length.toLocaleString());
    expect(last.text).toMatch(/did not hide the rest/);
    // ...and it is the tour talking about itself, so stage 4 must leave it alone.
    expect(last.synthetic).toBe(true);
  });

  it('spreads its stops instead of drowning in the top-ranked file', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const perFile = new Map<string, number>();
    for (const s of plan.steps) perFile.set(s.file, (perFile.get(s.file) ?? 0) + 1);

    // No single file may take more than a third of the tour. app.py once took 7 of 14.
    const worst = Math.max(...perFile.values());
    expect(worst).toBeLessThanOrEqual(Math.ceil(plan.steps.length / 3));
    // And no file on the itinerary gets a lone "here is a file" nod.
    for (const f of plan.itinerary) expect(perFile.get(f) ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('renders a self-contained repo page with the code actually in it', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    // the real source text is embedded, not just its metrics
    expect(html).toContain('def run(job)');
    expect(html).toMatch(/window\.__STEPS__/);
    // The tour must never start on its own — it waits for the button.
    expect(html).toMatch(/id="startbig"/);
    expect(html).toMatch(/btn\.addEventListener\('click', start\)/);
    // And there is exactly ONE start control: the one in the pane you are reading.
    expect((html.match(/▶ Take the tour/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/start\(\);\s*\}\)\(\);/);
    // The guide is a docked panel, not a floating coachmark bubble.
    expect(html).toMatch(/id="guide"/);
    expect(html).not.toMatch(/tour-bubble/);
    expect((html.match(/(?:https?:)?\/\/[a-zA-Z0-9.-]+/g) ?? [])).toEqual([]);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    // and the scoring rubric is NOT on the screen
    expect(html).not.toMatch(/in-degree|churn 0\.45/);
  });
});

describe('the notes panel carries provenance', () => {
  it('ships a notes pane, an anchor, and export controls', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    for (const id of ['tab-notes', 'a-what', 'ntext', 'nsave', 'nlist', 'ncopy', 'ndl', 'gnote']) {
      expect(html, `missing #${id}`).toContain(`id="${id}"`);
    }
    // A note taken during the tour must record which stop prompted it.
    expect(html).toMatch(/anchorFromStop/);
    expect(html).toMatch(/stopIndex/);
    expect(html).toMatch(/prompted by tour stop/);
  });

  it('keeps notes across commits but stamps the one they were taken at', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    // Notes are review material: a new tour must not throw them away...
    expect(html).toMatch(/repotour:notes:' \+ repo\.name/);
    // ...but a note taken against code that has since moved must say so, not sit there
    // looking as though it still applies.
    expect(html).toMatch(/head: repo\.head/);
    expect(html).toMatch(/code has moved/);
    const head = r.manifest.repos.find((x) => x.root === '')?.head;
    expect(html).toContain(head!);
  });

  it('says on the page that it is a snapshot of one commit', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    // A static page cannot know it has gone stale, so it must at least be honest about
    // being static — refreshing it will never pick up new code.
    expect(html).toMatch(/A snapshot of/);
    // It must be clear that a file cannot gain FEATURES either, not just code — that was
    // the actual confusion: refreshing an old export and wondering where chapters were.
    expect(html).toMatch(/new chapters/);
    expect(html).toMatch(/start\.sh/);
  });

  it('every piece of client script is valid JavaScript', async () => {
    // A stray escape inside a template literal once emitted `/\r?\n/` as a real newline
    // inside a regex, which killed the whole app script and left an empty file tree. The
    // page renders fine and does nothing, so only parsing it catches this.
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThan(3);
    for (const [i, code] of blocks.entries()) {
      expect(() => new Function(code), `script block ${i} does not parse`).not.toThrow();
    }
  });
});

describe('the app refreshes on real change, not on its own output', () => {
  it('ignores its own .repo-tour cache when deciding the repo has moved', async () => {
    // The digest writes its cache INTO the repo, so `git status` reports it. Fingerprinting
    // that would make every build look like a change, leaving the page permanently "stale"
    // and rebuilding forever — which is exactly what happened the first time.
    const before = fingerprint(root);

    await digest(root, { write: true });
    const afterCacheWritten = fingerprint(root);
    expect(afterCacheWritten, 'writing the cache must not count as a change').toBe(before);

    // A real edit must still be seen.
    write(path.join(root, 'src/newly_added.py'), 'def added():\n    return 1\n');
    const afterRealEdit = fingerprint(root);
    expect(afterRealEdit).not.toBe(before);

    fs.rmSync(path.join(root, 'src/newly_added.py'));
    fs.rmSync(path.join(root, '.repo-tour'), { recursive: true, force: true });
  });
});

describe('the tour is organised in chapters', () => {
  it('gives every stop a chapter, and keeps each chapter contiguous', async () => {
    const r = await digest(root, { write: false });
    const arch = buildArchitecture(r);
    const plan = buildCodeTour(r);
    const steps = [
      ...buildArchitectureSteps(arch, 'fixture', r.inventory.files.length),
      ...plan.steps,
    ];

    for (const s of steps) expect(s.chapter, `no chapter on "${s.title}"`).toBeDefined();

    // A key must never come back after another key has started: chapters are ranges, and
    // a table of contents built from a non-contiguous list would list one twice.
    const seen = new Set<string>();
    let last = '';
    for (const s of steps) {
      const key = s.chapter!.key;
      if (key !== last) {
        expect(seen.has(key), `chapter "${key}" resumes after another`).toBe(false);
        seen.add(key);
        last = key;
      }
    }
  });

  it('makes the system one chapter and each file its own', async () => {
    const r = await digest(root, { write: false });
    const arch = buildArchitecture(r);
    const plan = buildCodeTour(r);

    const archSteps = buildArchitectureSteps(arch, 'fixture', r.inventory.files.length);
    if (archSteps.length) {
      expect(new Set(archSteps.map((s) => s.chapter!.key)).size).toBe(1);
    }
    for (const file of plan.itinerary) {
      const mine = plan.steps.filter((s) => s.file === file && !s.synthetic);
      expect(new Set(mine.map((s) => s.chapter!.key))).toEqual(new Set([file]));
    }
    // The closing stop is its own chapter, not tacked onto the last file's.
    const closing = plan.steps[plan.steps.length - 1]!;
    expect(closing.chapter!.key).toBe('@end');
  });

  it('renders a table of contents you can start from', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    expect(html).toContain('id="idletoc"');   // pickable before the tour starts
    expect(html).toContain('id="chaphead"');  // and reachable during it
    expect(html).toContain('id="gskip"');     // a chapter can be skipped
    expect(html).toMatch(/Next chapter/);
  });
});

describe('the rendered page is well-formed enough to drive', () => {
  it('has no duplicate element ids', async () => {
    // Moving the tour button into the sticky header left the old one behind, so the page
    // shipped two #start buttons — the second one dead. Every selector in the client
    // script assumes ids are unique; this is cheap to check and impossible to eyeball.
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
    const seen = new Set<string>();
    const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(dupes, `duplicate ids: ${[...new Set(dupes)].join(', ')}`).toEqual([]);
  });

  it('wires every id the client script reaches for', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    const wanted = [...html.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]!);
    for (const id of new Set(wanted)) {
      expect(html.includes(`id="${id}"`), `script reaches for #${id}, which the markup never renders`).toBe(true);
    }
  });
});

describe('the page never scrolls itself', () => {
  it('uses no scrollIntoView anywhere in the client script', async () => {
    // scrollIntoView scrolls EVERY scrollable ancestor, so keeping a file-tree row visible
    // also scrolled the document: the page opened 58px down, with the header bars already
    // hidden under the sticky top bar. The tour button looked buried wherever it was put,
    // because the page had moved rather than the button. Container scrolling only.
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n');
    // A CALL, not the word — the comment explaining why we avoid it mentions it by name.
    expect(scripts).not.toMatch(/scrollIntoView\s*\(/);
  });
});

describe('the tour can be started from where the reader is looking', () => {
  it('offers a start button inside the always-visible guide pane, not only in the header', async () => {
    // The header button sits at the far edge of a wide window. The guide pane is the thing
    // a reader is actually looking at when they wonder how to begin, so the tour has to be
    // startable from there too.
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });

    expect(html).toContain('id="startbig"');
    expect(html).toMatch(/btn\.addEventListener\('click', start\)/);
    // and a visible build stamp, so which build is open is never in question
    expect(html).toContain('class="buildstamp"');
  });
});

describe('paths with spaces in them', () => {
  it('resolves module-relative paths without percent-encoding', async () => {
    // `new URL(import.meta.url).pathname` leaves a space as %20, so on a machine where the
    // project lives under "Coding Projects" every module-relative path pointed at a
    // directory literally named "Coding%20Projects" — which fs then CREATED on the Desktop
    // and quietly wrote the interpretation cache, the tour registry and the loaded-repo
    // list into. Nothing failed loudly; it just went to the wrong place.
    const { baseCss } = await import('../src/skins.js');
    const { registryPath } = await import('../src/library.js');
    const { defaultCacheDir } = await import('../src/interpret.js');

    expect(baseCss().length).toBeGreaterThan(100);
    for (const p of [registryPath(), defaultCacheDir()]) {
      expect(p, `${p} is percent-encoded`).not.toMatch(/%[0-9A-Fa-f]{2}/);
    }
  });
});

describe('a page the app served knows where it came from', () => {
  it('carries a back link and a live-reload poll only when served', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);

    // Exported to a file, there is nowhere to go back TO and no server to watch.
    const exported = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });
    expect(exported).not.toContain('All repositories');
    expect(exported).not.toMatch(/api\/version/);

    // Served by the app, both belong.
    const served = renderRepoView(r, {
      steps: plan.steps, itinerary: plan.itinerary,
      servedBy: { homeUrl: '/', repoPath: '/tmp/x', builtAt: '2026-01-01T00:00:00Z' },
    });
    expect(served).toContain('All repositories');
    expect(served).toMatch(/api\/version/);

    // The baseline must be read at load, never baked in. Rendered pages are cached to disk,
    // so a page built by one server run gets served by a later one — a baked-in id is stale
    // immediately, disagrees on the first poll, and reloads the page every two seconds.
    expect(served).toMatch(/mine === null/);
    expect(served).not.toMatch(/var mine = "/);
  });

  it('reads the stylesheet per render, so editing a skin needs no restart', async () => {
    // A module-level `const STYLE = baseCss()` is read once when the process starts, so a
    // CSS change could only reach a running server by restarting it.
    const src = fs.readFileSync(new URL('../src/repoview.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/const STYLE\s*=/);
    expect(src).toMatch(/\$\{baseCss\(\)\}/);
  });
});

describe('a built tour survives the server restarting', () => {
  it('re-finds a build on disk instead of reporting "not built yet"', async () => {
    // The rendered page used to live only in memory, so every restart showed every
    // repository as unbuilt — and once the server began restarting on its own source
    // changes, that was constantly. The digest and the interpretations survived, so a
    // rebuild was cheap; but "not built yet" reads as "your work is gone".
    const { RepoTourServer } = await import('../src/server.js');

    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-restart-'));
    const state = path.join(own, 'loaded.json');
    try {
      initRepo(own);
      write(path.join(own, 'core.py'), [
        'def run(job):',
        '    """Do the thing."""',
        '    return job',
        '',
        'def stop(job):',
        '    """Undo the thing."""',
        '    return None',
        '',
      ].join('\n'));
      commitAll(own, 'init');

      // interpret:false keeps this a pure structure test — no model is called.
      const first = new RepoTourServer({ statePath: state, interpret: false });
      expect(first.addRepo(own).ok).toBe(true);
      await first.build(own, () => {});
      expect(first.listRepos()[0]!.built).not.toBeNull();

      // A brand new instance: nothing carried over in memory.
      const second = new RepoTourServer({ statePath: state, interpret: false });
      const seen = second.listRepos()[0]!;
      expect(seen.built, 'a fresh server should find the build on disk').not.toBeNull();
      expect(seen.current, 'and recognise it as current for this tree').toBe(true);
      expect(seen.built!.stops).toBeGreaterThan(0);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('building is a decision, not a consequence of loading a repo', () => {
  it('adding a repository starts nothing', async () => {
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-choice-'));
    try {
      initRepo(own);
      write(path.join(own, 'a.py'), 'def go(x):\n    """Do it."""\n    return x\n');
      commitAll(own, 'init');

      const server = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      expect(server.addRepo(own).ok).toBe(true);

      // Loading a repository and spending minutes on it are two different decisions.
      const listed = server.listRepos()[0]!;
      expect(listed.running, 'adding a repo must not start a build').toBe(false);
      expect(listed.built).toBeNull();
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });

  it('but a repo that HAS been built rebuilds when the tree moves', async () => {
    // The two behaviours share a route and must not be collapsed: never-built waits to be
    // asked, already-built refreshes itself. That is the whole point of the app over a file.
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-rebuild-'));
    try {
      initRepo(own);
      write(path.join(own, 'a.py'), 'def go(x):\n    """Do it."""\n    return x\n');
      commitAll(own, 'init');

      const server = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      server.addRepo(own);
      await server.build(own, () => {});
      expect(server.listRepos()[0]!.current).toBe(true);

      write(path.join(own, 'b.py'), 'def stop(x):\n    """Halt it."""\n    return None\n');
      expect(server.listRepos()[0]!.current, 'an edited tree is no longer current').toBe(false);
      expect(server.listRepos()[0]!.built, 'but the old build is still there to serve meanwhile').not.toBeNull();
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('the landing page', () => {
  it('serves images by exact name only', async () => {
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-img-'));
    try {
      const server = new RepoTourServer({ statePath: path.join(own, 'state.json') });
      const ask = async (url: string): Promise<number> => {
        let status = 0;
        const res = {
          writeHead(code: number) { status = code; return this; },
          end() { return this; },
        } as unknown as import('node:http').ServerResponse;
        await server.handler({ url, method: 'GET' } as import('node:http').IncomingMessage, res);
        return status;
      };

      // A server sitting in front of somebody's private repositories must not hand out
      // arbitrary paths from disk because a URL asked nicely.
      for (const bad of [
        '/img/../../package.json',
        '/img/../src/server.ts',
        '/img/%2e%2e%2fpackage.json',
        '/img/nested/thing.jpg',
        '/img/hero.jpg.ts',
      ]) {
        expect(await ask(bad), `${bad} should be refused`).toBe(404);
      }
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });

  it('credits the photographer, and works with no photograph at all', async () => {
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-home-'));
    try {
      const server = new RepoTourServer({ statePath: path.join(own, 'state.json') });
      let body = '';
      const res = {
        writeHead() { return this; },
        end(chunk?: string) { if (chunk) body = chunk; return this; },
      } as unknown as import('node:http').ServerResponse;
      await server.handler({ url: '/', method: 'GET' } as import('node:http').IncomingMessage, res);

      expect(body).toContain('Be walked through a repository');
      // Attribution is an obligation; the credit is rendered whenever an image exists.
      const hasImage = fs.existsSync(new URL('../assets/img/hero.jpg', import.meta.url));
      if (hasImage) expect(body).toMatch(/class="credit"/);
      // And the hero is a designed band either way — never a broken image.
      expect(body).toMatch(/class="hero/);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('a build survives the process dying', () => {
  it('records that it is building, and a fresh server picks it up', async () => {
    // The server restarts — on a code change, on a crash, on Ctrl-C — and an in-process
    // build dies with it. Without a marker the card goes back to "no tour yet", which is the
    // worst possible presentation: minutes of work gone, and the only signal says you never
    // started. This cost Evan several attempts in a row while the watcher was restarting on
    // every commit.
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-resume-'));
    try {
      initRepo(own);
      write(path.join(own, 'a.py'), 'def go(x):\n    """Do it."""\n    return x\n');
      commitAll(own, 'init');

      const first = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      first.addRepo(own);

      // Simulate a build that was interrupted before it finished.
      const marker = path.join(own, '.repo-tour', 'building.json');
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ startedAt: new Date().toISOString(), lines: ['reading the tree…'] }));

      const second = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      const seen = second.listRepos()[0]!;
      expect(seen.running, 'a fresh server should resume the interrupted build').toBe(true);
      expect(seen.resumed, 'and say so, rather than looking like a fresh start').toBe(true);
      await settle(second);
      await settle(first);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });

  it('ignores a marker old enough that nobody is waiting for it', async () => {
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-stale-'));
    try {
      initRepo(own);
      write(path.join(own, 'a.py'), 'def go(x):\n    return x\n');
      commitAll(own, 'init');

      const first = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      first.addRepo(own);

      const marker = path.join(own, '.repo-tour', 'building.json');
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(marker, JSON.stringify({ startedAt: longAgo, lines: [] }));

      const second = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      expect(second.listRepos()[0]!.running, 'a day-old marker must not start work').toBe(false);
      expect(fs.existsSync(marker), 'and should be cleared').toBe(false);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('a tour stays reachable when the code moves under it', () => {
  it('serves the older build rather than making it unreachable', async () => {
    // Before this, a changed repo sent /r straight to a build page: every edit made the
    // existing tour unreadable for minutes. A tour pinned to an older commit is still the
    // truth about that commit — it does not stop being worth reading because a file changed.
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-stale-serve-'));
    try {
      initRepo(own);
      write(path.join(own, 'a.py'), 'def go(x):\n    """Do it."""\n    return x\n');
      commitAll(own, 'init');

      const server = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      server.addRepo(own);
      await server.build(own, () => {});
      expect(server.listRepos()[0]!.current).toBe(true);

      write(path.join(own, 'b.py'), 'def stop(x):\n    """Halt."""\n    return None\n');

      const listed = server.listRepos()[0]!;
      expect(listed.current, 'the tree has moved').toBe(false);
      expect(listed.built, 'but the built tour is still reported, not hidden').not.toBeNull();

      let body = '';
      const res = {
        writeHead() { return this; },
        end(chunk?: string) { if (chunk) body = chunk; return this; },
      } as unknown as import('node:http').ServerResponse;
      await server.handler(
        { url: `/r?path=${encodeURIComponent(own)}`, method: 'GET' } as import('node:http').IncomingMessage,
        res,
      );

      // The real tour, not a "building" or "not built" page.
      expect(body).toContain('id="startbig"');
      expect(body).not.toContain('has no tour yet');
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });

  it('marks the staleness in a corner chip, not a banner', async () => {
    const r = await digest(root, { write: false });
    const plan = buildCodeTour(r);
    const html = renderRepoView(r, {
      steps: plan.steps, itinerary: plan.itinerary,
      servedBy: { homeUrl: '/', repoPath: root, builtAt: '2026-01-01T00:00:00Z' },
    });

    expect(html).toMatch(/freshchip/);
    expect(html).toMatch(/the code has moved since this tour/);
    // A newer build is OFFERED, never forced on a reader mid-tour.
    expect(html).toMatch(/a newer tour is ready/);
    expect(html).toMatch(/Show it/);
    // Corner, fixed, small — not a full-width strip.
    expect(html).toMatch(/\.freshchip \{[^}]*position:\s*fixed/);
  });
});

describe('a cached page carries the renderer that made it', () => {
  it('will not reuse a page built by a different presentation', async () => {
    // Pages are cached to disk with their CSS inlined, because a tour must open from file://
    // with no network. So a page carries the presentation it was built with, forever: adding
    // two skins changed nothing about any tour already on disk — neither their CSS nor their
    // options were in those files, so the picker could not offer what was not there.
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-pv-'));
    try {
      initRepo(own);
      write(path.join(own, 'a.py'), 'def go(x):\n    """Do it."""\n    return x\n');
      commitAll(own, 'init');

      const server = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      server.addRepo(own);
      await server.build(own, () => {});
      expect(server.listRepos()[0]!.current).toBe(true);

      // Every stored build records the renderer that produced it.
      const dir = path.join(own, '.repo-tour', 'rendered');
      const metaFile = fs.readdirSync(dir).find((f) => f.endsWith('.json'))!;
      const metaPath = path.join(dir, metaFile);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { presentation: string };
      expect(meta.presentation, 'a build must record its presentation').toBeTruthy();

      // Pretend it was built by an older renderer — the shape of "we added a skin since".
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, presentation: 'from-before' }));

      // `current` stays true — it is a claim about the CODE, and the code has not moved.
      // What must change is that the stale page is no longer REUSED: opening the tour starts
      // a rebuild behind the reader, which is how a new skin reaches a page already on disk.
      const fresh = new RepoTourServer({ statePath: path.join(own, 'state.json'), interpret: false });
      expect(fresh.listRepos()[0]!.running, 'nothing running before it is opened').toBe(false);

      const res = {
        writeHead() { return this; },
        end() { return this; },
      } as unknown as import('node:http').ServerResponse;
      await fresh.handler(
        { url: `/r?path=${encodeURIComponent(own)}`, method: 'GET' } as import('node:http').IncomingMessage,
        res,
      );

      expect(
        fresh.listRepos()[0]!.running,
        'opening a page built by an older renderer should rebuild it behind the reader',
      ).toBe(true);
      await settle(fresh);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('the LLM is a choice, not a hardcoded binary', () => {
  it('registers providers with models and an availability check', async () => {
    const { PROVIDERS, surveyProviders, providerById } = await import('../src/llm.js');

    expect(PROVIDERS.length).toBeGreaterThanOrEqual(3);
    for (const p of PROVIDERS) {
      expect(p.id, 'a provider needs an id').toBeTruthy();
      expect(p.models.length, `${p.id} must offer at least one model`).toBeGreaterThan(0);
      expect(typeof p.run).toBe('function');
      expect(typeof p.available).toBe('function');
    }
    expect(providerById('claude')).not.toBeNull();
    expect(providerById('nope')).toBeNull();

    // Availability is asked, never assumed: an absent provider is a state, not a crash.
    const survey = await surveyProviders();
    expect(survey.length).toBe(PROVIDERS.length);
    for (const p of survey) expect(typeof p.availability.detail).toBe('string');
  });

  it('falls back to a real choice rather than trusting stored junk', async () => {
    const { resolveChoice, DEFAULT_PROVIDER } = await import('../src/llm.js');

    expect(resolveChoice(null).provider).toBe(DEFAULT_PROVIDER);
    expect(resolveChoice({ provider: 'does-not-exist' }).provider).toBe(DEFAULT_PROVIDER);
    // A model the provider does not offer falls back to that provider's own default.
    const odd = resolveChoice({ provider: 'claude', model: 'gpt-9' });
    expect(odd.provider).toBe('claude');
    expect(odd.model).not.toBe('gpt-9');
  });

  it('keys cached explanations by WHO wrote them, without discarding old ones', async () => {
    const { stopKey, DEFAULT_MODEL } = await import('../src/interpret.js');

    const sha = 'a'.repeat(64);
    const plain = stopKey(sha, 10, 20);

    // The default writer is absent from the key, so every explanation already paid for
    // under the original format is still found.
    expect(stopKey(sha, 10, 20, { provider: 'claude', model: DEFAULT_MODEL })).toBe(plain);

    // Any other writer gets its own cache alongside, because a local 7B model and Sonnet
    // do not produce interchangeable prose.
    expect(stopKey(sha, 10, 20, { provider: 'codex', model: 'default' })).not.toBe(plain);
    expect(stopKey(sha, 10, 20, { provider: 'claude', model: 'claude-opus-5' })).not.toBe(plain);
  });

  it('remembers the choice on the server, not in a browser', async () => {
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-llm-'));
    try {
      const state = path.join(own, 'state.json');
      const first = new RepoTourServer({ statePath: state });
      expect(first.getChoice().provider).toBe('claude');

      // It decides what a build costs and where source is sent — a property of the app,
      // not of whichever tab happens to be open.
      first.setChoice({ provider: 'codex' });
      const second = new RepoTourServer({ statePath: state });
      expect(second.getChoice().provider).toBe('codex');
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('the app can be stopped', () => {
  it('closes promptly with a connection held open', async () => {
    // Under `tsx watch` the app restarts on every source change, so stopping happens
    // constantly. Two things used to hold it open past the signal: keep-alive sockets from
    // the pages polling every two seconds, and model calls that run for minutes. The
    // supervisor gave up after five seconds, force-killed, and nothing came back listening —
    // which reads as the app being broken rather than as a slow stop.
    const { RepoTourServer } = await import('../src/server.js');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-stop-'));
    try {
      const server = new RepoTourServer({ statePath: path.join(own, 'state.json'), port: 0 });
      const { port, close } = await server.listen();

      // A keep-alive client, exactly like a page polling.
      const http = await import('node:http');
      const agent = new http.Agent({ keepAlive: true });
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/version', agent },
          (res) => { res.resume(); res.on('end', () => resolve()); },
        );
        req.end();
      });

      const started = Date.now();
      await close();
      const took = Date.now() - started;

      expect(took, 'closing must not wait on a keep-alive socket').toBeLessThan(2500);
      agent.destroy();
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });

  it('exposes a way to stop in-flight model calls', async () => {
    // A build killed mid-flight resumes from its marker, so killing children is safe —
    // and it is the only way the process can exit while a five-minute call is running.
    const { killLlmChildren } = await import('../src/llm.js');
    expect(typeof killLlmChildren).toBe('function');
    expect(() => killLlmChildren()).not.toThrow();   // a no-op with nothing running
  });
});

// ---------------------------------------------------------------------------
// T-5 §8 — two levels of explanation. Criteria 11-14.
//
// The rule these pin down is Evan's correction at the spec gate: the default level is the
// whole explanation COMPRESSED, and the press restores the ORIGINAL. Criterion 12 is a
// byte-identity requirement, which makes `fullText` a contract rather than an
// implementation detail — these tests exist so nobody "tidies" it later.

describe('every stop is tweet-sized by default, and expanding restores the original', () => {
  const meaning = {
    what:
      'It walks the tree once, registering a repository at every .git it meets, and hashes ' +
      'each file it keeps so a later run can tell what actually changed. The walk is ' +
      'structural rather than git-driven because a nested repository is invisible to the ' +
      'parent, and reporting only the parent would silently drop most of the code.',
    why:
      'Discovery had to survive repos-inside-repos, which is the shape the first real ' +
      'target turned out to have.',
    summary: 'Walks the tree, treating every nested .git as its own repo, and hashes files so later runs can tell what changed.',
  };

  it('criterion 11 — a written summary is used as-is and stays under the cap', () => {
    const [step] = applyMeanings(
      [{ file: 'a.ts', startLine: 1, endLine: 9, title: 'walk', text: 'deterministic' }],
      [],
      new Map([[stepKey('a.ts', 1, 9), meaning]]),
    );
    expect(step!.summary).toBe(meaning.summary);
    expect(step!.summary!.length).toBeLessThanOrEqual(SUMMARY_MAX);
  });

  it('criterion 12 — the expanded text is exactly what the tour rendered before', () => {
    // The pre-change formula, written out longhand. If someone changes `fullText`, this
    // fails and they have to justify it against the criterion rather than discover it.
    const expectedFull = `${meaning.what} ${meaning.why}`;
    expect(fullText(meaning)).toBe(expectedFull);

    const [step] = applyMeanings(
      [{ file: 'a.ts', startLine: 1, endLine: 9, title: 'walk', text: 'deterministic' }],
      [],
      new Map([[stepKey('a.ts', 1, 9), meaning]]),
    );
    expect(step!.text).toBe(expectedFull);
  });

  it('criterion 11 — an uninterpreted stop still gets a summary, cut at a sentence', () => {
    const long =
      'This stop was never interpreted. It carries deterministic facts only. ' +
      'x'.repeat(600);
    const n = narrate({ text: long, summary: undefined });
    expect(n.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(n.summary).toBe('This stop was never interpreted. It carries deterministic facts only.');
    expect(n.full).toBe(long);
    expect(n.expandable).toBe(true);
  });

  it('a summary that already fits is never truncated or ellipsised', () => {
    const short = 'Short enough to stand on its own.';
    const n = narrate({ text: short, summary: undefined });
    expect(n.summary).toBe(short);
    expect(n.expandable).toBe(false);
  });

  it('a first sentence longer than the budget is cut on a word, never mid-word', () => {
    const runOn = `${'alpha '.repeat(120)}end.`;
    const out = compress(runOn);
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/alph…$/);
  });

  it('criterion 14 — repo-tour steps reach the page through the shared narrator', async () => {
    const result = await digest(root, { write: false });
    const plan = buildCodeTour(result, { maxFiles: 3, perFile: 2 });
    const html = renderRepoView(result, { steps: plan.steps, itinerary: plan.itinerary });

    const embedded = /window\.__STEPS__ = (\[.*?\]);<\/script>/s.exec(html);
    expect(embedded).not.toBeNull();
    const steps = JSON.parse(embedded![1]!) as Array<{ summary?: string; text: string }>;
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(typeof s.summary).toBe('string');
      expect(s.summary!.length).toBeGreaterThan(0);
      expect(s.summary!.length).toBeLessThanOrEqual(SUMMARY_MAX);
    }
  });

  it('the page ships both levels and a way to move between them', async () => {
    const result = await digest(root, { write: false });
    const plan = buildCodeTour(result, { maxFiles: 2, perFile: 2 });
    const html = renderRepoView(result, { steps: plan.steps, itinerary: plan.itinerary });
    expect(html).toContain('id="gfull"');
    expect(html).toContain('id="gexpand"');
    expect(html).toContain('id="gdepth"');
    // the notes panel must capture the FULL explanation, not the compressed one: a note
    // tagged against a blurb loses the provenance T-3 exists to provide
    expect(html).toContain('explanation: step.text');
  });
});

// ---------------------------------------------------------------------------
// T-5 §2/§5 — the meaning delta. Criteria 3, 4, 5, 6.
//
// These are the ticket's proof. Spec §10 named the primary risk out loud: stage 4 is a
// model, and if a model re-wording itself scored the same as a change of subject, the whole
// premise collapses. Criterion 4 is the test that would catch that, so it is written to
// FAIL loudly rather than to be satisfiable by a loose threshold.

const sym = (name: string, kind: SymbolRecord['kind'] = 'function', exported = true): SymbolRecord =>
  ({ name, kind, line: 1, endLine: 2, exported, doc: null });

const asExtract = (p: string, symbols: SymbolRecord[], imports: string[] = []): FileExtract => ({
  path: p,
  language: 'typescript',
  symbols,
  imports: imports.map((raw, i) => ({ raw, resolved: raw, line: i + 1 })),
  parseErrors: 0,
});

describe('the meaning delta separates a re-wording from a change of subject', () => {
  const retryVocab = vocabularyOf([sym('retryBudget'), sym('spendRetry')], ['./transport.js']);

  it('criterion 4 — a paraphrase of the same claim scores near zero', () => {
    const d = meaningDistance(
      'It manages the retry budget for outbound calls, spending from it on each failure and refusing once exhausted.',
      'It handles the retry budget for outbound calls, drawing down on every failure and declining once it is used up.',
      [sym('retryBudget')],
      retryVocab,
    );
    expect(d).toBeLessThan(0.15);
  });

  it('criterion 4 — even an aggressive re-wording stays in the low band', () => {
    // Every verb swapped: parses->reads, validates->checks, touches->gets. This is the
    // worst realistic case for the comparison and it is deliberately kept as a test rather
    // than tuned away, because the honest number matters more than a pretty one.
    const loaderVocab = vocabularyOf([sym('parseManifest'), sym('validateEntry'), sym('loadSchema')], ['./schema.js']);
    const d = meaningDistance(
      'Parses the manifest and validates every entry against the schema before the loader touches it.',
      'Reads the manifest and checks each entry against the schema before the loader gets to it.',
      [sym('parseManifest')],
      loaderVocab,
    );
    expect(d).toBeLessThan(0.45);
  });

  it('a changed subject scores high, and well clear of any re-wording', () => {
    const d = meaningDistance(
      'It manages the retry budget for outbound calls, spending from it on each failure and refusing once exhausted.',
      'It manages the connection pool for outbound calls, leasing sockets and closing idle ones after a timeout.',
      [sym('retryBudget')],
      retryVocab,
    );
    expect(d).toBeGreaterThan(0.7);
  });

  it('criterion 4 — a refactor is reported as a refactor, in words', () => {
    // A genuine paraphrase: the verbs move, the subjects do not.
    const same = { what: 'Ranks files by churn, in-degree and size.', why: 'Size alone buries the important small files.', summary: 's' };
    const reworded = { what: 'Orders files by churn, in-degree and size.', why: 'Size alone hides the important small files.', summary: 's' };
    const d = fileDelta({
      path: 'src/rank.ts', status: 'M', linesChanged: 900,
      before: [same], after: [reworded],
      // the vocabulary a real ranking module has — churn, in-degree and size are its
      // subjects, and a paraphrase keeps every one of them
      beforeExtract: asExtract('src/rank.ts', [sym('rank'), sym('churnFor'), sym('inDegree'), sym('sizeOf')]),
      afterExtract: asExtract('src/rank.ts', [sym('rank'), sym('churnFor'), sym('inDegree'), sym('sizeOf')]),
    });
    expect(d.meaningDelta).toBeLessThan(0.15);
    expect(d.reason).toMatch(/refactor/);
  });

  it('criterion 5 — a small semantic change outranks a large cosmetic one', () => {
    const cosmetic = fileDelta({
      path: 'src/big.ts', status: 'M', linesChanged: 900,
      before: [{ what: 'Formats the report for the terminal.', why: 'Readability.', summary: 's' }],
      after: [{ what: 'Formats the report for the terminal.', why: 'Readability.', summary: 's' }],
      beforeExtract: asExtract('src/big.ts', [sym('formatReport')]),
      afterExtract: asExtract('src/big.ts', [sym('formatReport')]),
    });
    const semantic = fileDelta({
      path: 'src/small.ts', status: 'M', linesChanged: 12,
      before: [{ what: 'Caches digests keyed by content hash.', why: 'Renames stay free.', summary: 's' }],
      after: [{ what: 'Caches digests keyed by file path.', why: 'Simpler invalidation for the watcher.', summary: 's' }],
      beforeExtract: asExtract('src/small.ts', [sym('cacheKey')]),
      afterExtract: asExtract('src/small.ts', [sym('cacheKey')]),
    });
    expect(semantic.meaningDelta).toBeGreaterThan(cosmetic.meaningDelta);
    const ordered = orderByMeaning([cosmetic, semantic]);
    expect(ordered[0]!.path).toBe('src/small.ts');
    // criterion 3: the ordering is NOT the diff's ordering
    expect(ordered.map((d) => d.linesChanged)).toEqual([12, 900]);
  });

  it('a public surface change is a floor the prose cannot talk down', () => {
    const d = fileDelta({
      path: 'src/api.ts', status: 'M', linesChanged: 3,
      before: [{ what: 'Exposes the client.', why: 'Entry point.', summary: 's' }],
      after: [{ what: 'Exposes the client.', why: 'Entry point.', summary: 's' }],
      beforeExtract: asExtract('src/api.ts', [sym('connect'), sym('disconnect')]),
      afterExtract: asExtract('src/api.ts', [sym('connect')]),
    });
    expect(d.surface.removed).toEqual(['disconnect']);
    expect(d.meaningDelta).toBeGreaterThanOrEqual(0.5);
    expect(d.reason).toMatch(/public surface/);
  });

  it('criterion 6 — the ripple is one hop of meaning and N hops of structure, both counted', () => {
    const graph = {
      nodes: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      edges: [
        { from: 'b.ts', to: 'a.ts' }, // b imports a  -> first hop
        { from: 'c.ts', to: 'b.ts' }, // c imports b  -> second hop
        { from: 'd.ts', to: 'c.ts' }, // d imports c  -> third hop
      ],
      inDegree: {},
      coverage: { totalImports: 3, resolvedInternal: 3, leftTheTree: 0, filesParsed: 4, filesWithParseErrors: 0 },
    };
    const r = ripple(graph, ['a.ts']);
    expect(r.reinterpret).toEqual(['b.ts']);
    expect(r.structuralOnly).toEqual(['c.ts', 'd.ts']);
    expect(r.reachable).toBe(3);
  });

  it('an uninterpreted side is said out loud, not scored as calm', () => {
    const d = fileDelta({
      path: 'src/x.ts', status: 'M', linesChanged: 40,
      before: [], after: [{ what: 'Does a thing.', why: '', summary: 's' }],
    });
    expect(d.interpreted).toBe(false);
    expect(d.reason).toMatch(/not interpreted/);
    expect(d.meaningDelta).toBeGreaterThan(0);
  });
});

describe('a direct verdict beats a guess from two summaries', () => {
  it('an adjudicated file scores from the verdict, and says so', () => {
    const d = fileDelta({
      path: 'src/rank.ts', status: 'M', linesChanged: 16,
      // the interpretations genuinely differ - this is the real failure that forced
      // adjudicate.ts to exist, kept here so a regression cannot pass quietly
      before: [{ what: 'Counts commit touches per file across every repo, tallying git log output into a churn map.', why: 'Churn is a ranking signal.', summary: 's' }],
      after: [{ what: 'Walks each repo history, shelling out to git log and normalising paths via path.posix.normalize into one unified map.', why: 'Heavily edited files are hotter.', summary: 's' }],
      beforeExtract: asExtract('src/rank.ts', [sym('churnByFile')]),
      afterExtract: asExtract('src/rank.ts', [sym('churnByFile')]),
      adjudication: { magnitude: 0, headline: 'Five local variables renamed; behaviour unchanged.', kind: 'refactor', source: 'model' },
    });
    expect(d.meaningDelta).toBe(0);
    expect(d.basis).toBe('adjudicated');
    expect(d.reason).toMatch(/renamed/);
  });

  it('without a verdict the same input scores high — which is why the verdict exists', () => {
    const d = fileDelta({
      path: 'src/rank.ts', status: 'M', linesChanged: 16,
      before: [{ what: 'Counts commit touches per file across every repo, tallying git log output into a churn map.', why: 'Churn is a ranking signal.', summary: 's' }],
      after: [{ what: 'Walks each repo history, shelling out to git log and normalising paths via path.posix.normalize into one unified map.', why: 'Heavily edited files are hotter.', summary: 's' }],
      beforeExtract: asExtract('src/rank.ts', [sym('churnByFile')]),
      afterExtract: asExtract('src/rank.ts', [sym('churnByFile')]),
    });
    expect(d.basis).toBe('claims');
    expect(d.meaningDelta).toBeGreaterThan(0.3);
  });

  it('an unreachable model is a gap, never a quiet zero', () => {
    const d = fileDelta({
      path: 'src/x.ts', status: 'M', linesChanged: 4,
      before: [], after: [],
      adjudication: { magnitude: 0.5, headline: 'Could not judge this file.', kind: 'unclear', source: 'unavailable' },
    });
    expect(d.basis).not.toBe('adjudicated');
    expect(d.meaningDelta).toBeGreaterThan(0);
  });

  it('criterion 13 — a moved stop says so in its summary, before any press', () => {
    const refs = {
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null,
      baseLabel: 'main', headLabel: 'feature', baseAhead: 0,
      prose: { title: 'A change', body: null, commits: [], issues: [], source: 'git-only' as const },
    };
    const deltas: FileDelta[] = [
      { path: 'src/rank.ts', status: 'M', linesChanged: 2, meaningDelta: 0.6, surface: { added: [], removed: [], changed: [] }, interpreted: true, reason: 'the test multiplier dropped from 0.5 to 0.05', basis: 'adjudicated' },
      { path: 'src/rollup.ts', status: 'M', linesChanged: 40, meaningDelta: 0, surface: { added: [], removed: [], changed: [] }, interpreted: true, reason: 'documentation only', basis: 'adjudicated' },
    ];
    const plan = buildPrTour({
      refs, deltas,
      ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
      staleness: { sha: 'b'.repeat(40), behind: 0, overlap: [], current: true },
      hunksByFile: new Map(),
    });
    const moved = plan.steps.find((s) => s.file === 'src/rank.ts' && !s.synthetic);
    expect(moved!.summary).toMatch(/MEANING MOVED/);
    // criterion 3: the smaller diff comes first because its meaning moved further
    const order = plan.steps.filter((s) => !s.synthetic).map((s) => s.file);
    expect(order.indexOf('src/rank.ts')).toBeLessThan(order.indexOf('src/rollup.ts'));
  });

  it('criterion 8 — a why with no source is admitted, never invented', () => {
    const refs = {
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null,
      baseLabel: 'main', headLabel: 'feature', baseAhead: 0,
      prose: { title: 'A change', body: null, commits: [], issues: [], source: 'github' as const },
    };
    expect(whyFor(refs, 'src/rank.ts')).toBeNull();
    const plan = buildPrTour({
      refs,
      deltas: [{ path: 'src/rank.ts', status: 'M', linesChanged: 2, meaningDelta: 0.6, surface: { added: [], removed: [], changed: [] }, interpreted: true, reason: 'r', basis: 'adjudicated' }],
      ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
      staleness: { sha: 'b'.repeat(40), behind: 0, overlap: [], current: true },
      hunksByFile: new Map(),
    });
    const stop = plan.steps.find((s) => s.file === 'src/rank.ts' && !s.synthetic);
    expect(stop!.text).toMatch(/recorded no reason/);
  });

  it('a why that IS sourced cites where it came from', () => {
    const refs = {
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null,
      baseLabel: 'main', headLabel: 'feature', baseAhead: 0,
      prose: {
        title: 'A change', body: null,
        commits: [{ sha: 'c'.repeat(40), message: 'damp test files harder in rank.ts\n\nthey were crowding out real code' }],
        issues: [], source: 'github' as const,
      },
    };
    const why = whyFor(refs, 'src/rank.ts');
    expect(why!.text).toBe('damp test files harder in rank.ts');
    expect(why!.source).toMatch(/^commit cccccccc/);
  });
});

describe('issue links are read from the description, not asked of gh', () => {
  it('closing keywords and bare references both count', () => {
    expect(issueRefs('Closes #12 and mentions #34.\nAlso fixes #7')).toEqual(['#12', '#7', '#34']);
  });
  it('a description with no references yields none', () => {
    expect(issueRefs('No links here. A #tag mid-word like a#9 does not count.')).toEqual([]);
  });
});

describe('the three defects the review found', () => {
  it('a rename is not a new file — its base side is read from the OLD path', () => {
    // Before the fix, the base side came back empty for a renamed path, every symbol
    // looked newly added, and the surface floor scored a ZERO-line rename at 1.00.
    const symbols = [sym('baseCss'), sym('alternateCss'), sym('skinPicker')];
    const asNewFile = fileDelta({
      path: 'src/themes.ts', status: 'R', linesChanged: 0,
      before: [], after: [],
      beforeExtract: undefined,
      afterExtract: asExtract('src/themes.ts', symbols),
    });
    expect(asNewFile.surface.added).toHaveLength(3);
    expect(asNewFile.meaningDelta).toBeGreaterThanOrEqual(0.7);

    const readFromOldPath = fileDelta({
      path: 'src/themes.ts', status: 'R', linesChanged: 0,
      before: [], after: [],
      beforeExtract: asExtract('src/skins.ts', symbols),
      afterExtract: asExtract('src/themes.ts', symbols),
    });
    expect(readFromOldPath.surface.added).toEqual([]);
    expect(readFromOldPath.meaningDelta).toBeLessThan(0.5);
  });

  it('a ref that starts with a dash is refused, never passed to git', () => {
    expect(() => resolvePr(root, { base: '--upload-pack=touch /tmp/pwned', head: 'HEAD' }))
      .toThrow(/refusing a base that starts with/);
  });

  it('a checkpoint written by a different schema is refused, not misread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-schema-'));
    fs.writeFileSync(path.join(dir, 'digest.json'), JSON.stringify({ schemaVersion: 99, repos: [], root: dir }));
    expect(() => loadCheckpoint(dir, dir)).toThrow(/schema v99/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no checkpoint at all is a refusal that says what to run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-nockpt-'));
    expect(() => loadCheckpoint(dir, dir)).toThrow(/repo-tour digest/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('verify-stage findings', () => {
  const base = {
    refs: {
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null,
      baseLabel: 'main', headLabel: 'fx', baseAhead: 0,
      prose: { title: null, body: null, commits: [], issues: [], source: 'git-only' as const },
    },
    ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
    staleness: { sha: 'b'.repeat(40), behind: 0, overlap: [], current: true },
    hunksByFile: new Map(),
  };

  it('a reason opening on an identifier is not re-cased into a symbol that does not exist', () => {
    const plan = buildPrTour({
      ...base,
      deltas: [{
        path: 'src/rank.ts', status: 'M', linesChanged: 16, meaningDelta: 0,
        surface: { added: [], removed: [], changed: [] }, interpreted: true,
        reason: 'churnByFile renames local variables with no logic change',
        basis: 'adjudicated',
      }],
    });
    const stop = plan.steps.find((s) => !s.synthetic)!;
    expect(stop.text).toContain('churnByFile renames');
    expect(stop.text).not.toContain('ChurnByFile');
  });

  it('an ordinary sentence is still capitalised', () => {
    const plan = buildPrTour({
      ...base,
      deltas: [{
        path: 'src/rank.ts', status: 'M', linesChanged: 4, meaningDelta: 0.6,
        surface: { added: [], removed: [], changed: [] }, interpreted: true,
        reason: 'the test multiplier dropped from 0.5 to 0.05', basis: 'adjudicated',
      }],
    });
    const stop = plan.steps.find((s) => !s.synthetic)!;
    expect(stop.text).toContain('The test multiplier dropped');
  });
});

describe('T-8 — the Pull requests tab is reachable, not decoration', () => {
  it('a served page links the tab when there is a GitHub remote', async () => {
    const r = await digest(process.cwd(), { write: false });
    const plan = buildCodeTour(r, { maxFiles: 1, perFile: 2 });
    const html = renderRepoView(r, {
      steps: plan.steps, itinerary: plan.itinerary,
      servedBy: { homeUrl: '/', repoPath: process.cwd(), builtAt: new Date().toISOString() },
    });
    expect(html).toMatch(/<a class="tab off live" href="\/prs\?path=/);
    expect(html).not.toMatch(/<span class="tab off">Pull requests<\/span>/);
  });

  it('an exported page says why the tab is inert instead of just being dead', async () => {
    const r = await digest(process.cwd(), { write: false });
    const plan = buildCodeTour(r, { maxFiles: 1, perFile: 2 });
    const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });
    expect(html).toMatch(/<span class="tab off" title="[^"]*repo-tour serve[^"]*">Pull requests<\/span>/);
  });

  it('an empty list and a broken tool do not look the same', async () => {
    // three outcomes, three different things said on the page
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-noremote-'));
    const noRemote = await listPrs(dir);
    expect(noRemote.ok).toBe(false);
    if (!noRemote.ok) {
      expect(noRemote.reason).toMatch(/no GitHub remote/);
      expect(noRemote.remedy).toMatch(/--base/);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('a pull request is the branch\'s own work, not everything the base gained', () => {
  let prRoot: string;
  let trunk: string;

  beforeAll(() => {
    prRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-3dot-'));
    initRepo(prRoot);
    fs.writeFileSync(path.join(prRoot, 'a.ts'), 'export const a = 1;\n');
    git(prRoot, 'add', '-A'); git(prRoot, 'commit', '-m', 'base');
    // whatever git called the first branch here — init.defaultBranch is not universal
    trunk = execFileSync('git', ['-C', prRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8' }).trim();
    // branch off, change ONE file
    git(prRoot, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(prRoot, 'a.ts'), 'export const a = 2;\n');
    git(prRoot, 'add', '-A'); git(prRoot, 'commit', '-m', 'the PR');
    // meanwhile main moves and gains files the branch never saw
    git(prRoot, 'checkout', '-q', trunk);
    for (const f of ['b.ts', 'c.ts']) fs.writeFileSync(path.join(prRoot, f), 'export const x = 1;\n');
    git(prRoot, 'add', '-A'); git(prRoot, 'commit', '-m', 'main moves on');
  });

  afterAll(() => { fs.rmSync(prRoot, { recursive: true, force: true }); });

  it('two-dot reports the base\'s new files as deletions — the bug', () => {
    const refs = resolvePr(prRoot, { base: trunk, head: 'feature' });
    const twoDot = diffSet(prRoot, refs.baseSha, refs.headSha);
    expect(twoDot.filter((c) => c.status === 'D').map((c) => c.path).sort()).toEqual(['b.ts', 'c.ts']);
  });

  it('three-dot reports only what the branch actually changed — the fix', () => {
    const refs = resolvePr(prRoot, { base: trunk, head: 'feature' });
    expect(refs.forkSha).not.toBeNull();
    const threeDot = diffSet(prRoot, refs.forkSha!, refs.headSha);
    expect(threeDot.map((c) => c.path)).toEqual(['a.ts']);
    expect(threeDot.every((c) => c.status !== 'D')).toBe(true);
  });

  it('the landing point is still reported, so the base moving is not hidden', () => {
    const refs = resolvePr(prRoot, { base: trunk, head: 'feature' });
    expect(refs.baseAhead).toBe(1);
    const stale = staleness(prRoot, refs.forkSha, refs.baseSha, ['a.ts']);
    expect(stale.behind).toBe(1);
  });
});
