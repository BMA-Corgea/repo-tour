/**
 * T-30 — build scaffolds that parse.
 *
 * The VS Code tutorial hands a learner a practice file: the reference file with each planned
 * range replaced by `stubFile` (its `src/dial/writer.ts`, the scaffolded position), and later
 * runs `check()` on what they saved. `stubJsLikeRange` kept a range through its first `{`, added
 * the TODO line and closed with one `}`. When that brace sat inside a bracket still open — a
 * module-pattern wrapper, a callback handed to a call, a destructured or default parameter — the
 * closers after it were dropped, the practice file did not parse, and the checker reported errors
 * the learner never made. So the checks here go through the layer the owner uses: digest →
 * buildPlan → stubFile with the plan's own ranges and the tutorial's own questions → re-parse.
 *
 * `test/build.test.ts` (T-12), `test/build-scripts.test.ts` (T-15) and `test/module-iifes.test.ts`
 * (T-16) are byte-frozen, so the helpers needed here are copied in their minimal form.
 *
 * Every fixture is written for this file. None is copied from anyone's repository: where a shape
 * comes from the owner's own code (a wrapper around one value, a request handler passed to a
 * call), the fixture is a stand-in with the same structure and its own names.
 *
 * POSITIVES fail on main, each with its own message, and pass once the change lands. GUARDS pass on
 * main by design: they pin what must not move, the practice files main already got right.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { digest } from '../src/digest.js';
import { extract } from '../src/extract.js';
import { buildPlan } from '../src/build/plan.js';
import { stubFile, type StubQuestion } from '../src/build/stub.js';
import { check } from '../src/build/check.js';
import type { BuildPlan, Range } from '../src/build/types.js';
import type { FileExtract, FileRecord } from '../src/types.js';

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const LANGUAGE_BY_EXT: Record<string, string> = { '.js': 'javascript', '.ts': 'typescript', '.tsx': 'tsx' };

function languageOf(file: string): string {
  const language = LANGUAGE_BY_EXT[path.extname(file)];
  if (!language) throw new Error(`no language for ${file}`);
  return language;
}

/** The real extractor over one in-memory source file, read back whole. */
async function extractOf(source: string, language: string, ext: string): Promise<FileExtract> {
  const dir = tmp('repo-tour-scaffold-extract-');
  try {
    const relPath = `f.${ext}`;
    fs.writeFileSync(path.join(dir, relPath), source);
    const record: FileRecord = {
      path: relPath, repo: '', bytes: Buffer.byteLength(source, 'utf8'), loc: source.split(/\r?\n/).length,
      language, sha256: '', classification: 'source', signals: [], binary: false,
    };
    const { extracts } = await extract(dir, [record]);
    expect(extracts, 'extract() produced nothing for this fixture').toHaveLength(1);
    return extracts[0]!;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const parseErrorsOf = async (source: string, language: string, ext: string): Promise<number> =>
  (await extractOf(source, language, ext)).parseErrors;

const Q: StubQuestion[] = [{ ordinal: 1, question: 'q' }];
const TODO = '// TODO(step 1): q';

/** The range `extract()` really reports for `name`: never a hand-counted line number. */
async function rangeOf(source: string, language: string, ext: string, name: string): Promise<Range> {
  const sym = (await extractOf(source, language, ext)).symbols.find((s) => s.name === name);
  expect(sym, `extract() reported no symbol named ${name}`).toBeDefined();
  return { startLine: sym!.line, endLine: sym!.endLine };
}

// ================================================================================
// The fixture tree: one file per shape, planned once, every JS/TS practice file written as the
// tutorial writes it.
// ================================================================================

const FILES: Record<string, string> = {
  // ---- AC1: a wrapper that keeps its step
  // A module-pattern wrapper around one value: the shape of the owner's own broken practice file.
  'src/settings.js': [
    'const pageSize = (function () {',
    '  const fromEnv = Number(process.env.PAGE_SIZE);',
    '  return fromEnv > 0 ? fromEnv : 25;',
    '})();',
    '',
    'function pageCount(total) {',
    '  return Math.ceil(total / pageSize);',
    '}',
    '',
    'module.exports = { pageCount };',
    '',
  ].join('\n'),
  // A multi-line value passed to a call: the ticket's Backbone shape.
  'src/models.js': [
    'var Note = Backbone.Model.extend({',
    "  defaults: { title: '', pinned: false },",
    '  pin: function () {',
    "    this.set('pinned', true);",
    '  }',
    '});',
    '',
  ].join('\n'),
  // A handler passed to a call: the shape of the owner's own server, with its own names.
  'src/listener.js': [
    "const net = require('net');",
    '',
    'const echo = net.createServer(async function (socket) {',
    "  socket.setEncoding('utf8');",
    "  socket.on('data', (chunk) => socket.write(chunk));",
    '});',
    '',
    'echo.listen(4100);',
    '',
  ].join('\n'),

  // ---- AC2: the same defect in other shapes
  'src/save.js': [
    'async function save(file, data, options = {}) {',
    '  const text = JSON.stringify(data, null, options.indent || 2);',
    '  return fs.promises.writeFile(file, text);',
    '}',
    '',
  ].join('\n'),
  'src/area.js': [
    'function area({ width, height }) {',
    '  return width * height;',
    '}',
    '',
  ].join('\n'),
  'src/fetcher.js': [
    "function fetcher(url, opts = { method: 'GET', retries: 3, timeoutMs: 5000, cache: 'no-store' }) {",
    '  return fetch(url, opts);',
    '}',
    '',
  ].join('\n'),
  'src/Badge.tsx': [
    'export const Badge = ({ label, tone }: { label: string; tone: string }) => {',
    '  const text = label.toUpperCase();',
    '  return <span className={tone}>{text}</span>;',
    '};',
    '',
  ].join('\n'),
  'src/Card.tsx': [
    'export function Card({ title }: { title: string }) {',
    '  const heading = title.trim();',
    '  return <h2>{heading}</h2>;',
    '}',
    '',
  ].join('\n'),
  'src/panel.ts': [
    '@Register({',
    "  tag: 'side-panel',",
    '})',
    'class SidePanel {',
    '  visible = false;',
    '  open(): void {',
    '    this.visible = true;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/limits.js': [
    'const limits = strict ? {',
    '  max: 10,',
    '  min: 1,',
    '  step: 1,',
    '} : {',
    '  max: 100,',
    '};',
    '',
  ].join('\n'),
  'src/theme.ts': [
    'export type Theme = Readonly<{',
    '  accent: string;',
    '  radius: number;',
    '}>;',
    '',
  ].join('\n'),
  'src/columns.js': [
    'const COLUMNS = [',
    "  { key: 'id', width: 40 },",
    "  { key: 'name', width: 200 },",
    '];',
    '',
  ].join('\n'),
  'src/doubled.ts': [
    'export const doubled = [1, 2, 3].map((n) => n * 2);',
    '',
  ].join('\n'),
  'src/tick.ts': [
    'export const tick = hasTimer ? () => timer.read() : fallbackTick;',
    '',
  ].join('\n'),

  // ---- review attempt 1, BLOCKER 2: which block is the body. Main hid each of these.
  'src/shape.ts': [
    'export type Shape =',
    "  | { kind: 'circle'; r: number }",
    "  | { kind: 'square'; side: number }",
    "  | { kind: 'rect'; w: number; h: number };",
    '',
  ].join('\n'),
  'src/gate.ts': [
    'export type Gate = { open: false } | ({ open: true } & Reason);',
    '',
  ].join('\n'),
  'src/bands.ts': [
    'export const BANDS: { id: string; label: string }[] = [',
    "  { id: 'low', label: 'Low' },",
    "  { id: 'high', label: 'High' },",
    '];',
    '',
  ].join('\n'),
  'src/counter.ts': [
    'export const useCounter = create<{ count: number; inc: () => void }>()((set) => ({',
    '  count: 0,',
    '  inc: () => set((s) => ({ count: s.count + 1 })),',
    '}));',
    '',
  ].join('\n'),
  'src/Field.tsx': [
    'export const Field = forwardRef<HTMLInputElement, { label: string; hint?: string }>((props, ref) => {',
    '  const id = useId();',
    '  return <input id={id} ref={ref} />;',
    '});',
    '',
  ].join('\n'),
  'src/auth.ts': [
    'export function useAuth(): { user: string | null; login: () => void; logout: () => void } {',
    '  return useContext(AuthContext);',
    '}',
    '',
  ].join('\n'),
  'src/fixtures.ts': [
    'export const test = base.extend<{ offline: boolean }>({',
    '  offline: [false, { option: true }],',
    '});',
    '',
  ].join('\n'),
  // ---- review attempt 1, SUGGESTION 1: where main was broken, hide the body, not a parameter or an attribute
  // The shape of shadcn/ui's Button (MIT), written here in its minimal form rather than copied.
  'src/Button.tsx': [
    'export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(',
    '  ({ className, variant, ...props }, ref) => (',
    '    <button className={cn(className, variant)} ref={ref} {...props} />',
    '  ),',
    ');',
    '',
  ].join('\n'),
  'src/Item.tsx': [
    'export const Item = ({ label }: { label: string }) => <li className="item">{label}</li>;',
    '',
  ].join('\n'),
  'src/ui.ts': [
    'export const useUi = create<UiState>()(',
    '  persist((set) => ({',
    '    open: false,',
    '    toggle: () => set((s) => ({ open: !s.open })),',
    "  }), { name: 'ui' }),",
    ');',
    '',
  ].join('\n'),
  'src/click.ts': [
    'export const onClick = useCallback<(e: MouseEvent) => void>((e) => {',
    '  e.preventDefault();',
    '}, []);',
    '',
  ].join('\n'),

  // ---- review attempt 1, BLOCKER 1: JSX text is text. Main hid each of these bodies.
  'src/Notice.tsx': [
    'export function Notice(props: Props) {',
    "  const label = props.sent ? 'done' : 'waiting';",
    "  return <div title={label}>{props.sent && <p>It's sent.</p>}</div>;",
    '}',
    '',
  ].join('\n'),
  'src/Help.tsx': [
    'export function Help({ url }: { url: string }) {',
    '  const label = url.trim();',
    '  return <p>{url && <a href={url}>https://example.com/help</a>} or {label}</p>;',
    '}',
    '',
  ].join('\n'),
  'src/Steps.tsx': [
    'export function Steps() {',
    '  const n = 2;',
    '  return <ol><li>1) Install</li><li>{n}) Run</li></ol>;',
    '}',
    '',
  ].join('\n'),
  'src/Status.tsx': [
    'export function Status({ ok }: { ok: boolean }) {',
    "  const tone = ok ? 'good' : 'bad';",
    "  return <span className={tone}>{ok ? <b>It's on</b> : null}</span>;",
    '}',
    '',
  ].join('\n'),
  'src/Thanks.tsx': [
    'export function Thanks({ who }: { who: string }) {',
    '  const name = who.trim();',
    '  return <p>Thanks, {name} :)</p>;',
    '}',
    '',
  ].join('\n'),
  'src/notice.js': [
    'function Notice(props) {',
    "  const label = props.sent ? 'done' : 'waiting';",
    "  return <div title={label}>{props.sent && <p>It's sent.</p>}</div>;",
    '}',
    '',
  ].join('\n'),
  'src/Banner.tsx': [
    'export function Banner() {',
    '  const year = 2026;',
    '  return (<div className="banner',
    '    wide">(c) {year}</div>);',
    '}',
    '',
  ].join('\n'),

  // A comment between a tag's attributes (found by the hide probe: the owner's components do this).
  'src/Cover.tsx': [
    'export function Cover({ src }: { src: string }) {',
    "  const alt = '';",
    '  return (',
    '    <img',
    "      // the cover's figures are all in the text below",
    '      src={src} /* decorative: */ alt={alt}',
    '    />',
    '  );',
    '}',
    '',
  ].join('\n'),

  // ---- a variable's type is never its body: an arrow's return-type literal, an annotation's own arrow
  'src/parse.ts': [
    'export const parse = (raw: string): { ok: boolean; value: unknown; error: string | null } => JSON.parse(raw);',
    '',
  ].join('\n'),
  'src/twice.ts': [
    'export const twice: (n: number) => number = (n) => n * 2;',
    '',
  ].join('\n'),

  // ---- a conditional type: its `? … : …` must survive the cut (found by the hide probe after slice 1)
  'src/unwrap.ts': [
    'export type Unwrap<T> = T extends Promise<infer U>',
    '  ? { value: U; settled: true }',
    '  : { value: T; settled: false };',
    '',
  ].join('\n'),
  'src/isglobal.ts': [
    'export type IsGlobal<N extends string> = typeof globalThis extends {',
    '  [K in N]: unknown;',
    '}',
    '  ? true',
    '  : false;',
    '',
  ].join('\n'),
  'src/Row.tsx': [
    'export const Row = ({ cells }: { cells: string[] }) => (',
    '  <tr>',
    '    {cells.map((c) => <td key={c}>{c}</td>)}',
    '  </tr>',
    ');',
    '',
  ].join('\n'),
  'src/route.js': [
    'var handle = route({ auth: true }, function (req) {',
    '  const user = req.user;',
    '  return user.name;',
    '});',
    '',
  ].join('\n'),
  // T-16 review, fixture Q2: a `.call(this)` script whose body declares a call-wrapped value.
  'src/card-view.js': [
    '(function () {',
    '  var CardView = Backbone.View.extend({',
    "    tagName: 'li',",
    '    render: function () {',
    "      this.el.textContent = this.model.get('title');",
    '      return this;',
    '    }',
    '  });',
    '  window.CardView = CardView;',
    '}).call(this);',
    '',
  ].join('\n'),
  // T-16 review, fixture P11: a no-paren module pattern whose body declares one.
  'src/board.js': [
    'var board = function () {',
    '  var Cell = Backbone.Model.extend({',
    '    defaults: { alive: false },',
    '    flip: function () {',
    "      this.set('alive', !this.get('alive'));",
    '    }',
    '  });',
    '  return { Cell: Cell };',
    '}();',
    '',
  ].join('\n'),

  // ---- AC4: functions inside a wrapper keep their indentation
  'src/widgets.js': [
    '(function () {',
    '  function init() {',
    '    return 1;',
    '  }',
    '  function render() {',
    '    return 2;',
    '  }',
    '})();',
    '',
  ].join('\n'),
};

interface Practice {
  file: string;
  language: string;
  reference: string;
  ranges: Range[];
  scaffold: string;
  errors: number;
  referenceErrors: number;
  extract: FileExtract;
}

let root: string;
let plan: BuildPlan;
const practice = new Map<string, Practice>();

beforeAll(async () => {
  root = tmp('repo-tour-scaffolds-');
  for (const [rel, body] of Object.entries(FILES)) write(path.join(root, rel), body);
  const d = await digest(root, { write: false });
  plan = await buildPlan(d, { root, witness: false });
  const symbolSteps = plan.steps.filter((s) => s.kind === 'symbol');

  for (const step of plan.steps) {
    if (step.kind !== 'file' || step.scaffold.loadBearing.length === 0) continue;
    const file = step.target.file;
    const language = languageOf(file);
    const reference = fs.readFileSync(path.join(root, file), 'utf8');
    // The tutorial's `stubQuestionsFor`: a range is named after the symbol step that starts on its
    // first line, else after the file step itself.
    const questions = step.scaffold.loadBearing.map((r) => {
      const owner = symbolSteps.find((s) => s.target.file === file && s.target.startLine === r.startLine);
      return owner
        ? { ordinal: owner.ordinal, question: owner.decision.question }
        : { ordinal: step.ordinal, question: step.decision.question };
    });
    const scaffold = stubFile(reference, step.scaffold.loadBearing, language, questions);
    const ext = path.extname(file).slice(1);
    practice.set(file, {
      file, language, reference, ranges: step.scaffold.loadBearing, scaffold,
      errors: await parseErrorsOf(scaffold, language, ext),
      referenceErrors: await parseErrorsOf(reference, language, ext),
      extract: d.extracts.find((e) => e.path === file)!,
    });
  }
}, 60_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The practice file for `file`, after proving the plan really made `lines` one of its ranges: a
 * shape that never becomes a step would make every assertion below vacuous.
 */
function practiceFor(file: string, lines: [number, number]): Practice {
  const p = practice.get(file);
  expect(p, `the plan wrote no practice file for ${file}`).toBeDefined();
  expect(p!.ranges, `${file}: lines ${lines[0]}-${lines[1]} are not one of the plan's ranges`)
    .toContainEqual({ startLine: lines[0], endLine: lines[1] });
  expect(p!.referenceErrors, `${file}: the reference itself does not parse, so a zero below would mean nothing`).toBe(0);
  return p!;
}

function expectParses(p: Practice): void {
  expect(p.errors, `${p.file}: the practice file has ${p.errors} parse error(s) the learner did not make:\n${p.scaffold}`).toBe(0);
}

function expectHidden(p: Practice, answer: string): void {
  expect(p.scaffold.includes(answer), `${p.file}: the practice file hands over the answer (${answer})`).toBe(false);
}

function expectKept(p: Practice, text: string): void {
  expect(p.scaffold.includes(text), `${p.file}: the practice file lost ${JSON.stringify(text)}:\n${p.scaffold}`).toBe(true);
}

// ================================================================================
// AC1 — a wrapper that keeps its step: the wrapper stays, its body is hidden, the file parses
// ================================================================================

describe('T-30 AC1 — a step whose first brace opens inside an unclosed ( keeps its tail', () => {
  it('a module-pattern wrapper around one value: kept whole around a hidden body, and it parses', () => {
    const p = practiceFor('src/settings.js', [1, 4]);
    expectParses(p);
    expectKept(p, 'const pageSize = (function () {');
    expect(p.scaffold, 'the wrapper\'s tail `})();` was dropped').toMatch(/\n\}\)\(\);\n/);
    expectHidden(p, 'process.env.PAGE_SIZE');
    expect(p.scaffold, 'the hidden body has no TODO naming its step').toMatch(/const pageSize = \(function \(\) \{\n {2}\/\/ TODO\(step \d+\): /);
  });

  it('the checker, run on that practice file untouched, reports no parse error', async () => {
    const p = practiceFor('src/settings.js', [1, 4]);
    const report = await check(p.scaffold, p.extract, p.language, p.file);
    expect(report.parseErrors, `check() reports ${report.parseErrors} parse error(s) on a file the learner has not touched: ${report.reason}`).toBe(0);
    expect(report.reason, 'a clean report carries no reason').toBeUndefined();
    expect(report.ok, 'an untouched practice file of a script that exports nothing should check clean').toBe(true);
  });

  it('a multi-line value passed to a call: `var Note = Backbone.Model.extend({…});`', () => {
    const p = practiceFor('src/models.js', [1, 6]);
    expectParses(p);
    expectKept(p, 'var Note = Backbone.Model.extend({');
    expect(p.scaffold, 'the call\'s tail `});` was dropped').toMatch(/\n\}\);\n/);
    expectHidden(p, 'pinned: false');
  });

  it('a handler passed to a call keeps the call around its hidden body', () => {
    const p = practiceFor('src/listener.js', [3, 6]);
    expectParses(p);
    expectKept(p, 'const echo = net.createServer(async function (socket) {');
    expectKept(p, "const net = require('net');");
    expectKept(p, 'echo.listen(4100);');
    expectHidden(p, "socket.setEncoding('utf8')");
    expect(p.scaffold, 'the call\'s tail `});` was dropped').toMatch(/\n\}\);\n\necho\.listen/);
  });
});

