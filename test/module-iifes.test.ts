/**
 * T-16 — module-pattern and `.call(this)` IIFEs: record their body declarations too.
 *
 * T-15 taught `extract()` to look inside a top-level IIFE STATEMENT. Two other common
 * wrappers stayed invisible (`.autodev/specs/T-16-module-iifes.md`):
 *
 *   var app = (function () { ... })();     — the module pattern: the IIFE is a declarator's value
 *   (function () { ... }).call(this);      — the IIFE runs through .call / .apply / .bind(...)()
 *
 * The owner approved this as "functions inside them never become tour stops or build steps",
 * so the checks below reach the layer they named — `buildPlan()`'s symbol steps and
 * `buildCodeTour()`'s stops — and not only `extract()`.
 *
 * `test/build.test.ts` (T-12) and `test/build-scripts.test.ts` (T-15) are byte-frozen by this
 * ticket, so the few fixture helpers needed here are copied in their minimal form, as T-15's
 * file did.
 *
 * Two kinds of check live here. POSITIVES fail on main, each with its own message, and pass
 * once the change lands. GUARDS pass on main by design: they pin what must NOT move (a bound
 * function that never runs, a wrapper whose body holds nothing eligible, a file that exports
 * something). Each guard was also turned red by a deliberate sabotage of the implementation,
 * one per guard, recorded in the handoff (`.autodev/handoffs/T-16.md`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { digest } from '../src/digest.js';
import { extract } from '../src/extract.js';
import { buildPlan } from '../src/build/plan.js';
import { buildCodeTour } from '../src/codetour.js';
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
  const dir = tmp('repo-tour-modules-extract-');
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

const names = (ex: FileExtract): string[] => ex.symbols.map((s) => s.name);

interface PlannedStep { name: string; startLine: number; endLine: number; id: string }

/**
 * One real `digest()` → `buildPlan()` / `buildCodeTour()` run over a small tree, read back for
 * one file: its symbol steps, and the titles of its tour stops after the file's own opening
 * stop. Every fixture adds a second direct-code file for the reason T-15's tests give: so
 * `chooseSubsystems` picks `src` as a real architecture part rather than the tier fallback.
 */
