/**
 * T-31 — one file must never stop a digest.
 *
 * `jsImports` walked the syntax tree recursively, one call per tree level. A string
 * concatenation or a method chain is left-nested, so its tree is as deep as it is long, and
 * about 5,000 terms overflowed the stack. `extract()` had no guard per file, so the whole
 * digest threw, and the owner's tour of the whole repo failed, not just that file.
 *
 * The owner approved (GA-14, the form's Q5): "scan without recursion, and skip any single file
 * that still fails, with a note, instead of failing the tour". The checks below reach the
 * layer that sentence is about: the digest, the tour and the repo page, not only `extract()`.
 *
 * POSITIVES fail on main, each with its own message. GUARDS pass on main by design: they pin
 * what must not move (the imports the old walks reported, in their order). Each guard was also
 * turned red by a deliberate sabotage of the implementation, recorded in the handoff
 * (`.autodev/handoffs/T-31.md`). The parser running out of memory has its own file,
 * `test/parser-memory.test.ts`, because on main it leaves the process's parser dead.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as treeSitter from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { digest, type DigestResult } from '../src/digest.js';
import { extract } from '../src/extract.js';
import { inventory } from '../src/inventory.js';
import { grammarsDir } from '../src/assets.js';
import { buildCodeTour } from '../src/codetour.js';
import { renderRepoView } from '../src/repoview.js';
import { renderView } from '../src/view.js';
import type { FileRecord } from '../src/types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERMS = 20_000;

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Digest a tree, keeping a throw as a value so a check can name it in its own message. */
async function digestOf(root: string): Promise<{ result?: DigestResult; error?: unknown }> {
  try {
    return { result: await digest(root, { write: false }) };
  } catch (error) {
    return { error };
  }
}

const threw = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Precompiled-template shape: one string, built term by term, one term per line. */
function concatenation(terms: number): string {
  const lines = ["var html = '<table>'"];
  for (let i = 0; i < terms; i++) lines.push(`  + '<td>${i}</td>'`);
  return `// A precompiled template, generated.\n${lines.join('\n')};\nmodule.exports = html;\n`;
}

/** jQuery-builder shape: one chain, one call per line, with a require on its very last line. */
function chain(calls: number, lastLine: string): string {
  const lines = ["var q = $('#root')"];
  for (let i = 0; i < calls; i++) lines.push(`  .attr('k${i}', ${i})`);
  lines.push(lastLine);
  return `${lines.join('\n')}\n`;
}

