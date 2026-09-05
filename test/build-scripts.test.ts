/**
 * T-15 — script-style JS yields no load-bearing ranges.
 *
 * Two real defects, found live on sql-gauntlet (`.autodev/specs/T-15-script-symbols.md`):
 * every `public/*.js` file wraps its whole body in a top-level IIFE, so `extract()`'s
 * top-level symbol walk (`src/extract.ts`) sees one `expression_statement` and records
 * nothing inside it; `server.js` and `tools/*.js` are plain scripts/CommonJS with real
 * top-level functions that `extract()` DOES record, but none of them are `exported`
 * (no ESM `export`), so `selectLoadBearing` (`src/build/plan.ts`) — which candidates only
 * `exported` symbols — finds zero candidates and mints zero symbol steps.
 *
 * This file does not import anything from `test/build.test.ts` (out of the touched set —
 * `.autodev/locates/T-15.md` says add a new file, not edit it); the couple of fixture
 * helpers it needs (`write`, `tmp`, `extractOf`) are copied here in their minimal form,
 * matching that file's own style.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { digest } from '../src/digest.js';
import { extract } from '../src/extract.js';
import { buildPlan } from '../src/build/plan.js';
import type { FileExtract, FileRecord } from '../src/types.js';

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The real extractor over one in-memory source file — no git, no digest, just extract(). */
async function extractOf(source: string, language: string, ext: string): Promise<FileExtract> {
  const dir = tmp('repo-tour-scripts-extract-');
  try {
    const relPath = `f.${ext}`;
    fs.writeFileSync(path.join(dir, relPath), source);
    const record: FileRecord = {
      path: relPath, repo: '', bytes: Buffer.byteLength(source, 'utf8'), loc: source.split(/\r?\n/).length,
      language, sha256: '', classification: 'source', signals: [], binary: false,
    };
    const { extracts } = await extract(dir, [record]);
    expect(extracts, `extract() produced nothing for this fixture`).toHaveLength(1);
    return extracts[0]!;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================================
// (a) — the sql-gauntlet shape: a top-level IIFE's direct declarations are recorded
// ================================================================================

const IIFE_SOURCE = [
  '(function () {',
  '  // Boots the page.',
  '  function init() {',
  '    return 1;',
  '  }',
  '',
  '  function render() {',
  '    return 2;',
  '  }',
  '',
  "  document.addEventListener('DOMContentLoaded', init);",
  '})();',
  '',
].join('\n');

describe('T-15 (a) — a top-level IIFE\'s direct declarations become symbols', () => {
  it('records init and render, real ranges, exported:false, doc from the leading comment', async () => {
    const ex = await extractOf(IIFE_SOURCE, 'javascript', 'js');

    const init = ex.symbols.find((s) => s.name === 'init');
    expect(init, 'extract() reported no symbol named init inside the IIFE').toBeDefined();
    expect(init).toMatchObject({ kind: 'function', exported: false, line: 3, endLine: 5 });
    expect(init!.doc).toBe('Boots the page.');

    const render = ex.symbols.find((s) => s.name === 'render');
    expect(render, 'extract() reported no symbol named render inside the IIFE').toBeDefined();
    expect(render).toMatchObject({ kind: 'function', exported: false, line: 7, endLine: 9 });
    expect(render!.doc).toBeNull();

    // Nothing else leaks out of the IIFE body — the addEventListener call is not a
    // declaration, and the outer IIFE itself is never recorded as a symbol of its own.
    expect(ex.symbols.map((s) => s.name).sort()).toEqual(['init', 'render']);
  });
});

// ================================================================================
// (b) — the CommonJS / plain-script fixture: candidates fall back to "all symbols"
// ================================================================================

const SERVER_SOURCE = [
  "const http = require('http');",
  '',
  'const CONFIG = {',
  "  host: 'localhost',",
  '  port: 8080,',
  '};',
  '',
  'function handle(req, res) {',
  "  res.end('ok');",
  '}',
  '',
  'function listRepos() {',
  '  return [];',
  '}',
  '',
  'http.createServer(handle).listen(0);',
  '',
].join('\n');

describe('T-15 (b) — a server.js-shaped fixture gets symbol steps for its handlers, none for its requires', () => {
  it('handle, listRepos and the 3-line CONFIG become symbol steps; the 1-line http require does not', async () => {
    const root = tmp('repo-tour-scripts-server-');
    try {
      write(path.join(root, 'src/server.js'), SERVER_SOURCE);
      // A second direct-code file so `chooseSubsystems` picks `src` as a real
      // architecture part rather than exercising the (unrelated) tier fallback.
      write(path.join(root, 'src/other.js'), 'function helperOther() {\n  return 1;\n}\n');

      const d = await digest(root, { write: false });
      const plan = await buildPlan(d, { root, witness: false });

      const symbolSteps = plan.steps.filter((s) => s.kind === 'symbol' && s.target.file === 'src/server.js');
      const questions = symbolSteps.map((s) => s.decision.question);

      expect(questions.some((q) => q.startsWith('Fill in handle '))).toBe(true);
      expect(questions.some((q) => q.startsWith('Fill in listRepos '))).toBe(true);
      // a variable spanning >= 3 lines is eligible even though it is not a function
      expect(questions.some((q) => q.startsWith('Fill in CONFIG '))).toBe(true);
      // a one-line `const x = require(...)` never becomes a step
      expect(questions.some((q) => q.startsWith('Fill in http '))).toBe(false);
      expect(symbolSteps).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ================================================================================
// (c) — negative: a helper nested inside an ordinary (non-IIFE) function stays unrecorded
// ================================================================================

const NESTED_HELPER_SOURCE = [
  'function outer() {',
  '  function helper() {',
  '    return 1;',
  '  }',
  '  return helper();',
  '}',
  '',
].join('\n');

describe('T-15 (c) — a plain nested helper is not an IIFE and stays invisible', () => {
  it('records outer only; helper never appears', async () => {
    const ex = await extractOf(NESTED_HELPER_SOURCE, 'javascript', 'js');
    expect(ex.symbols.map((s) => s.name)).toEqual(['outer']);
    expect(ex.symbols.find((s) => s.name === 'helper')).toBeUndefined();
  });
});

// ================================================================================
// (d) — the other three documented IIFE shapes: arrow, `!`-prefixed, and the
// call-inside-the-parens variant. Recursion is still exactly ONE level: none of these
// wrap another IIFE, so this is the same rule exercised on the remaining accepted shapes.
// ================================================================================

describe('T-15 (d) — the other IIFE shapes extract must also recognize', () => {
  it('an arrow IIFE — (() => { ... })()', async () => {
    const source = ['(() => {', '  function setup() {', '    return 1;', '  }', '})();', ''].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    const setup = ex.symbols.find((s) => s.name === 'setup');
    expect(setup).toMatchObject({ kind: 'function', exported: false });
  });

  it('a unary-prefixed IIFE — !function () { ... }()', async () => {
    const source = ['!function () {', '  function boot() {', '    return 1;', '  }', '}();', ''].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    const boot = ex.symbols.find((s) => s.name === 'boot');
    expect(boot).toMatchObject({ kind: 'function', exported: false });
  });

  it('the call-inside-the-parens form — (function () { ... }())', async () => {
    const source = ['(function () {', '  function ready() {', '    return 1;', '  }', '}());', ''].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    const ready = ex.symbols.find((s) => s.name === 'ready');
    expect(ready).toMatchObject({ kind: 'function', exported: false });
  });

  it('the UMD shape — a named parameter and a real argument expression, not just ()', async () => {
    // engine.js / xray.js's own shape on sql-gauntlet, verbatim in structure.
    const source = [
      '(function (root) {',
      '  function Engine() {',
      '    return 1;',
      '  }',
      '  root.Engine = Engine;',
      '})(typeof self !== "undefined" ? self : this);',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    const engine = ex.symbols.find((s) => s.name === 'Engine');
    expect(engine).toMatchObject({ kind: 'function', exported: false });
  });

  it('typescript source: the same four shapes are recognized in the typescript grammar too', async () => {
    const shapes = [
      ['(function () {\n  function tsInit() { return 1; }\n})();\n', 'tsInit'],
      ['(() => {\n  function tsArrow() { return 1; }\n})();\n', 'tsArrow'],
      ['!function () {\n  function tsBang() { return 1; }\n}();\n', 'tsBang'],
      ['(function () {\n  function tsInside() { return 1; }\n}());\n', 'tsInside'],
    ] as const;
    for (const [source, name] of shapes) {
      const ex = await extractOf(source, 'typescript', 'ts');
      expect(ex.symbols.find((s) => s.name === name), `${name} missing in typescript grammar`).toBeDefined();
    }
  });
});

// ================================================================================
// existing fixtures are unaffected — ids are byte-identical before and after this fix
// ================================================================================
//
// A fixture where every file already exports plain functions (so the exported-or-all
// fallback never triggers, and nothing here is a `variable`, so the triviality filter is
// never exercised either) must mint the EXACT SAME steps and ids this ticket's plan.ts
// change did not touch. The ids below were captured from this exact fixture BEFORE either
// fix in this ticket was written (see the write-ahead handoff, `.autodev/handoffs/T-15.md`)
// — a real snapshot, not a value re-derived from the new code.

describe('T-15 — existing (already-exported) fixtures produce byte-identical plans', () => {
  it('a plain two-file, all-exported fixture mints exactly the pre-fix ids', async () => {
    const root = tmp('repo-tour-scripts-snapshot-');
    try {
      write(path.join(root, 'src/a.ts'), "export function a(): number {\n  return 1;\n}\n");
      write(
        path.join(root, 'src/b.ts'),
        "import { a } from './a.js';\n\nexport function b(): number {\n  return a() + 1;\n}\n",
      );

      const d = await digest(root, { write: false });
      const plan = await buildPlan(d, { root, witness: false });
      const keyed = plan.steps.map((s) => ({ kind: s.kind, chapter: s.chapter, file: s.target.file, id: s.id }));

      expect(keyed).toEqual([
        { kind: 'shape', chapter: 'src', file: 'src', id: '34bb0df06c1a8c17' },
        { kind: 'file', chapter: 'src', file: 'src/a.ts', id: '20eb564158513ecc' },
        { kind: 'symbol', chapter: 'src', file: 'src/a.ts', id: '87dc75cad799f549' },
        { kind: 'file', chapter: 'src', file: 'src/b.ts', id: 'f5dee4c5fcfcb789' },
        { kind: 'symbol', chapter: 'src', file: 'src/b.ts', id: 'dff509acbeaa3e5b' },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