async function planAndTour(
  files: Record<string, string>, file: string,
): Promise<{ steps: PlannedStep[]; stops: string[] }> {
  const root = tmp('repo-tour-modules-plan-');
  try {
    for (const [rel, body] of Object.entries(files)) write(path.join(root, rel), body);
    const d = await digest(root, { write: false });
    const plan = await buildPlan(d, { root, witness: false });
    const steps = plan.steps
      .filter((s) => s.kind === 'symbol' && s.target.file === file)
      .map((s) => ({
        name: /^Fill in (.+?) — /.exec(s.decision.question)?.[1] ?? s.decision.question,
        startLine: s.target.startLine ?? 0,
        endLine: s.target.endLine ?? 0,
        id: s.id,
      }));
    const stops = buildCodeTour(d).steps
      .filter((s) => s.file === file && !s.synthetic)
      .slice(1) // the file's opening stop, whose title is its basename
      .map((s) => s.title);
    return { steps, stops };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const OTHER_JS = 'function helperOther() {\n  return 1;\n}\n';

// ================================================================================
// AC1 — the module pattern: the IIFE is a top-level declarator's value
// ================================================================================

const MODULE_SOURCE = [
  "// The app's one namespace.",
  'var app = (function () {',
  '  // Boots the page.',
  '  function init() {',
  '    return render();',
  '  }',
  '',
  '  function render() {',
  '    return 2;',
  '  }',
  '',
  '  var state = { ready: false };',
  '',
  '  return { init: init };',
  '})();',
  '',
].join('\n');

describe('T-16 AC1 — a module-pattern wrapper\'s body declarations become symbols', () => {
  it('records init, render and state inside `var app = (function () {...})()`, and app exactly as before', async () => {
    const ex = await extractOf(MODULE_SOURCE, 'javascript', 'js');

    expect(names(ex), 'extract() recorded nothing inside the module-pattern wrapper').toEqual(['app', 'init', 'render', 'state']);

    // The wrapper's own record is exactly what main records today.
    const app = ex.symbols.find((s) => s.name === 'app')!;
    expect(app).toMatchObject({ kind: 'variable', exported: false, line: 2, endLine: 15 });
    expect(app.doc).toBe("The app's one namespace.");

    const init = ex.symbols.find((s) => s.name === 'init')!;
    expect(init).toMatchObject({ kind: 'function', exported: false, line: 4, endLine: 6 });
    expect(init.doc).toBe('Boots the page.');

    const render = ex.symbols.find((s) => s.name === 'render')!;
    expect(render).toMatchObject({ kind: 'function', exported: false, line: 8, endLine: 10 });
    expect(render.doc).toBeNull();

    expect(ex.symbols.find((s) => s.name === 'state')).toMatchObject({ kind: 'variable', exported: false, line: 12, endLine: 12 });
  });

  // Every value shape T-15 accepts for a statement, now as a declarator's value — plus the
  // `.call` / `.bind` forms (AC2) in the same position. Both grammars, because the javascript
  // and typescript trees were dumped identical (write-ahead), and that is a claim to test.
  const shapes: Array<[string, string]> = [
    ['call outside the parens', 'const app = (function () {\n  function inner() {\n    return 1;\n  }\n  return inner;\n})();\n'],
    ['call inside the parens', 'var app = (function () {\n  function inner() {\n    return 1;\n  }\n  return inner;\n}());\n'],
    ['no parens at all', 'var app = function () {\n  function inner() {\n    return 1;\n  }\n  return inner;\n}();\n'],
    ['an arrow', 'let app = (() => {\n  function inner() {\n    return 1;\n  }\n  return inner;\n})();\n'],
    ['an async arrow', 'const app = (async () => {\n  function inner() {\n    return 1;\n  }\n  return inner;\n})();\n'],
    ['a parameter and a real argument', 'var app = (function ($) {\n  function inner() {\n    return $;\n  }\n  return inner;\n})(window.jQuery);\n'],
    ['behind a unary operator', 'var app = void function () {\n  function inner() {\n    return 1;\n  }\n}();\n'],
    ['run through .call(this)', 'var app = (function () {\n  function inner() {\n    return 1;\n  }\n  return inner;\n}).call(this);\n'],
    ['run through .bind(this)()', 'var app = (function () {\n  function inner() {\n    return 1;\n  }\n  return inner;\n}).bind(this)();\n'],
  ];
  for (const [label, source] of shapes) {
    for (const [language, ext] of [['javascript', 'js'], ['typescript', 'ts']] as const) {
      it(`${label} (${language})`, async () => {
        const ex = await extractOf(source, language, ext);
        expect(names(ex), `${label}: the function inside the wrapper was not recorded`).toEqual(['app', 'inner']);
        expect(ex.symbols[1]).toMatchObject({ name: 'inner', kind: 'function', exported: false });
      });
    }
  }

  it('under `export`: the name stays exported, the declarations inside do not become exports', async () => {
    const source = [
      'export const app = (function () {',
      '  function init(): number {',
      '    return 1;',
      '  }',
      '  return { init };',
      '})();',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'typescript', 'ts');
    expect(names(ex), 'an exported module-pattern wrapper was not entered').toEqual(['app', 'init']);
    expect(ex.symbols[0]!.exported, 'the exported wrapper lost its export').toBe(true);
    expect(ex.symbols[1]!.exported, 'a declaration inside an exported wrapper became an export').toBe(false);
    expect(ex.symbols[0]).toMatchObject({ name: 'app', kind: 'variable' });
    expect(ex.symbols[1]).toMatchObject({ name: 'init', kind: 'function' });
  });

  it('a multi-declarator statement: each declarator\'s wrapper is entered on its own', async () => {
    const source = [
      'var first = (function () {',
      '  function fromFirst() {',
      '    return 1;',
      '  }',
      '  return fromFirst;',
      '})(), second = (function () {',
      '  function fromSecond() {',
      '    return 2;',
      '  }',
      '  return fromSecond;',
      '}).call(this), third = 3;',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    expect(names(ex), 'a wrapper in a multi-declarator statement was not entered').toEqual(
      ['first', 'second', 'third', 'fromFirst', 'fromSecond'],
    );
  });

  it('a destructuring declarator: its wrapper is entered too, and the pattern is still not recorded, as today', async () => {
    // The body runs at load whatever the binding looks like, so its declarations are the
    // module's code either way. `recordDecl` has never recorded a destructuring pattern's
    // names, and still does not.
    const source = [
      'const { init } = (function () {',
      '  function init() {',
      '    return 1;',
      '  }',
      '  return { init: init };',
      '})();',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    expect(ex.symbols.map((s) => `${s.name}:${s.kind}:${s.line}-${s.endLine}`), 'a destructuring declarator\'s wrapper was not entered').toEqual(
      ['init:function:2-4'],
    );
  });

  it('a JSDoc comment between the name and the value (a TypeScript ES5 class emit) does not hide the value', async () => {
    const source = [
      'var Foo = /** @class */ (function () {',
      '  function Foo(name) {',
      '    this.name = name;',
      '  }',
      '  Foo.prototype.greet = function () {',
      "    return 'hi ' + this.name;",
      '  };',
      '  return Foo;',
      '}());',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    expect(ex.symbols.map((s) => `${s.name}:${s.kind}:${s.line}-${s.endLine}`)).toEqual(
      ['Foo:variable:1-9', 'Foo:function:2-4'],
    );
  });

  it("sql-gauntlet's shape: the `const i` inside `argSection` is recorded (tools/validate.js:31-34)", async () => {
    const source = [
      'const argSection = (function () {',
      "  const i = process.argv.indexOf('--section');",
      '  return i >= 0 ? process.argv[i + 1] : null;',
      '})();',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    expect(names(ex), 'nothing inside argSection was recorded').toEqual(['argSection', 'i']);
    expect(ex.symbols[1]).toMatchObject({ kind: 'variable', exported: false, line: 2, endLine: 2 });
  });
});

// ================================================================================
// AC2 — the wrapper runs through .call / .apply / .bind(...)()
// ================================================================================

describe('T-16 AC2 — a function literal run through .call, .apply or .bind(...)()', () => {
  const shapes: Array<[string, string]> = [
    ['.call(this)', '(function () {\n  function inner() {\n    return 1;\n  }\n}).call(this);\n'],
    ['.apply(this, arguments)', '(function () {\n  function inner() {\n    return 1;\n  }\n}).apply(this, arguments);\n'],
    ['.bind(this)()', '(function () {\n  function inner() {\n    return 1;\n  }\n}).bind(this)();\n'],
    ['.call(this) inside the parens', '(function () {\n  function inner() {\n    return 1;\n  }\n}.call(this));\n'],
    ['a unary-prefixed .call', '!function () {\n  function inner() {\n    return 1;\n  }\n}.call(this);\n'],
    ['an arrow run through .call', '(() => {\n  function inner() {\n    return 1;\n  }\n}).call(this);\n'],
    ['.call with a receiver and an argument', '(function ($) {\n  function inner() {\n    return $;\n  }\n}).call(this, window.jQuery);\n'],
  ];
  for (const [label, source] of shapes) {
    for (const [language, ext] of [['javascript', 'js'], ['typescript', 'ts']] as const) {
      it(`${label} (${language})`, async () => {
        const ex = await extractOf(source, language, ext);
        expect(names(ex), `${label}: the function inside was not recorded`).toEqual(['inner']);
        expect(ex.symbols[0]).toMatchObject({ kind: 'function', exported: false, line: 2, endLine: 4 });
      });
    }
  }

  // ---- guards: these never run the function body, so nothing inside may be recorded ----

  it('guard: `.bind(this);` with no call after it — bound, never run — records nothing', async () => {
    // Parses exactly like `.call(this);` except for the property name (write-ahead dump).
    const ex = await extractOf('(function () {\n  function neverRuns() {\n    return 1;\n  }\n}).bind(this);\n', 'javascript', 'js');
    expect(names(ex)).toEqual([]);
  });

  it('guard: `.toString()` is not a method that runs the function — records nothing', async () => {
    const ex = await extractOf('(function () {\n  function notRun() {\n    return 1;\n  }\n}).toString();\n', 'javascript', 'js');
    expect(names(ex)).toEqual([]);
  });

  it('guard: a generator literal — calling it returns an iterator and does not run the body', async () => {
    const statement = await extractOf('(function* () {\n  function lazy() {\n    return 1;\n  }\n}).call(this);\n', 'javascript', 'js');
    expect(names(statement)).toEqual([]);
    const declarator = await extractOf('var gen = (function* () {\n  function lazy() {\n    return 1;\n  }\n})();\n', 'javascript', 'js');
    expect(names(declarator)).toEqual(['gen']);
  });

  it('guard: a function literal assigned but never invoked is an ordinary function — its helpers stay unrecorded', async () => {
    const source = [
      'const later = function () {',
      '  function helperA() {',
      '    return 1;',
      '  }',
      '  return helperA();',
      '};',
      'const later2 = () => {',
      '  function helperB() {',
      '    return 2;',
      '  }',
      '  return helperB();',
      '};',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    expect(ex.symbols.map((s) => `${s.name}:${s.kind}`)).toEqual(['later:function', 'later2:function']);
  });
});

// ================================================================================
// AC3 — the owner's layer: build steps and tour stops
// ================================================================================

const APP_MODULE = [
  'var app = (function () {',
  '  var state = { count: 0 };',
  '',
  '  function increment() {',
  '    state.count += 1;',
  '    return state.count;',
  '  }',
  '',
  '  function reset() {',
  '    state.count = 0;',
  '    return state.count;',
  '  }',
  '',
  '  function describe() {',
  "    return 'count is ' + state.count;",
  '  }',
  '',
  '  return { increment: increment, reset: reset, describe: describe };',
  '})();',
  '',
].join('\n');

const CALL_THIS_SCRIPT = [
  '(function () {',
  '  function parse(text) {',
  "    var parts = text.split(',');",
  '    return parts;',
  '  }',
  '',
  '  function render(parts) {',
  "    var out = parts.join(';');",
  '    return out;',
  '  }',
  '',
  '  this.lib = { parse: parse, render: render };',
  '}).call(this);',
  '',
].join('\n');

describe('T-16 AC3 — the functions inside become build steps and tour stops', () => {
  it('a module-pattern script: the functions inside are the symbol steps, not the wrapper', async () => {
    const { steps } = await planAndTour({ 'src/app.js': APP_MODULE, 'src/other.js': OTHER_JS }, 'src/app.js');
    // On main the wrapper `app` (1-19) is the file's one step — the learner rebuilds the whole
    // module at once. With extract alone it still is: biggest-span-first hands `app` the slot
    // and skips every function inside as an overlap. The wrapper has to yield.
    expect(steps.map((s) => `${s.name}@${s.startLine}-${s.endLine}`), 'the wrapper took the slot its functions should have').toEqual(
      ['increment@4-7', 'reset@9-12', 'describe@14-16'],
    );
  });

  it('a module-pattern script: the functions inside are tour stops', async () => {
    const { stops } = await planAndTour({ 'src/app.js': APP_MODULE, 'src/other.js': OTHER_JS }, 'src/app.js');
    // perFile 3 = the opening stop + 2: the two biggest functions, in file order.
    expect(stops, 'no function inside the wrapper became a tour stop').toEqual(['increment', 'reset']);
  });

  it('a `.call(this)` script: the functions inside are the symbol steps and the tour stops', async () => {
    const { steps, stops } = await planAndTour({ 'src/lib.js': CALL_THIS_SCRIPT, 'src/other.js': OTHER_JS }, 'src/lib.js');
    expect(steps.map((s) => s.name), 'the .call(this) wrapper\'s functions got no build steps').toEqual(['parse', 'render']);
    expect(stops, 'the .call(this) wrapper\'s functions got no tour stops').toEqual(['parse', 'render']);
  });

  it('a class inside a wrapper keeps T-12\'s rule: the class takes the slot, its methods do not', async () => {
    const source = [
      'var lib = (function () {',
      '  class Store {',
      '    get(key) {',
      '      return this.data[key];',
      '    }',
      '',
      '    set(key, value) {',
      '      this.data[key] = value;',
      '    }',
      '  }',
      '',
      '  function helper() {',
      '    return new Store();',
      '  }',
      '',
      '  return { Store: Store, helper: helper };',
      '})();',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/store.js': source, 'src/other.js': OTHER_JS }, 'src/store.js');
    expect(steps.map((s) => s.name)).toEqual(['Store', 'helper']);
  });

  it('two wrappers that each define `init` get two steps with distinct ids', async () => {
    const source = [
      'var left = (function () {',
      '  function init() {',
      "    return 'left';",
      '  }',
      '  return init;',
      '})();',
      '',
      'var right = (function () {',
      '  function init() {',
      "    return 'right';",
      '  }',
      '  return init;',
      '})();',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/twins.js': source, 'src/other.js': OTHER_JS }, 'src/twins.js');
    expect(steps.map((s) => `${s.name}@${s.startLine}`)).toEqual(['init@2', 'init@9']);
    expect(new Set(steps.map((s) => s.id)).size, 'two steps share one id').toBe(2);
  });

  it('a TypeScript ES5 class emit plans its constructor; the prototype assignments are boilerplate (disclosed trade-off)', async () => {
    // The same treatment T-15 already gives this code wrapped as a bare IIFE: assignments are
    // not declarations. Before T-16 the whole wrapper (1-9) was the one step.
    const source = [
      'var Foo = /** @class */ (function () {',
      '  function Foo(name) {',
      '    this.name = name;',
      '  }',
      '  Foo.prototype.greet = function () {',
      "    return 'hi ' + this.name;",
      '  };',
      '  return Foo;',
      '}());',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/foo.js': source, 'src/other.js': OTHER_JS }, 'src/foo.js');
    expect(steps.map((s) => `${s.name}@${s.startLine}-${s.endLine}`)).toEqual(['Foo@2-4']);
  });

  // ---- the yield rule's reach, and both of its boundaries (T-16 review, N1) ----

  it('a wrapper yields to a class inside it, not only to functions', async () => {
    const source = [
      'const Lib = (() => {',
      '  class Store {',
      '    get(key) {',
      '      return key;',
      '    }',
      '  }',
      '  return Store;',
      '})();',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/lib.js': source, 'src/other.js': OTHER_JS }, 'src/lib.js');
    expect(steps.map((s) => `${s.name}@${s.startLine}-${s.endLine}`), 'the wrapper kept the slot the class inside it should have').toEqual(
      ['Store@2-6'],
    );
  });

  it('a wrapper yields to multi-line data inside it, not only to functions', async () => {
    const source = [
      'var data = (function () {',
      '  var colors = {',
      "    red: '#f00',",
      "    blue: '#00f',",
      '  };',
      '  var sizes = [',
      '    1,',
      '    2,',
      '  ];',
      '  return { colors: colors, sizes: sizes };',
      '})();',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/data.js': source, 'src/other.js': OTHER_JS }, 'src/data.js');
    expect(steps.map((s) => `${s.name}@${s.startLine}-${s.endLine}`), 'the wrapper kept the slot the data inside it should have').toEqual(
      ['colors@2-5', 'sizes@6-9'],
    );
  });

  it("boundary: a function that starts on the wrapper's own first line is still inside it", async () => {
    const source = [
      'var app = (function () { function init() {',
      '  return 1;',
      '}',
      'return init; })();',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/app.js': source, 'src/other.js': OTHER_JS }, 'src/app.js');
    // init (1-3) starts where app (1-4) starts, but ends sooner: strictly inside.
    expect(steps.map((s) => `${s.name}@${s.startLine}-${s.endLine}`), "a function on the wrapper's first line did not count as inside it").toEqual(
      ['init@1-3'],
    );
  });

  it("boundary: a function that ends on the wrapper's own last line is still inside it", async () => {
    const source = [
      'var app = (function () {',
      '  function done() {',
      '    return 1;',
      '  } return done; })();',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/app.js': source, 'src/other.js': OTHER_JS }, 'src/app.js');
    // done (2-4) ends where app (1-4) ends, but starts later: strictly inside.
    expect(steps.map((s) => `${s.name}@${s.startLine}-${s.endLine}`), "a function on the wrapper's last line did not count as inside it").toEqual(
      ['done@2-4'],
    );
  });

  // ---- guards: what must plan exactly as it does on main ----

  it('guard: a wrapper with nothing eligible inside keeps its step (sql-gauntlet\'s argSection)', async () => {
    const source = [
      'const argSection = (function () {',
      "  const i = process.argv.indexOf('--section');",
      '  return i >= 0 ? process.argv[i + 1] : null;',
      '})();',
      '',
      'function main() {',
      '  if (argSection) {',
      '    return argSection;',
      '  }',
      "  return 'all';",
      '}',
      '',
      'main();',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/validate.js': source, 'src/other.js': OTHER_JS }, 'src/validate.js');
    // `i` is a one-line variable: recorded now, but never eligible, so it cannot take the
    // wrapper's slot. Identical to main.
    expect(steps.map((s) => s.name)).toEqual(['argSection', 'main']);
  });

  it('guard: a file that exports something keeps exactly its exported candidates', async () => {
    const source = [
      'export const app = (function () {',
      '  function increment(): number {',
      '    return 1;',
      '  }',
      '',
      '  function reset(): number {',
      '    return 0;',
      '  }',
      '',
      '  return { increment, reset };',
      '})();',
      '',
    ].join('\n');
    const { steps } = await planAndTour(
      { 'src/app.ts': source, 'src/other.ts': 'export function helperOther(): number {\n  return 1;\n}\n' },
      'src/app.ts',
    );
    // T-15's corrected out-of-scope line: a file that exports something is untouched. Its
    // candidates are its exports — `app` — exactly as on main.
    expect(steps.map((s) => `${s.name}@${s.startLine}-${s.endLine}`)).toEqual(['app@1-11']);
  });

  it('guard: two names in one statement share its range — that is not a wrapper, and plans as on main', async () => {
    const source = [
      'var CONFIG = {',
      '  retries: 3,',
      '  delay: 10,',
      '}, handler = function () {',
      '  return CONFIG.retries;',
      '};',
      '',
      'handler();',
      '',
    ].join('\n');
    const { steps } = await planAndTour({ 'src/config.js': source, 'src/other.js': OTHER_JS }, 'src/config.js');
    // extract records CONFIG and handler with the SAME statement range (1-6). Equal ranges are
    // not "strictly inside", so nothing yields: CONFIG takes the slot, as it does on main.
    expect(steps.map((s) => s.name)).toEqual(['CONFIG']);
  });

  it('guard: a generated script of 60,000 variables still plans in under a second', async () => {
    // T-16 review N2: comparing every variable with every candidate took 8 to 19 s to plan
    // this file, where main and the one-sort check take tens of milliseconds. Half the
    // variables are statements of their own. The other half are names in ONE statement, which
    // all share its range, so a check that scanned only the candidates starting inside each
    // variable would still compare every pair.
    const own = Array.from({ length: 30_000 }, (_, i) => `var v${i} = {\n  a: ${i},\n};`);
    const shared = Array.from({ length: 30_000 }, (_, i) => `  w${i} = ${i}`);
    const source = `${own.join('\n')}\nvar\n${shared.join(',\n')};\n`;
    const root = tmp('repo-tour-modules-scale-');
    try {
      write(path.join(root, 'src/table.js'), source);
      write(path.join(root, 'src/other.js'), OTHER_JS);
      const d = await digest(root, { write: false });
      const recorded = d.extracts.find((e) => e.path === 'src/table.js')?.symbols.length;
      expect(recorded, 'the generated file was not extracted, so there is nothing to time').toBe(60_000);
      const started = performance.now();
      await buildPlan(d, { root, witness: false });
      const ms = Math.round(performance.now() - started);
      expect(ms, `planning 60,000 variables took ${ms} ms: the yield check compares every pair again`).toBeLessThan(1_000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

// ================================================================================
// AC4 — one level, as T-15: a wrapper inside a recorded body is not entered
// ================================================================================

describe('T-16 AC4 — recursion stays one level', () => {
  it('guard: a module-pattern wrapper inside a top-level IIFE body is recorded, not entered', async () => {
    const source = [
      '(function () {',
      '  var inner = (function () {',
      '    function deep() {',
      '      return 1;',
      '    }',
      '    return deep;',
      '  })();',
      '',
      '  function shallow() {',
      '    return inner();',
      '  }',
      '})();',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    expect(names(ex)).toEqual(['inner', 'shallow']);
  });

  it('a `.call(this)` wrapper inside a module-pattern body is not entered', async () => {
    const source = [
      'var outer = (function () {',
      '  (function () {',
      '    function deeper() {',
      '      return 1;',
      '    }',
      '  }).call(this);',
      '',
      '  function mid() {',
      '    return 2;',
      '  }',
      '',
      '  return mid;',
      '})();',
      '',
    ].join('\n');
    const ex = await extractOf(source, 'javascript', 'js');
    expect(names(ex), 'the module body was not entered, or was entered twice').toEqual(['outer', 'mid']);
  });
});