// ================================================================================
// AC2 — every JS/TS practice file the plan produces parses: the same defect in other shapes
// ================================================================================

describe('T-30 AC2 — the same defect in other shapes: each practice file parses', () => {
  it('a default parameter object: the body is hidden, not the `{}` default', () => {
    const p = practiceFor('src/save.js', [1, 4]);
    expectParses(p);
    expectKept(p, 'async function save(file, data, options = {}) {');
    expectHidden(p, 'JSON.stringify');
  });

  it('destructured parameters: the body is hidden, not the pattern', () => {
    const p = practiceFor('src/area.js', [1, 3]);
    expectParses(p);
    expectKept(p, 'function area({ width, height }) {');
    expectHidden(p, 'width * height');
  });

  it('a default parameter bigger than the body: the body is still the one hidden', () => {
    const p = practiceFor('src/fetcher.js', [1, 3]);
    expectParses(p);
    expectKept(p, "function fetcher(url, opts = { method: 'GET', retries: 3, timeoutMs: 5000, cache: 'no-store' }) {");
    expectHidden(p, 'fetch(url, opts)');
  });

  it('a React arrow component with destructured props (tsx)', () => {
    const p = practiceFor('src/Badge.tsx', [1, 4]);
    expectParses(p);
    expectKept(p, 'export const Badge = ({ label, tone }: { label: string; tone: string }) => {');
    expectHidden(p, 'toUpperCase');
  });

  it('a React function component with destructured props (tsx)', () => {
    const p = practiceFor('src/Card.tsx', [1, 4]);
    expectParses(p);
    expectKept(p, 'export function Card({ title }: { title: string }) {');
    expectHidden(p, 'title.trim()');
  });

  it('a decorated class: the decorator\'s argument stays, the class body is hidden', () => {
    const p = practiceFor('src/panel.ts', [1, 9]);
    expectParses(p);
    expectKept(p, "@Register({\n  tag: 'side-panel',\n})\nclass SidePanel {");
    expectHidden(p, 'this.visible = true');
  });

  it('a ternary of two objects: the bigger branch is hidden and the other survives', () => {
    const p = practiceFor('src/limits.js', [1, 7]);
    expectParses(p);
    expectHidden(p, 'step: 1');
    expectKept(p, '} : {\n  max: 100,\n};');
  });

  it('a type literal inside a generic: `Readonly<{…}>` keeps its `}>;`', () => {
    const p = practiceFor('src/theme.ts', [1, 4]);
    expectParses(p);
    expectKept(p, 'export type Theme = Readonly<{');
    expectHidden(p, 'accent: string');
    expect(p.scaffold, 'the generic\'s tail `}>;` was dropped').toMatch(/\n\}>;\n/);
  });

  // Changed at review attempt 1, with the foreman's approval (t30-01): this test said "left whole". A
  // declaration's list of records is its body, so it is hidden whole; never one element of it.
  it('a list of records is hidden whole, never cut inside one element', () => {
    const p = practiceFor('src/columns.js', [1, 4]);
    expectParses(p);
    expectKept(p, 'const COLUMNS = [');
    expectHidden(p, "key: 'id'");
    expectHidden(p, "key: 'name'");
    expect(p.scaffold, 'the list\'s own `];` was dropped').toMatch(/\n\];\n/);
  });

  it('an arrow inside a call: `values.map((n) => n * 2)` keeps the call\'s `);`', () => {
    const p = practiceFor('src/doubled.ts', [1, 1]);
    expectParses(p);
    expectKept(p, 'export const doubled = [1, 2, 3].map((n) => {');
    expectHidden(p, 'n * 2');
    expect(p.scaffold, 'the call\'s tail `);` was dropped').toMatch(/\n\}\);\n/);
  });

  it('an arrow that is the first branch of a conditional is left whole: its body ends at the `:`', () => {
    const p = practiceFor('src/tick.ts', [1, 1]);
    expectParses(p);
    expect(p.scaffold, 'the conditional lost its second branch').toBe(p.reference);
  });

  it('a JSX body in parentheses: the whole body is hidden, not one expression inside it', () => {
    const p = practiceFor('src/Row.tsx', [1, 5]);
    expectParses(p);
    expectKept(p, 'export const Row = ({ cells }: { cells: string[] }) => {');
    expectHidden(p, '<tr>');
  });

  it('an options object then a callback: the callback\'s body is hidden, the options stay', () => {
    const p = practiceFor('src/route.js', [1, 4]);
    expectParses(p);
    expectKept(p, 'var handle = route({ auth: true }, function (req) {');
    expectHidden(p, 'req.user');
    expect(p.scaffold, 'the call\'s tail `});` was dropped').toMatch(/\n\}\);\n/);
  });

  it('T-16 review Q2: a call-wrapped value inside a `.call(this)` script', () => {
    const p = practiceFor('src/card-view.js', [2, 8]);
    expectParses(p);
    expectKept(p, '  var CardView = Backbone.View.extend({');
    expectKept(p, '}).call(this);');
    expectHidden(p, "tagName: 'li'");
  });

  it('T-16 review P11: a call-wrapped value inside a no-paren module pattern', () => {
    const p = practiceFor('src/board.js', [2, 7]);
    expectParses(p);
    expectKept(p, '  var Cell = Backbone.Model.extend({');
    expectKept(p, '}();');
    expectHidden(p, 'alive: false');
  });

  it('a union type: every member is hidden, as main hid them', () => {
    const p = practiceFor('src/shape.ts', [1, 4]);
    expectParses(p);
    for (const member of ["kind: 'circle'", "kind: 'square'", "kind: 'rect'"]) expectHidden(p, member);
  });

  it('an arrow\'s return-type literal is a type: the body is hidden, the return type kept', () => {
    const p = practiceFor('src/parse.ts', [1, 1]);
    expectParses(p);
    expectKept(p, '(raw: string): { ok: boolean; value: unknown; error: string | null } => {');
    expectHidden(p, 'JSON.parse');
  });

  it('a typed constant\'s own arrow is its type: the value\'s arrow is the body', () => {
    const p = practiceFor('src/twice.ts', [1, 1]);
    expectParses(p);
    expectKept(p, 'export const twice: (n: number) => number = (n) => {');
    expectHidden(p, 'n * 2');
  });

  it('guard: an index is never a list to hide', () => {
    const source = 'export const first = rows[0] ?? fallback;\n';
    expect(stubFile(source, [{ startLine: 1, endLine: 1 }], 'typescript', Q)).toBe(source);
  });

  it('a conditional type keeps its `? … : …`: one branch is hidden and the file parses', () => {
    const p = practiceFor('src/unwrap.ts', [1, 3]);
    expectParses(p);
    expectHidden(p, 'settled: true');
    expectKept(p, ': { value: T; settled: false };');
  });

  it('a conditional type whose check is a type literal keeps its branches', () => {
    const p = practiceFor('src/isglobal.ts', [1, 5]);
    expectParses(p);
    expectHidden(p, '[K in N]');
    expectKept(p, '  ? true\n  : false;');
  });

  it('a union with a parenthesised intersection: both members are hidden', () => {
    const p = practiceFor('src/gate.ts', [1, 1]);
    expectParses(p);
    expectHidden(p, 'open: false');
    expectHidden(p, 'open: true');
  });

  it('a typed constant: the records are hidden, never the type annotation', () => {
    const p = practiceFor('src/bands.ts', [1, 4]);
    expectParses(p);
    expectKept(p, 'export const BANDS: { id: string; label: string }[] = [');
    expectHidden(p, "id: 'low'");
  });

  it('a type argument is never the body: zustand\'s create<{…}>()((set) => …) hides the store', () => {
    const p = practiceFor('src/counter.ts', [1, 4]);
    expectParses(p);
    expectKept(p, 'create<{ count: number; inc: () => void }>()((set) => ');
    expectHidden(p, 'count: 0');
  });

  it('a type argument is never the body: forwardRef<El, {…}>((props, ref) => {…}) hides the component', () => {
    const p = practiceFor('src/Field.tsx', [1, 4]);
    expectParses(p);
    expectKept(p, 'forwardRef<HTMLInputElement, { label: string; hint?: string }>((props, ref) => {');
    expectHidden(p, 'useId()');
  });

  it('a return-type literal bigger than the body: the body is hidden, the return type kept', () => {
    const p = practiceFor('src/auth.ts', [1, 3]);
    expectParses(p);
    expectKept(p, 'export function useAuth(): { user: string | null; login: () => void; logout: () => void } {');
    expectHidden(p, 'useContext');
  });

  it('a call\'s object after a type argument: base.extend<{…}>({…}) hides the object', () => {
    const p = practiceFor('src/fixtures.ts', [1, 3]);
    expectParses(p);
    expectKept(p, 'export const test = base.extend<{ offline: boolean }>({');
    expectHidden(p, 'option: true');
  });

  it('shadcn\'s forwardRef: the arrow\'s body is hidden, its destructured parameters kept', () => {
    const p = practiceFor('src/Button.tsx', [1, 5]);
    expectParses(p);
    expectKept(p, '({ className, variant, ...props }, ref) => {');
    expectHidden(p, '<button');
  });

  it('a one-line arrow component: the whole JSX is hidden, not one attribute', () => {
    const p = practiceFor('src/Item.tsx', [1, 1]);
    expectParses(p);
    expectKept(p, 'export const Item = ({ label }: { label: string }) => {');
    expectHidden(p, '<li');
  });

  it('zustand\'s persist: the store is hidden, not the options object', () => {
    const p = practiceFor('src/ui.ts', [1, 6]);
    expectParses(p);
    expectHidden(p, 'open: false');
  });

  it('an arrow inside a type argument is never cut: useCallback<(e) => void>((e) => {…}) hides the callback', () => {
    const p = practiceFor('src/click.ts', [1, 3]);
    expectParses(p);
    expectKept(p, 'useCallback<(e: MouseEvent) => void>((e) => {');
    expectHidden(p, 'preventDefault');
  });

  for (const [file, lines, answer, what] of [
    ['src/Notice.tsx', [1, 4], "const label = props.sent ? 'done'", "an apostrophe in JSX text (It's sent.)"],
    ['src/Help.tsx', [1, 4], 'url.trim()', 'a URL in JSX text (https://…)'],
    ['src/Steps.tsx', [1, 4], 'const n = 2', 'prose brackets in JSX text (1) Install)'],
    ['src/Status.tsx', [1, 4], "ok ? 'good' : 'bad'", 'an apostrophe in a conditional\'s JSX branch'],
    ['src/Thanks.tsx', [1, 4], 'who.trim()', 'a smiley in JSX text (:))'],
    ['src/notice.js', [1, 4], "const label = props.sent ? 'done'", 'JSX in a .js file, with an apostrophe'],
    ['src/Banner.tsx', [1, 5], 'const year = 2026', 'a JSX attribute string that spans two lines'],
    ['src/Cover.tsx', [1, 9], "const alt = ''", "a comment between a tag's attributes, with an apostrophe"],
  ] as Array<[string, [number, number], string, string]>) {
    it(`JSX text is text: ${what} does not stop the body being hidden`, () => {
      const p = practiceFor(file, lines);
      expectParses(p);
      expectHidden(p, answer);
    });
  }

  it('every JS/TS practice file this plan produces parses (the sweep)', () => {
    expect(practice.size, 'the plan wrote fewer practice files than the fixture tree has shapes').toBeGreaterThanOrEqual(16);
    const broken = [...practice.values()]
      .filter((p) => p.referenceErrors === 0 && p.errors !== 0)
      .map((p) => `${p.file} (${p.errors} parse errors)`);
    expect(broken, `practice files that do not parse: ${broken.join(', ')}`).toEqual([]);
  });
});

