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

// ================================================================================
// REWORK (attempt 2) — WHICH candidate path the triviality filter belongs to
// ================================================================================
//
// The T-15 review (`.autodev/reviews/T-15.md`, Angle 3) found `isEligibleCandidate`
// wired across BOTH candidate paths in `selectLoadBearing`, not only the new fallback,
// so it silently dropped symbol steps from ordinary TS/ESM files that were already
// working. The corrected spec's out-of-scope line draws the line precisely:
//
//   * a file that EXPORTS something is unchanged by this ticket, in every language —
//     candidates are every exported symbol, any kind, any span, capped at 5, exactly
//     what T-12 shipped and exactly what these fixtures produce on `main`;
//   * a file that exports NOTHING takes the exported-or-all fallback, in every
//     language, and the triviality filter runs THERE and nowhere else.
//
// (a)/(b) below pin the exported path (both were 0 steps under the reviewed code);
// (c)/(d)/(e) pin the fallback path, including its filter. Each fixture writes a
// second direct-code file for the same reason (b) further up does: so
// `chooseSubsystems` picks the directory as a real architecture part rather than
// exercising the unrelated tier fallback.

/** The symbol-step names a real `digest()` → `buildPlan()` run mints for one file. */
async function symbolStepNames(files: Record<string, string>, file: string): Promise<string[]> {
  const root = tmp('repo-tour-scripts-candidates-');
  try {
    for (const [rel, body] of Object.entries(files)) write(path.join(root, rel), body);
    const d = await digest(root, { write: false });
    const plan = await buildPlan(d, { root, witness: false });
    return plan.steps
      .filter((s) => s.kind === 'symbol' && s.target.file === file)
      .map((s) => /^Fill in (.+?) — /.exec(s.decision.question)?.[1] ?? s.decision.question);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- (a) the exported path: a types-only module ---------------------------------

const TYPES_ONLY_SOURCE = [
  'export interface Widget {',
  '  id: string;',
  '  label: string;',
  '}',
  '',
  'export type WidgetId = string;',
  '',
  'export enum WidgetKind {',
  '  Button,',
  '  Panel,',
  '}',
  '',
].join('\n');

describe('T-15 rework (a) — a types-only module keeps every one of its exported symbols', () => {
  it('an ESM/TS file exporting only interface/type/enum gets a step each, as on main', async () => {
    const names = await symbolStepNames(
      {
        'src/widget.ts': TYPES_ONLY_SOURCE,
        'src/other.ts': 'export function helperOther(): number {\n  return 1;\n}\n',
      },
      'src/widget.ts',
    );
    // The base behaviour, derived from the rule this path has had since T-12: candidates
    // are the exported symbols — no kind screen, no span screen — capped at 5. Three
    // exports, no two of them overlapping, so three steps in file order. The reviewed
    // (pre-rework) code produced 0 here, because `interface`/`type`/`enum` are not
    // `function`/`method`/`class`/`variable`.
    expect(names).toEqual(['Widget', 'WidgetId', 'WidgetKind']);
  });
});

// ---- (b) the exported path: a one-line exported const ---------------------------

describe('T-15 rework (b) — a one-line exported const still earns its step', () => {
  it('a file whose only export is `export const PI = 3.14159;` gets exactly 1 symbol step', async () => {
    const names = await symbolStepNames(
      {
        'src/constants.ts': 'export const PI = 3.14159;\n',
        'src/other.ts': 'export function helperOther(): number {\n  return 1;\n}\n',
      },
      'src/constants.ts',
    );
    // Same rule as (a): every exported symbol, any span. The >= 3-line screen belongs to
    // the fallback path only, so a deliberate one-line public constant keeps its step.
    // The reviewed (pre-rework) code produced 0 here.
    expect(names).toEqual(['PI']);
  });
});

// ---- (c) the fallback path in Python --------------------------------------------

const PRIVATE_PY_SOURCE = [
  'import json',
  '',
  '',
  'def _helper_one(payload):',
  '    """Normalise a payload."""',
  '    return json.dumps(payload)',
  '',
  '',
  'def _helper_two(payload):',
  '    return _helper_one(payload).upper()',
  '',
].join('\n');

describe('T-15 rework (c) — the exported-or-all fallback is language-neutral: it fires for Python too', () => {
  it("a module whose only top-level defs are _private exports nothing, so the fallback gives both defs steps — AC2's intent, not a side effect", async () => {
    const names = await symbolStepNames(
      {
        'src/helpers.py': PRIVATE_PY_SOURCE,
        'src/other.py': 'def other_helper():\n    return 1\n',
      },
      'src/helpers.py',
    );
    // `extract()` marks a leading-underscore Python symbol `exported: false`, so this
    // whole module exports nothing and every recorded symbol becomes a candidate — the
    // same rule the ticket's CommonJS `server.js` relies on. Both are `function`s, so the
    // fallback's triviality filter passes them through. On main this file got 0 steps
    // (no candidates at all); that is the behaviour AC2 changes on purpose.
    expect(names).toEqual(['_helper_one', '_helper_two']);
  });
});

// ---- (d) the fallback path in a zero-export TS script ---------------------------

const SIDE_EFFECT_TS_SOURCE = [
  'function registerGlobal(): void {',
  '  const target = globalThis as Record<string, unknown>;',
  "  target.widgetRegistry = target.widgetRegistry ?? {};",
  '  const registry = target.widgetRegistry as Record<string, unknown>;',
  "  registry.button = { kind: 'button' };",
  "  registry.panel = { kind: 'panel' };",
  '  if (Object.keys(registry).length === 0) {',
  "    throw new Error('empty registry');",
  '  }',
  '}',
  '',
  'registerGlobal();',
  '',
].join('\n');

describe('T-15 rework (d) — a TS side-effect script with no exports at all', () => {
  it('its one 10-line function becomes the file\'s single symbol step', async () => {
    const names = await symbolStepNames(
      {
        'src/register.ts': SIDE_EFFECT_TS_SOURCE,
        'src/other.ts': 'export function helperOther(): number {\n  return 1;\n}\n',
      },
      'src/register.ts',
    );
    // No `export` keyword anywhere, so the fallback fires exactly as it does for a
    // CommonJS script; the trailing `registerGlobal();` call is an expression statement,
    // not a declaration, and contributes nothing. On main this file got 0 steps.
    expect(names).toEqual(['registerGlobal']);
  });
});

// ---- (e) the fallback path's triviality filter ----------------------------------

const REQUIRE_PLUS_FUNCTION_SOURCE = [
  "const fs = require('fs');",
  '',
  'function collectSources(dir) {',
  '  const out = [];',
  '  const stack = [dir];',
  '  while (stack.length > 0) {',
  '    const current = stack.pop();',
  '    const entries = fs.readdirSync(current, { withFileTypes: true });',
  '    for (const entry of entries) {',
  '      if (entry.name.startsWith(\'.\')) {',
  '        continue;',
  '      }',
  '      if (entry.isDirectory()) {',
  '        stack.push(`${current}/${entry.name}`);',
  '        continue;',
  '      }',
  '      if (entry.name.endsWith(\'.js\')) {',
  '        out.push(`${current}/${entry.name}`);',
  '      }',
  '    }',
  '  }',
  '  return out;',
  '}',
  '',
  'module.exports = collectSources;',
  '',
].join('\n');

describe('T-15 rework (e) — the fallback\'s triviality filter, on the only path it runs', () => {
  it('a no-export JS file with a 1-line require and a 20-line function gets exactly 1 step, the function', async () => {
    const names = await symbolStepNames(
      {
        'src/collect.js': REQUIRE_PLUS_FUNCTION_SOURCE,
        'src/other.js': 'function helperOther() {\n  return 1;\n}\n',
      },
      'src/collect.js',
    );
    // `const fs = require('fs')` is a one-line `variable` — a reference, not code a
    // learner fills in — and is only a candidate at all because the fallback fired. The
    // filter drops it; `collectSources` is a `function`, eligible at any span.
    expect(names).toEqual(['collectSources']);
  });
});