describe('T-31 AC1: a 20,000-term chain digests, and the far end of it is still read', () => {
  it('a concatenation and a method chain of 20,000 terms, in JavaScript and TypeScript', async () => {
    const root = tmp('repo-tour-t31-chains-');
    try {
      write(path.join(root, 'src/other.js'), 'function other() { return 1; }\nmodule.exports = { other };\n');
      write(path.join(root, 'src/templates.js'), concatenation(TERMS));
      write(path.join(root, 'src/query.js'), chain(TERMS, "  .use(require('./other'));"));
      write(path.join(root, 'src/query.ts'), chain(TERMS, "  .use(require('./other'));"));

      const { result, error } = await digestOf(root);
      expect(error, `the digest threw on a ${TERMS.toLocaleString()}-term chain: ${threw(error)}`).toBeUndefined();
      const byPath = new Map(result!.extracts.map((e) => [e.path, e] as const));

      // The require sits on the chain's last line: 1 line for `var q`, TERMS calls, then `.use(...)`.
      const lastLine = TERMS + 2;
      for (const file of ['src/query.js', 'src/query.ts']) {
        expect(byPath.get(file)?.imports, `${file}: the require at the far end of the chain was not found`)
          .toEqual([{ raw: './other', resolved: 'src/other.js', line: lastLine }]);
      }
      expect(byPath.get('src/templates.js')?.symbols.map((s) => s.name), 'the concatenation\'s own variable')
        .toEqual(['html']);
      expect(result!.manifest.unparsed, 'nothing here should have been skipped').toEqual([]);
      expect(result!.graph.edges).toContainEqual({ from: 'src/query.js', to: 'src/other.js' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ AC1b: no recursion in src/

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Every function in src/ that takes a tree-sitter value (a parameter whose type is declared in
 * web-tree-sitter's typings) and can reach itself through calls, directly or through other
 * functions: a recursive syntax-tree walk, which a deep enough file overflows. Calls are
 * resolved by TypeScript's own checker, so two inner functions that share a name (both import
 * walks called theirs `visit`) are told apart. A function passed by name (`kids.forEach(visit)`)
 * counts as a call.
 */
function recursiveSyntaxWalks(): string[] {
  const srcDir = path.join(REPO, 'src');
  const program = ts.createProgram(sourceFiles(srcDir), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();

  type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
  const isFn = (n: ts.Node): n is Fn =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const enclosing = (n: ts.Node): Fn | null => {
    for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p;
    return null;
  };
  const target = (expr: ts.Expression): Fn | null => {
    let symbol = checker.getSymbolAtLocation(expr);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl) return null;
    if (isFn(decl)) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer && isFn(decl.initializer)) return decl.initializer;
    return null;
  };

  const calls = new Map<Fn, Set<Fn>>();
  const edge = (from: Fn | null, to: Fn | null): void => {
    if (!from || !to) return;
    if (!calls.has(from)) calls.set(from, new Set());
    calls.get(from)!.add(to);
  };
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(srcDir)) continue;
    // TypeScript's own tree of one of our source files, which is shallow: recursion is fine here.
    const scan = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        edge(enclosing(n), target(n.expression));
        for (const arg of n.arguments) if (ts.isIdentifier(arg)) edge(enclosing(n), target(arg));
      }
      ts.forEachChild(n, scan);
    };
    scan(sf);
  }

  const fromTreeSitter = (type: ts.Type): boolean =>
    (type.isUnion() ? type.types : [type]).some((t) => {
      const decl = (t.aliasSymbol ?? t.getSymbol())?.declarations?.[0];
      return !!decl && decl.getSourceFile().fileName.includes('web-tree-sitter');
    });
  const takesSyntax = (fn: Fn): boolean => fn.parameters.some((p) => fromTreeSitter(checker.getTypeAtLocation(p)));
  const reachesItself = (start: Fn): boolean => {
    const seen = new Set<Fn>();
    const stack = [...(calls.get(start) ?? [])];
    while (stack.length) {
      const fn = stack.pop()!;
      if (fn === start) return true;
      if (seen.has(fn)) continue;
      seen.add(fn);
      for (const next of calls.get(fn) ?? []) stack.push(next);
    }
    return false;
  };

  const nameOf = (fn: Fn): string => {
    if (fn.name) return fn.name.getText();
    const parent = fn.parent;
    return parent && ts.isVariableDeclaration(parent) ? parent.name.getText() : '(anonymous)';
  };
  const out: string[] = [];
  for (const fn of calls.keys()) {
    if (!takesSyntax(fn) || !reachesItself(fn)) continue;
    const sf = fn.getSourceFile();
    const line = sf.getLineAndCharacterOfPosition(fn.getStart()).line + 1;
    out.push(`${path.relative(REPO, sf.fileName)}:${line} ${nameOf(fn)}`);
  }
  return out.sort();
}

describe('T-31 AC1: no syntax-tree walk in src/ is recursive', () => {
  it('no function that takes a syntax node calls itself, directly or through another', () => {
    const walks = recursiveSyntaxWalks();
    expect(walks, `recursive syntax-tree walk(s) in src/: ${walks.join(', ')}. A tree is as deep as a chain is ` +
      'long, so a generated file overflows the stack. Walk with a cursor or an explicit stack (T-31).').toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------- AC1c: same imports, same order

/** A grammar from the same place `extract()` loads it, in this file's own parser runtime. */
async function referenceParser(language: string): Promise<treeSitter.Parser> {
  await treeSitter.Parser.init();
  const parser = new treeSitter.Parser();
  parser.setLanguage(await treeSitter.Language.load(path.join(grammarsDir(), `tree-sitter-${language}.wasm`)));
  return parser;
}

const unquote = (s: string): string => s.replace(/^['"`]/, '').replace(/['"`]$/, '');

/** The oracle: the JS/TS import walk exactly as main had it, recursion and all. Right by definition on files of ordinary depth. */
function referenceJsImports(root: SyntaxNode): Array<{ raw: string; line: number }> {
  const out: Array<{ raw: string; line: number }> = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const source = node.childForFieldName('source');
      if (source) out.push({ raw: unquote(source.text), line: node.startPosition.row + 1 });
    } else if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      const args = node.childForFieldName('arguments');
      if ((fn?.text === 'require' || fn?.type === 'import') && args) {
        const str = args.children.find((c) => c?.type === 'string');
        if (str) out.push({ raw: unquote(str.text), line: node.startPosition.row + 1 });
      }
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return out;
}

/** The oracle for Python: main's walk, capped at depth 4, recursion and all. */
function referencePythonImports(root: SyntaxNode): Array<{ raw: string; line: number }> {
  const out: Array<{ raw: string; line: number }> = [];
  const push = (raw: string, node: SyntaxNode): void => { if (raw) out.push({ raw, line: node.startPosition.row + 1 }); };
  const visit = (node: SyntaxNode, depth: number): void => {
    if (node.type === 'import_statement') {
      for (const child of node.children) {
        if (!child) continue;
        if (child.type === 'dotted_name') push(child.text, node);
        else if (child.type === 'aliased_import') {
          const inner = child.children.find((c) => c?.type === 'dotted_name');
          if (inner) push(inner.text, node);
        }
      }
      return;
    }
    if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name')
        ?? node.children.find((c) => c?.type === 'relative_import' || c?.type === 'dotted_name');
      if (mod) push(mod.text, node);
      return;
    }
    if (depth < 4) for (const child of node.children) if (child) visit(child, depth + 1);
  };
  for (const child of root.children) if (child) visit(child, 0);
  return out;
}

const PYTHON_DEPTHS = `import a
from b import c
if TYPE_CHECKING:
    import d
try:
    from e import f
except ImportError:
    pass
class C:
    def m(self):
        import g
        if ready:
            import h
`;

function recordFor(rel: string, language: string): FileRecord {
  return {
    path: rel, repo: '', bytes: 1, loc: 1, language, sha256: '', classification: 'source', signals: [], binary: false,
  };
}

describe('T-31 AC1 guard: the walks report what the recursive walks did, in the same order', () => {
  it('every .ts file of this repository, and a Python file with imports at every depth', async () => {
    const tsParser = await referenceParser('typescript');
    const pyParser = await referenceParser('python');
    const files = [...sourceFiles(path.join(REPO, 'src')), ...sourceFiles(path.join(REPO, 'test'))];
    expect(files.length).toBeGreaterThan(40);

    const { extracts } = await extract(REPO, files.map((f) => recordFor(path.relative(REPO, f), 'typescript')));
    const walked = new Map(extracts.map((e) => [e.path, e.imports.map((i) => ({ raw: i.raw, line: i.line }))] as const));
    let compared = 0;
    for (const file of files) {
      const rel = path.relative(REPO, file);
      const tree = tsParser.parse(fs.readFileSync(file, 'utf8'))!;
      expect(walked.get(rel), `${rel}: imports differ from the recursive walk`).toEqual(referenceJsImports(tree.rootNode));
      tree.delete();
      compared++;
    }
    expect(compared).toBe(files.length);

    const dir = tmp('repo-tour-t31-python-');
    try {
      write(path.join(dir, 'deep.py'), PYTHON_DEPTHS);
      const py = await extract(dir, [recordFor('deep.py', 'python')]);
      const tree = pyParser.parse(PYTHON_DEPTHS)!;
      const reference = referencePythonImports(tree.rootNode);
      tree.delete();
      const got = py.extracts[0]?.imports.map((i) => ({ raw: i.raw, line: i.line }));
      expect(got, 'Python imports differ from the recursive walk').toEqual(reference);
      // depth 4 (`import g`, inside a method) is read; depth 6 (`import h`, inside an `if` there) never was
      expect(got?.map((i) => i.raw)).toEqual(['a', 'b', 'd', 'e', 'g']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ------------------------------------------------------ AC2: one failing file is skipped, with a note

const MARKER = 'T-31: this file makes the parser fail';
const requireHere = createRequire(import.meta.url);

/**
 * Make `parse` fail for any source holding MARKER, on both copies of the parser a digest could
 * be using: the ES module that main imports, and the CommonJS copy T-31 loads so that it can let
 * go of it. Everything else calls through to the real parser.
 */
function failParsesOf(how: 'throw' | 'null'): void {
  const copies = new Set<typeof treeSitter.Parser>([treeSitter.Parser, requireHere('web-tree-sitter').Parser]);
  for (const ParserClass of copies) {
    const real = ParserClass.prototype.parse;
    vi.spyOn(ParserClass.prototype, 'parse').mockImplementation(function (this: treeSitter.Parser, ...args) {
      if (typeof args[0] === 'string' && args[0].includes(MARKER)) {
        if (how === 'null') return null;
        throw new TypeError('injected by test/iterative-walks.test.ts');
      }
      return real.apply(this, args);
    });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

const appTree: Record<string, string> = {
  'src/app.js': "const util = require('./util');\nconst broken = require('./broken');\n\n" +
    '/** Starts everything. */\nfunction start() { return util.helper() + broken.value; }\nmodule.exports = { start };\n',
  'src/util.js': '/** A helper the app leans on. */\nfunction helper() { return 1; }\nmodule.exports = { helper };\n',
  'src/broken.js': `// ${MARKER}\nfunction value() { return 2; }\nmodule.exports = { value };\n`,
  'src/zeta.js': "const util = require('./util');\nfunction last() { return util.helper(); }\nmodule.exports = { last };\n",
};

function plant(files: Record<string, string>): string {
  const root = tmp('repo-tour-t31-guard-');
  for (const [rel, body] of Object.entries(files)) write(path.join(root, rel), body);
  return root;
}

describe('T-31 AC2: one file that fails is skipped with a note, and the digest goes on', () => {
  it('a parse that throws: the file is listed with why, every other file is read', async () => {
    const root = plant(appTree);
    try {
      failParsesOf('throw');
      const { result, error } = await digestOf(root);
      expect(error, `one file's parse failing ended the whole digest: ${threw(error)}`).toBeUndefined();
      expect(result!.manifest.unparsed).toEqual([
        { path: 'src/broken.js', reason: 'TypeError: injected by test/iterative-walks.test.ts' },
      ]);
      expect(result!.extracts.map((e) => e.path)).toEqual(['src/app.js', 'src/util.js', 'src/zeta.js']);
      // the files after it are read in full, imports and all
      expect(result!.graph.edges).toContainEqual({ from: 'src/zeta.js', to: 'src/util.js' });
      expect(result!.manifest.counts.parsed).toBe(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a parse that returns no tree: the file is listed, not dropped without a word', async () => {
    const root = plant(appTree);
    try {
      failParsesOf('null');
      const { result, error } = await digestOf(root);
      expect(error, threw(error)).toBeUndefined();
      expect(result!.manifest.unparsed, 'a file the parser gave no tree for vanished without a note').toEqual([
        { path: 'src/broken.js', reason: 'the parser returned no tree' },
      ]);
      expect(result!.extracts.map((e) => e.path)).toEqual(['src/app.js', 'src/util.js', 'src/zeta.js']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a file gone between the inventory and the parse: listed, not dropped without a word', async () => {
    const root = plant(appTree);
    try {
      const inv = inventory(root);
      fs.rmSync(path.join(root, 'src/util.js'));
      const result = await extract(root, inv.files);
      expect(result.unparsed, 'a file that could not be read vanished without a note').toEqual([
        { path: 'src/util.js', reason: expect.stringMatching(/^could not be read: ENOENT/) },
      ]);
      expect(result.extracts.map((e) => e.path)).toEqual(['src/app.js', 'src/broken.js', 'src/zeta.js']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ----------------------------------------------------------------- AC4: where the owner looks

describe('T-31 AC4: the repo page names the file it did not read, and the tour goes around it', () => {
  it('the bar says which file and why, the file is marked, and every other file is toured', async () => {
    const root = plant(appTree);
    try {
      failParsesOf('throw');
      const { result, error } = await digestOf(root);
      expect(error, `the digest threw, so there is no page at all: ${threw(error)}`).toBeUndefined();
      const r = result!;

      const plan = buildCodeTour(r);
      const toured = new Set(plan.steps.map((s) => s.file));
      expect(toured.has('src/broken.js'), 'the tour stopped in a file it could not read').toBe(false);
      for (const f of ['src/app.js', 'src/util.js']) expect(toured.has(f), `${f} was not toured`).toBe(true);

      const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });
      // The bar under the stop count, where the eye already is.
      const bar = /<div class="bar unread">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
      expect(bar, 'no "not read" bar on the repo page').toContain('src/broken.js');
      expect(bar).toContain('1 file was not read');
      expect(bar).toContain('TypeError: injected by test/iterative-walks.test.ts');

      // The file is still browsable, and carries its note into the tree and the file header.
      const data = JSON.parse(/window\.__REPO__ = (\{[\s\S]*?\});<\/script>/.exec(html)![1]!);
      const broken = data.files.find((f: { path: string }) => f.path === 'src/broken.js');
      expect(broken?.unread, 'the browsable copy of the file does not say it was not read')
        .toBe('TypeError: injected by test/iterative-walks.test.ts');
      expect(data.files.find((f: { path: string }) => f.path === 'src/util.js')?.unread).toBeUndefined();
      expect(html, 'the page script never marks a not-read file in the tree').toContain('class="nr"');
      expect(html, 'the page script never says so in the file header').toContain("' · not read: '");

      // The digest view (`repo-tour view`) says it too.
      expect(renderView(r)).toContain('1 file was not read');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a page with nothing skipped has no such bar', async () => {
    const root = plant({ ...appTree, 'src/broken.js': 'function value() { return 2; }\nmodule.exports = { value };\n' });
    try {
      const r = await digest(root, { write: false });
      const plan = buildCodeTour(r);
      const html = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });
      expect(html, 'a "not read" bar on a page where every file was read').not.toContain('class="bar unread"');
      expect(renderView(r), 'the digest view says a file was not read when every file was').not.toContain('was not read');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
