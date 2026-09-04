/**
 * The build-order engine — T-12's nine acceptance criteria, against fixtures built on
 * the fly. Every fixture with history is a real git repository with real commits, exactly
 * `test/pipeline.test.ts`'s style: the signals under test (witness, churn-driven
 * tie-breaks) do not exist without one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { digest } from '../src/digest.js';
import { extract } from '../src/extract.js';
import { buildArchitecture } from '../src/architecture.js';
import { buildPlan } from '../src/build/plan.js';
import { stubFile } from '../src/build/stub.js';
import { check } from '../src/build/check.js';
import type { BuildPlan } from '../src/build/types.js';
import type { FileExtract, FileRecord } from '../src/types.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
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

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ================================================================================
// AC1, AC2, AC3, AC4, AC7 — a known import DAG, exact equality
// ================================================================================
//
// Two directories, each with >= 2 direct code files, so `buildArchitecture` chooses
// both as parts (the PRIMARY path — the tier fallback gets its own fixture below).
// `beta` imports from `alpha`, so bottom-up build order must put `alpha` first. Within
// `beta`, `top.ts` is a leaf (its only import leaves the chapter) and `second.ts`
// imports it, so `top.ts` must come first; `top.test.ts` must land right after it.
// `dist/bundle.js` and `package-lock.json` must be reproduced, never taught.

describe('the build-order engine — a known DAG (AC1, AC2, AC3, AC4, AC7)', () => {
  let root: string;
  let plan: BuildPlan;

  beforeAll(async () => {
    root = tmp('repo-tour-build-dag-');
    initRepo(root);

    write(path.join(root, 'alpha/base.ts'), "export function base(): string {\n  return 'base';\n}\n");
    commitAll(root, 'add alpha/base.ts');

    write(
      path.join(root, 'alpha/mid.ts'),
      "import { base } from './base.js';\n\nexport function mid(): string {\n  return base() + '-mid';\n}\n",
    );
    commitAll(root, 'add alpha/mid.ts');

    write(
      path.join(root, 'beta/top.ts'),
      "import { base } from '../alpha/base.js';\n\nexport function top(): string {\n  return base() + '-top';\n}\n",
    );
    commitAll(root, 'add beta/top.ts');

    write(
      path.join(root, 'beta/second.ts'),
      "import { top } from './top.js';\n\nexport function second(): string {\n  return top() + '-second';\n}\n",
    );
    commitAll(root, 'add beta/second.ts');

    write(
      path.join(root, 'beta/top.test.ts'),
      "import { top } from './top.js';\n\ntest('top works', () => {\n  if (top().length === 0) throw new Error('bad');\n});\n",
    );
    commitAll(root, 'add beta/top.test.ts');

    write(path.join(root, 'dist/bundle.js'), 'console.log(1);\n');
    write(path.join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n');
    commitAll(root, 'add generated output and a lockfile');

    const d = await digest(root, { write: false });
    // The premise of this fixture: architecture must actually choose 2 parts, or this
    // test is silently exercising the tier fallback instead of the primary path.
    expect(buildArchitecture(d).subsystems.length).toBe(2);
    plan = await buildPlan(d, { root });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('AC1 — chapters are ordered bottom-up: a chapter comes after the chapters it imports from', () => {
    expect(plan.chapters.map((c) => c.key)).toEqual(['alpha', 'beta']);
    expect(plan.chapters.map((c) => c.tierPath)).toEqual(['alpha', 'beta']);
  });

  it('AC1 — files within a chapter are topological (leaves first), and match exactly', () => {
    // The whole flat, ordered list, exact equality: kind, chapter, file, and line range.
    const shape = (chapter: string, file: string) => ({ kind: 'shape', chapter, file, startLine: undefined, endLine: undefined });
    const fileStep = (chapter: string, file: string) => ({ kind: 'file', chapter, file, startLine: undefined, endLine: undefined });
    const symbolStep = (chapter: string, file: string, startLine: number, endLine: number) =>
      ({ kind: 'symbol', chapter, file, startLine, endLine });

    const actual = plan.steps.map((s) => ({
      kind: s.kind, chapter: s.chapter, file: s.target.file,
      startLine: s.target.startLine, endLine: s.target.endLine,
    }));

    expect(actual).toEqual([
      shape('alpha', 'alpha'),
      fileStep('alpha', 'alpha/base.ts'),
      symbolStep('alpha', 'alpha/base.ts', 1, 3),
      fileStep('alpha', 'alpha/mid.ts'),
      symbolStep('alpha', 'alpha/mid.ts', 3, 5),
      shape('beta', 'beta'),
      fileStep('beta', 'beta/top.ts'),
      symbolStep('beta', 'beta/top.ts', 3, 5),
      fileStep('beta', 'beta/top.test.ts'), // spliced in immediately after the file it tests
      fileStep('beta', 'beta/second.ts'),
      symbolStep('beta', 'beta/second.ts', 3, 5),
    ]);
  });

  it('AC1 — ordinals are a plain 1-based index into the flat, already-ordered list', () => {
    expect(plan.steps.map((s) => s.ordinal)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });

  it('AC2 — the three step kinds all appear, and every kind carries the right shape', () => {
    const kinds = new Set(plan.steps.map((s) => s.kind));
    expect(kinds).toEqual(new Set(['shape', 'file', 'symbol']));
    // shape and file steps never carry a line range; only symbol steps do.
    for (const s of plan.steps) {
      if (s.kind === 'symbol') {
        expect(s.target.startLine).toBeGreaterThanOrEqual(1);
        expect(s.target.endLine).toBeGreaterThanOrEqual(s.target.startLine!);
      } else {
        expect(s.target.startLine).toBeUndefined();
        expect(s.target.endLine).toBeUndefined();
      }
    }
  });

  it('AC2 — a test file becomes its own file step, positioned after the file it tests', () => {
    const testStep = plan.steps.find((s) => s.target.file === 'beta/top.test.ts');
    expect(testStep).toBeDefined();
    expect(testStep!.kind).toBe('file');
    const order = plan.steps.map((s) => s.target.file);
    expect(order.indexOf('beta/top.test.ts')).toBeGreaterThan(order.indexOf('beta/top.ts'));
    expect(order.indexOf('beta/top.test.ts')).toBeLessThan(order.indexOf('beta/second.ts'));
  });

  it('AC2 — generated and lockfile paths never become steps and are listed in plan.reproduce', () => {
    expect(plan.reproduce).toEqual(['dist/bundle.js', 'package-lock.json']);
    for (const s of plan.steps) {
      expect(s.target.file).not.toBe('dist/bundle.js');
      expect(s.target.file).not.toBe('package-lock.json');
    }
  });

  it('AC3 — every step id is the documented hash and is internally consistent', () => {
    for (const s of plan.steps) {
      expect(s.id).toMatch(/^[0-9a-f]{16}$/);
    }
    // no two steps collide
    expect(new Set(plan.steps.map((s) => s.id)).size).toBe(plan.steps.length);
  });

  it('AC3 — ids survive a body-only edit and change after a rename', async () => {
    const before = new Map(plan.steps.map((s) => [`${s.target.file}:${s.kind}`, s.id] as const));

    write(path.join(root, 'alpha/base.ts'), "export function base(): string {\n  return 'CHANGED';\n}\n");
    commitAll(root, 'edit alpha/base.ts body only');

    const dAfterEdit = await digest(root, { write: false });
    const planAfterEdit = await buildPlan(dAfterEdit, { root });
    const afterEdit = new Map(planAfterEdit.steps.map((s) => [`${s.target.file}:${s.kind}`, s.id] as const));
    for (const [key, id] of before) expect(afterEdit.get(key)).toBe(id);

    const baseFileIdBefore = before.get('alpha/base.ts:file')!;
    fs.renameSync(path.join(root, 'alpha/base.ts'), path.join(root, 'alpha/renamed.ts'));
    // The rename breaks alpha/mid.ts's import; that is fine — this test only checks ids.
    commitAll(root, 'rename alpha/base.ts');
    const dAfterRename = await digest(root, { write: false });
    const planAfterRename = await buildPlan(dAfterRename, { root });
    const renamedStep = planAfterRename.steps.find((s) => s.kind === 'file' && s.target.file === 'alpha/renamed.ts');
    expect(renamedStep).toBeDefined();
    expect(renamedStep!.id).not.toBe(baseFileIdBefore);
  });

  it('AC4 — the witness comes from git, matches the real add commit, never invented', () => {
    const baseStep = plan.steps.find((s) => s.kind === 'file' && s.target.file === 'alpha/base.ts')!;
    expect(baseStep.witness.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseStep.witness.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(baseStep.witness.subject).toBe('add alpha/base.ts');

    // the ACTUAL commit git recorded for this file's add — cross-checked, not assumed,
    // and read the same way (`--date=short`) rather than compared to wall-clock `Date.now`,
    // which can disagree with git's LOCAL-time short date across a timezone boundary.
    const actualLine = execFileSync(
      'git',
      ['-C', root, 'log', '--diff-filter=A', '--format=%H%x09%ad', '--date=short', '--follow', '--', 'alpha/base.ts'],
      { encoding: 'utf8' },
    ).trim().split('\n').pop()!;
    const [actualSha, actualDate] = actualLine.split('\t');
    expect(baseStep.witness.sha).toBe(actualSha);
    expect(baseStep.witness.date).toBe(actualDate);

    // symbol and file steps of the same file share the same witness (file granularity only)
    const baseSymbolStep = plan.steps.find((s) => s.kind === 'symbol' && s.target.file === 'alpha/base.ts')!;
    expect(baseSymbolStep.witness).toEqual(baseStep.witness);

    // a shape step has no single file behind it, so it is always null — never fabricated
    const shapeStep = plan.steps.find((s) => s.kind === 'shape' && s.chapter === 'alpha')!;
    expect(shapeStep.witness).toEqual({ sha: null, date: null, subject: null });
  });

  it('AC7 — decision.options has exactly the author\'s choice, taken, and chosen === authorChoice', () => {
    for (const s of plan.steps) {
      expect(s.decision.options.length).toBeGreaterThanOrEqual(1);
      const author = s.decision.options.find((o) => o.id === s.decision.authorChoice);
      expect(author, `step ${s.id} has no option matching its own authorChoice`).toBeDefined();
      expect(author!.taken).toBe(true);
      expect(s.decision.chosen).toBe(s.decision.authorChoice);
      expect(s.decision.options.filter((o) => o.taken)).toHaveLength(1);
    }
  });

  it('source names this repo, its root, and its real HEAD', () => {
    expect(plan.source).toEqual({ kind: 'repo', root, head: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(plan.mode).toBe('recreate');
    expect(plan.schemaVersion).toBe(1);
  });

  it('cost is honestly unmetered — no model ran in this ticket', () => {
    expect(plan.cost).toEqual({
      provider: 'none', metered: false, calls: 0, cachedStops: 0, interpretedStops: 0,
      inputTokens: 0, outputTokens: 0, usd: 0, model: 'none', failures: [],
    });
  });
});

// ================================================================================
// AC1 (write-ahead risk) — the tier fallback, exercised on purpose
// ================================================================================
//
// Each directory has exactly ONE direct code file, so `chooseSubsystems`'s
// `directCode(t) >= 2` filter excludes both and `buildArchitecture` yields ZERO parts.
// The fallback must recover both as chapters straight from `digest.tiers`, still ordered
// bottom-up by the real cross-directory import.

describe('the build-order engine — the tier fallback (AC1 write-ahead risk)', () => {
  let root: string;

  beforeAll(() => {
    root = tmp('repo-tour-build-fallback-');
    initRepo(root);
    write(path.join(root, 'lib/only2.ts'), "export function only2(): string {\n  return 'lib';\n}\n");
    write(
      path.join(root, 'src/only.ts'),
      "import { only2 } from '../lib/only2.js';\n\nexport function only(): string {\n  return only2() + '-src';\n}\n",
    );
    commitAll(root, 'initial');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('falls back to subsystem tiers when architecture yields fewer than two parts', async () => {
    const d = await digest(root, { write: false });
    expect(buildArchitecture(d).subsystems.length).toBeLessThan(2);

    const plan = await buildPlan(d, { root });
    expect(plan.chapters.map((c) => c.key)).toEqual(['lib', 'src']);
    expect(plan.steps.map((s) => s.target.file)).toEqual([
      'lib', 'lib/only2.ts', 'lib/only2.ts', 'src', 'src/only.ts', 'src/only.ts',
    ]);
    expect(plan.steps.map((s) => s.kind)).toEqual(['shape', 'file', 'symbol', 'shape', 'file', 'symbol']);
  });

  it('never invents a chapter for the scan root itself, even when no repo is found anywhere', async () => {
    // A directory with no .git at all: rollup.ts cannot distinguish "the scan root" from
    // "an ordinary subsystem" without a RepoRef, and mislabels the root kind: 'subsystem'.
    // tierSeeds() must exclude path === '' the same way chooseSubsystems() already does.
    const bare = tmp('repo-tour-build-nogit-');
    try {
      write(path.join(bare, 'src/only.ts'), "export function only(): string {\n  return 'x';\n}\n");
      write(path.join(bare, 'src/second.ts'), "export function second(): string {\n  return 'y';\n}\n");

      const d = await digest(bare, { write: false });
      expect(d.manifest.repos).toEqual([]);
      const plan = await buildPlan(d, { root: bare });

      expect(plan.chapters.map((c) => c.key)).toEqual(['src']);
      expect(plan.chapters.some((c) => c.key === '')).toBe(false);
      expect(plan.source.head).toBeNull();
      // AC4 — a tree with no git history anywhere yields nulls, never invented values.
      for (const s of plan.steps) expect(s.witness).toEqual({ sha: null, date: null, subject: null });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ================================================================================
// AC2 — the symbol cap: five per file, by span, restored to file order
// ================================================================================

describe('the build-order engine — the symbol cap (AC2)', () => {
  it('caps at 5 exported symbols per file, choosing the biggest spans, in file order', async () => {
    const root = tmp('repo-tour-build-cap-');
    try {
      initRepo(root);
      const fns: string[] = [];
      for (let i = 1; i <= 7; i++) {
        const body = Array.from({ length: i }, (_, k) => `  const x${k} = ${k};`).join('\n');
        fns.push(`export function fn${i}() {\n${body}\n  return ${i};\n}\n`);
      }
      write(path.join(root, 'src/many.ts'), fns.join('\n'));
      // A second file so this directory clears chooseSubsystems' 2-direct-file bar.
      write(path.join(root, 'src/other.ts'), 'export const OTHER = 1;\n');
      commitAll(root, 'initial');

      const d = await digest(root, { write: false });
      const plan = await buildPlan(d, { root });

      const symbolSteps = plan.steps.filter((s) => s.kind === 'symbol' && s.target.file === 'src/many.ts');
      expect(symbolSteps).toHaveLength(5);
      // fn1 and fn2 have the smallest spans and must be the two excluded.
      expect(symbolSteps.map((s) => s.decision.question).join(' ')).not.toMatch(/Fill in fn1 /);
      expect(symbolSteps.map((s) => s.decision.question).join(' ')).not.toMatch(/Fill in fn2 /);
      // restored to file order (ascending start line) for presentation
      const starts = symbolSteps.map((s) => s.target.startLine!);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));

      // scaffold on the file step: load-bearing ranges are exactly the 5 symbol ranges,
      // non-overlapping, and boilerplate is their complement across the whole file.
      const fileStep = plan.steps.find((s) => s.kind === 'file' && s.target.file === 'src/many.ts')!;
      expect(fileStep.scaffold.loadBearing).toHaveLength(5);
      // The real loc `inventory.ts` recorded — not a hand-rolled recount, which would
      // silently disagree with it on the trailing-newline convention.
      const fileLoc = d.inventory.files.find((f) => f.path === 'src/many.ts')!.loc;
      const covered = fileStep.scaffold.loadBearing.reduce((n, r) => n + (r.endLine - r.startLine + 1), 0);
      const gap = fileStep.scaffold.boilerplate.reduce((n, r) => n + (r.endLine - r.startLine + 1), 0);
      expect(covered + gap).toBe(fileLoc);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ================================================================================
// AC5 — the stub generator: stubbed TS, JS and Python still parse, zero ERROR nodes
// ================================================================================

/** Write `source` under a throwaway root, run the real extractor, return its parseErrors. */
async function parseErrorsOf(source: string, language: string, ext: string): Promise<number> {
  const dir = tmp('repo-tour-stub-parse-');
  try {
    const relPath = `f.${ext}`;
    fs.writeFileSync(path.join(dir, relPath), source);
    const record: FileRecord = {
      path: relPath, repo: '', bytes: Buffer.byteLength(source, 'utf8'), loc: source.split(/\r?\n/).length,
      language, sha256: '', classification: 'source', signals: [], binary: false,
    };
    const { extracts } = await extract(dir, [record]);
    expect(extracts, `extract() produced nothing for a ${language} fixture`).toHaveLength(1);
    return extracts[0]!.parseErrors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the build-order engine — the scaffold writer (AC5)', () => {
  it('a stubbed TypeScript function still parses, with zero ERROR nodes', async () => {
    const source = "export function run(job: string): string {\n  const shouted = job.toUpperCase();\n  return shouted;\n}\n";
    const stubbed = stubFile(source, [{ startLine: 1, endLine: 4 }], 'typescript', [{ ordinal: 1, question: 'How should run behave?' }]);
    expect(stubbed).toContain('TODO(step 1)');
    expect(stubbed).not.toContain('shouted');
    expect(await parseErrorsOf(stubbed, 'typescript', 'ts')).toBe(0);
  });

  it('a stubbed arrow function (no block body in the reference) still parses', async () => {
    const source = 'export const add = (a: number, b: number) => a + b;\n';
    const stubbed = stubFile(source, [{ startLine: 1, endLine: 1 }], 'typescript', [{ ordinal: 2, question: 'How should add combine its inputs?' }]);
    expect(stubbed).toContain('=>');
    expect(stubbed).not.toContain('a + b');
    expect(await parseErrorsOf(stubbed, 'typescript', 'ts')).toBe(0);
  });

  it('a stubbed JavaScript function still parses', async () => {
    const source = "function run(job) {\n  return job.toUpperCase();\n}\nmodule.exports = { run };\n";
    const stubbed = stubFile(source, [{ startLine: 1, endLine: 3 }], 'javascript', [{ ordinal: 1, question: 'How should run behave?' }]);
    expect(stubbed).toContain('module.exports');
    expect(await parseErrorsOf(stubbed, 'javascript', 'js')).toBe(0);
  });

  it('a stubbed Python function keeps the def line and raises, and still parses', async () => {
    const source = 'def run(job):\n    """Send a job through."""\n    return job.upper()\n';
    const stubbed = stubFile(source, [{ startLine: 1, endLine: 3 }], 'python', [{ ordinal: 3, question: 'How should run behave?' }]);
    expect(stubbed).toContain('def run(job):');
    expect(stubbed).toContain('raise NotImplementedError');
    expect(stubbed).toContain('TODO(step 3)');
    expect(await parseErrorsOf(stubbed, 'python', 'py')).toBe(0);
  });

  it('a stubbed Python class still parses, and measures its own body indentation', async () => {
    const source = 'class Engine:\n  def start(self):\n    return 1\n';
    const stubbed = stubFile(source, [{ startLine: 1, endLine: 3 }], 'python', []);
    // the body used 2-space indent; the stub must match it, not assume 4
    expect(stubbed).toBe('class Engine:\n  raise NotImplementedError  # TODO(this step): fill this in\n');
    expect(await parseErrorsOf(stubbed, 'python', 'py')).toBe(0);
  });

  it('a plain exported constant has no body to hide and is left untouched, byte for byte', () => {
    const source = 'export const MAX_RETRIES = 3;\n';
    const stubbed = stubFile(source, [{ startLine: 1, endLine: 1 }], 'typescript', []);
    expect(stubbed).toBe(source);
  });

  it('only the load-bearing range is hidden; everything else survives byte for byte', async () => {
    const source = "export function keep(): number {\n  return 1;\n}\n\nexport function hide(): number {\n  return 2;\n}\n";
    const stubbed = stubFile(source, [{ startLine: 5, endLine: 7 }], 'typescript', [{ ordinal: 1, question: 'q' }]);
    expect(stubbed).toContain('export function keep(): number {\n  return 1;\n}');
    expect(stubbed).not.toContain('return 2;');
    expect(await parseErrorsOf(stubbed, 'typescript', 'ts')).toBe(0);
  });
});