// ================================================================================
// AC4 — where main's practice file already parsed, it stays what it was
// ================================================================================

describe('T-30 AC4 — the stub stays a stub: main\'s output where main already parsed', () => {
  it('guard: a function, byte for byte', async () => {
    const source = 'export function run(job: string): string {\n  const shouted = job.toUpperCase();\n  return shouted;\n}\n';
    const range = await rangeOf(source, 'typescript', 'ts', 'run');
    expect(stubFile(source, [range], 'typescript', Q)).toBe(`export function run(job: string): string {\n  ${TODO}\n}\n`);
  });

  it('guard: a class, byte for byte', async () => {
    const source = 'export class Engine {\n  start(): number {\n    return 1;\n  }\n}\n';
    const range = await rangeOf(source, 'typescript', 'ts', 'Engine');
    expect(stubFile(source, [range], 'typescript', Q)).toBe(`export class Engine {\n  ${TODO}\n}\n`);
  });

  it('guard: an interface, byte for byte', async () => {
    const source = 'export interface Job {\n  id: string;\n  retries: number;\n}\n';
    const range = await rangeOf(source, 'typescript', 'ts', 'Job');
    expect(stubFile(source, [range], 'typescript', Q)).toBe(`export interface Job {\n  ${TODO}\n}\n`);
  });

  it('guard: a constant with nothing to hide is untouched, in JS and in TS', () => {
    for (const [source, language] of [['export const LIMIT = 3;\n', 'typescript'], ["const NAME = 'tour';\n", 'javascript']]) {
      expect(stubFile(source!, [{ startLine: 1, endLine: 1 }], language!, Q), `${language}: a constant changed`).toBe(source);
    }
  });

  it('guard: every line outside the ranges survives byte for byte, in every practice file', () => {
    for (const p of practice.values()) {
      const lines = p.reference.split('\n');
      let cursor = 1;
      for (const r of [...p.ranges].sort((a, b) => a.startLine - b.startLine)) {
        const between = lines.slice(cursor - 1, r.startLine - 1).join('\n');
        if (between.trim() !== '') expect(p.scaffold.includes(between), `${p.file}: lines ${cursor}-${r.startLine - 1} changed`).toBe(true);
        cursor = r.endLine + 1;
      }
      const rest = lines.slice(cursor - 1).join('\n');
      expect(p.scaffold.endsWith(rest), `${p.file}: the lines after the last range changed`).toBe(true);
    }
  });

  it('guard: an apostrophe in JSX text does not stop the body being hidden', async () => {
    const source = "export const Notice = () => {\n  return <p>Don't {verb} twice</p>;\n};\n";
    const range = await rangeOf(source, 'tsx', 'tsx', 'Notice');
    const out = stubFile(source, [range], 'tsx', Q);
    expect(out.includes("Don't"), `the body was not hidden:\n${out}`).toBe(false);
    expect(await parseErrorsOf(out, 'tsx', 'tsx')).toBe(0);
  });

  it('guard: a comma or a semicolon in JSX text does not end an arrow\'s body', async () => {
    for (const source of ['export const Hi = () => <p>Hello, world</p>;\n', 'export const Gap = () => <p>a&nbsp;b</p>;\n']) {
      const out = stubFile(source, [{ startLine: 1, endLine: 1 }], 'tsx', Q);
      expect(out.includes('<p>'), `the body was not hidden:\n${out}`).toBe(false);
      expect(await parseErrorsOf(out, 'tsx', 'tsx'), `does not parse:\n${out}`).toBe(0);
    }
  });

  it('guard: braces inside a regex, a template, a string and a comment are not the body\'s', async () => {
    const cases: Array<[string, string, string]> = [
      ['split', 'export function split(s: string): string[] {\n  return s.split(/[{]/);\n}\n', 's.split'],
      ['wrap', 'export function wrap(n: number): string {\n  return `{${n}`;\n}\n', 'return `'],
      ['close', "export function close(): string {\n  return '}';\n}\n", "return '}'"],
      ['count', 'export function count(): number {\n  // } a stray brace\n  return 1;\n}\n', 'return 1'],
      ['quantify', "export function trim(s: string): string {\n  return s.replace(/^\\s{2,}/, '');\n}\n", 's.replace'],
      ['nest', 'export function nest(): string {\n  return `a${`{`}b`;\n}\n', 'return `'],
      // review attempt 1, SUGGESTION 2: an escaped quote (M3), `return` before a regex (M1), a `/` in a regex class (M2)
      ['quote', "export function quote(): string {\n  return 'it\\'s {';\n}\n", "return 'it"],
      ['isOpen', 'export function isOpen(s: string): boolean {\n  return /[{]/.test(s);\n}\n', '.test(s)'],
      ['parts', 'export function parts(s: string): string[] {\n  return s.split(/[/{]/);\n}\n', 's.split'],
    ];
    for (const [name, source, answer] of cases) {
      const range = await rangeOf(source, 'typescript', 'ts', name === 'quantify' ? 'trim' : name);
      const out = stubFile(source, [range], 'typescript', Q);
      expect(out.includes(answer), `${name}: the body was not hidden:\n${out}`).toBe(false);
      expect(await parseErrorsOf(out, 'typescript', 'ts'), `${name}: does not parse:\n${out}`).toBe(0);
    }
  });

  it('guard: a regex holding `<` or `>`, and a non-null assertion before a division, do not stop the body being hidden', async () => {
    const cases: Array<[string, string, string]> = [
      ['escape', "export function escape(s: string): string {\n  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');\n}\n", 's.replace'],
      ['centre', 'export function centre(s: number[], n: number): number[] {\n  const out = [Math.round(s[0]! / n), Math.round(s[1]! / n), Math.round(s[2]! / n)];\n  return out;\n}\n', 'Math.round'],
    ];
    for (const [name, source, answer] of cases) {
      const range = await rangeOf(source, 'typescript', 'ts', name);
      const out = stubFile(source, [range], 'typescript', Q);
      expect(out.includes(answer), `${name}: the body was not hidden:\n${out}`).toBe(false);
      expect(await parseErrorsOf(out, 'typescript', 'ts'), `${name}: does not parse:\n${out}`).toBe(0);
    }
  });

  it('guard: an arrow whose own body is a conditional, or that is a conditional\'s second branch, is still hidden', async () => {
    const cases: Array<[string, string]> = [
      ["export const pick = (n: number) => n > 0 ? 'up' : 'down';\n", "'up'"],
      ['export const tock = hasTimer ? fallbackTock : () => timer.read();\n', 'timer.read'],
    ];
    for (const [source, answer] of cases) {
      const out = stubFile(source, [{ startLine: 1, endLine: 1 }], 'typescript', Q);
      expect(out.includes(answer), `the body was not hidden:\n${out}`).toBe(false);
      expect(await parseErrorsOf(out, 'typescript', 'ts'), `does not parse:\n${out}`).toBe(0);
    }
  });

  it('guard: a function whose return type is a function type keeps its body as the body', async () => {
    const source = 'export function make(): () => void {\n  const fire = () => {};\n  return fire;\n}\n';
    const range = await rangeOf(source, 'typescript', 'ts', 'make');
    expect(stubFile(source, [range], 'typescript', Q)).toBe(`export function make(): () => void {\n  ${TODO}\n}\n`);
  });

  it('the statement\'s own `;` after an arrow\'s body is kept, not dropped', async () => {
    const source = 'export const add = (a: number, b: number) => a + b;\n';
    const range = await rangeOf(source, 'typescript', 'ts', 'add');
    expect(stubFile(source, [range], 'typescript', Q)).toBe(`export const add = (a: number, b: number) => {\n  ${TODO}\n};\n`);
  });

  it('a function inside a wrapper keeps its indentation on the TODO line and its closing brace', () => {
    const p = practiceFor('src/widgets.js', [2, 4]);
    expectParses(p);
    expect(p.scaffold, `the indented stub lost its indentation:\n${p.scaffold}`)
      .toMatch(/\n {2}function init\(\) \{\n {4}\/\/ TODO\(step \d+\): [^\n]*\n {2}\}\n {2}function render\(\) \{\n/);
  });
});

// ================================================================================
// AC5 — a range the stubber cannot read is left alone
// ================================================================================

describe('T-30 AC5 — a range the scan cannot read comes back byte for byte', () => {
  it('a range that starts inside one function and ends inside, or after, the next', async () => {
    const source = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n';
    for (const range of [{ startLine: 2, endLine: 4 }, { startLine: 2, endLine: 6 }]) {
      const out = stubFile(source, [range], 'javascript', Q);
      expect(out, `lines ${range.startLine}-${range.endLine}: a range with a closer it never opened was cut:\n${out}`).toBe(source);
      expect(await parseErrorsOf(out, 'javascript', 'js')).toBe(0);
    }
  });

  it('a range that ends inside the next declaration, after a block it could have cut', async () => {
    const source = 'const a = {\n  x: 1,\n};\nfunction b() {\n  return 2;\n}\n';
    const out = stubFile(source, [{ startLine: 1, endLine: 4 }], 'javascript', Q);
    expect(out, `a range with a bracket still open at its end was cut:\n${out}`).toBe(source);
    expect(await parseErrorsOf(out, 'javascript', 'js')).toBe(0);
  });

  it('a range whose brackets cross, which only a misread can produce, is not cut on the crossed pair', () => {
    const source = 'const crossed = wrap((1 }, { 2 ));\n';
    const out = stubFile(source, [{ startLine: 1, endLine: 1 }], 'javascript', Q);
    expect(out, `a range whose brackets cross was cut:\n${out}`).toBe(source);
  });

  // Review attempt 1, BLOCKER 3, the shape of a minified bundle: a declaration starts mid-line, on a
  // line whose first character closes a template opened on the line before. Read from the range alone,
  // that backtick opens a template instead, code and template swap, the backticks still balance, and
  // `${name}` looks like a block to cut.
  it('a range that starts inside a template opened earlier in the file is left alone', async () => {
    const source = [
      'const header = `',
      '  <h1>Hi</h1>',
      '`;function render(name) {',
      '  return `<p>${name}</p>`;',
      '}const footer = `',
      '  <p>bye</p>',
      '`;',
      '',
    ].join('\n');
    const out = stubFile(source, [{ startLine: 3, endLine: 5 }], 'javascript', Q);
    expect(out, `a range that starts inside a template was cut:\n${out}`).toBe(source);
    expect(await parseErrorsOf(out, 'javascript', 'js')).toBe(0);
  });

  // Review attempt 1, M7: this test once passed with its rule deleted, because nothing in the range
  // was a candidate. The object before the template is one, so only the rule keeps it whole.
  it('a range that ends inside a template literal', () => {
    const source = "const settings = { theme: 'dark' }; const page = `\n<main>{body}</main>\n`;\n";
    const out = stubFile(source, [{ startLine: 1, endLine: 2 }], 'javascript', Q);
    expect(out, `a range that ends inside a template was cut:\n${out}`).toBe(source);
  });
});