// ================================================================================
// AC6 — the structural check: never a body comparison
// ================================================================================

async function extractOf(source: string, language: string, ext: string): Promise<FileExtract> {
  const dir = tmp('repo-tour-check-reference-');
  try {
    const relPath = `f.${ext}`;
    fs.writeFileSync(path.join(dir, relPath), source);
    const record: FileRecord = {
      path: relPath, repo: '', bytes: Buffer.byteLength(source, 'utf8'), loc: source.split(/\r?\n/).length,
      language, sha256: '', classification: 'source', signals: [], binary: false,
    };
    const { extracts } = await extract(dir, [record]);
    return extracts[0]!;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the build-order engine — the structural check (AC6)', () => {
  const REFERENCE = [
    "import { shout } from './util.js';",
    '',
    'export function run(job: string): string {',
    '  const loud = shout(job);',
    '  return loud;',
    '}',
    '',
    'export class Engine {',
    '  start(): number { return 1; }',
    '}',
    '',
  ].join('\n');

  it('a renamed local variable changes nothing structural and the check passes', async () => {
    const reference = await extractOf(REFERENCE, 'typescript', 'ts');
    const learnerSource = REFERENCE.replace(/loud/g, 'result');
    const report = await check(learnerSource, reference, 'typescript', 'f.ts');

    expect(report.ok).toBe(true);
    expect(report.symbols.every((s) => s.status === 'present')).toBe(true);
    expect(report.imports).toEqual([{ raw: './util.js', status: 'present' }]);
    expect(report.parseErrors).toBe(0);
  });

  it('a missing export is reported by name and fails the check', async () => {
    const reference = await extractOf(REFERENCE, 'typescript', 'ts');
    // Engine dropped entirely — run() survives untouched.
    const learnerSource = [
      "import { shout } from './util.js';",
      '',
      'export function run(job: string): string {',
      '  return shout(job);',
      '}',
      '',
    ].join('\n');
    const report = await check(learnerSource, reference, 'typescript', 'f.ts');

    expect(report.ok).toBe(false);
    expect(report.symbols).toContainEqual({ name: 'Engine', kind: 'class', status: 'missing' });
    expect(report.symbols).toContainEqual({ name: 'run', kind: 'function', status: 'present' });
  });

  it('an export the reference never had is reported as extra, without failing on its own', async () => {
    const reference = await extractOf(REFERENCE, 'typescript', 'ts');
    const learnerSource = `${REFERENCE}\nexport function bonus(): number { return 0; }\n`;
    const report = await check(learnerSource, reference, 'typescript', 'f.ts');

    expect(report.symbols).toContainEqual({ name: 'bonus', kind: 'function', status: 'extra' });
    // every REFERENCE symbol is still present, and extras alone do not fail the check
    expect(report.symbols.filter((s) => s.status === 'missing')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('a missing import is reported and fails the check', async () => {
    const reference = await extractOf(REFERENCE, 'typescript', 'ts');
    const learnerSource = [
      'export function run(job: string): string {',
      '  return job.toUpperCase();',
      '}',
      '',
      'export class Engine {',
      '  start(): number { return 1; }',
      '}',
      '',
    ].join('\n');
    const report = await check(learnerSource, reference, 'typescript', 'f.ts');

    expect(report.imports).toEqual([{ raw: './util.js', status: 'missing' }]);
    expect(report.ok).toBe(false);
  });

  it('a learner file that fails to parse is never reported clean', async () => {
    const reference = await extractOf(REFERENCE, 'typescript', 'ts');
    const report = await check('export function run( { {{{ broken', reference, 'typescript', 'f.ts');

    expect(report.parseErrors).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it('never inspects a body: a completely rewritten implementation of the same signature still passes', async () => {
    const reference = await extractOf(REFERENCE, 'typescript', 'ts');
    const learnerSource = [
      "import { shout } from './util.js';",
      '',
      'export function run(job: string): string {',
      '  if (!job) return shout("");',
      '  for (let i = 0; i < 3; i++) { /* nothing */ }',
      '  return shout(job);',
      '}',
      '',
      'export class Engine {',
      '  start(): number { const n = 1; return n; }',
      '}',
      '',
    ].join('\n');
    const report = await check(learnerSource, reference, 'typescript', 'f.ts');
    expect(report.ok).toBe(true);
  });
});

// ================================================================================
// AC8 — the JSON schema: a generated plan validates, a bad plan does not
// ================================================================================
//
// No ajv: package.json is T-11's file this week and the repo has a zero-runtime-
// dependency stance (refinement notes). This is a small hand-rolled checker covering
// exactly what the refinement notes ask for — required keys, types, enums — over the
// draft-07 subset schema/build-plan.schema.json actually uses ($ref, const, enum,
// oneOf, type, required/properties, items/minItems).

type JsonSchema = Record<string, unknown>;

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const parts = ref.replace(/^#\//, '').split('/');
  let cur: unknown = root;
  for (const p of parts) cur = (cur as Record<string, unknown>)[p];
  return cur as JsonSchema;
}

function validateAgainst(root: JsonSchema, schema: JsonSchema, value: unknown, at: string, errors: string[]): void {
  if (typeof schema.$ref === 'string') {
    validateAgainst(root, resolveRef(root, schema.$ref), value, at, errors);
    return;
  }
  if ('const' in schema) {
    if (value !== schema.const) errors.push(`${at}: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) errors.push(`${at}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as JsonSchema[]).filter((s) => {
      const sub: string[] = [];
      validateAgainst(root, s, value, at, sub);
      return sub.length === 0;
    });
    if (matches.length !== 1) errors.push(`${at}: expected exactly one oneOf branch to match, ${matches.length} did`);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const ok = types.some((t) => {
      if (t === 'null') return value === null;
      if (t === 'array') return Array.isArray(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
      return typeof value === t;
    });
    if (!ok) { errors.push(`${at}: expected type ${JSON.stringify(schema.type)}, got ${JSON.stringify(value)}`); return; }
  }

  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${at}: missing required key "${key}"`);
    }
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validateAgainst(root, sub, obj[key], `${at}.${key}`, errors);
    }
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${at}: expected at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.items) value.forEach((v, i) => validateAgainst(root, schema.items as JsonSchema, v, `${at}[${i}]`, errors));
  }
}

function validateBuildPlan(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  validateAgainst(schema, schema, value, '$', errors);
  return errors;
}

describe('the build-order engine — the JSON schema (AC8)', () => {
  // fileURLToPath, never `new URL(...).pathname` — a raw .pathname percent-encodes
  // spaces, and this very project's path has one ("Coding Projects"). See
  // `test/pipeline.test.ts`'s "paths with spaces in them" describe block for the defect
  // this caused the first time repo-tour's own code got this wrong.
  const schemaPath = fileURLToPath(new URL('../schema/build-plan.schema.json', import.meta.url));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as JsonSchema;

  it('validates a plan generated from a real fixture', async () => {
    const root = tmp('repo-tour-schema-');
    try {
      initRepo(root);
      write(path.join(root, 'src/a.ts'), "export function a(): number {\n  return 1;\n}\n");
      write(path.join(root, 'src/b.ts'), "export function b(): number {\n  return 2;\n}\n");
      commitAll(root, 'initial');

      const d = await digest(root, { write: false });
      const plan = await buildPlan(d, { root });
      const errors = validateBuildPlan(schema, plan);
      expect(errors).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a plan with an invalid mode', async () => {
    const root = tmp('repo-tour-schema-bad-');
    try {
      initRepo(root);
      write(path.join(root, 'src/a.ts'), 'export const A = 1;\n');
      commitAll(root, 'initial');

      const d = await digest(root, { write: false });
      const plan = await buildPlan(d, { root });
      const bad = { ...plan, mode: 'bogus' };
      const errors = validateBuildPlan(schema, bad);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes('.mode'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a plan missing a required top-level key', async () => {
    const root = tmp('repo-tour-schema-missing-');
    try {
      initRepo(root);
      write(path.join(root, 'src/a.ts'), 'export const A = 1;\n');
      commitAll(root, 'initial');

      const d = await digest(root, { write: false });
      const plan = await buildPlan(d, { root }) as Partial<BuildPlan>;
      delete plan.reproduce;
      const errors = validateBuildPlan(schema, plan);
      expect(errors.some((e) => e.includes('missing required key "reproduce"'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
