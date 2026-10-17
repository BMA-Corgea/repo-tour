/**
 * T-38 — a file near the parser's limit must not take the JS heap with it.
 *
 * web-tree-sitter caches a node's child list on the node: `node.children` (and `namedChildren`)
 * builds one JS node object per child, about 270 bytes each, and keeps them until the parent is
 * dropped. For the root, that is until the file is done. Error recovery gives an ERROR node one
 * child per token, and a root, an IIFE body or a class body holds one child per statement or
 * member: 4 MiB of `(` parses to a root with 4,194,307 children, and reading them held 1.1 GB of
 * JS heap on top of the parser's own (`.autodev/reviews/T-31.md`, O2). The owner approved the
 * cheap fix (GA-15): walk with a cursor, which builds one node per step and keeps none.
 *
 * POSITIVES fail on main, each with its own message. GUARDS pass on main by design: they pin what
 * must not move (the error counts, symbols and imports a file gave before). Each guard was also
 * turned red by a deliberate sabotage of the implementation, recorded in the handoff
 * (`.autodev/handoffs/T-38.md`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as treeSitter from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { extract, initParsers } from '../src/extract.js';
import { grammarsDir } from '../src/assets.js';
import type { FileExtract, FileRecord } from '../src/types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIB = 1024 * 1024;
const requireHere = createRequire(import.meta.url);

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function recordFor(rel: string, language: string): FileRecord {
  return {
    path: rel, repo: '', bytes: 1, loc: 1, language, sha256: '', classification: 'source', signals: [], binary: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------- AC1: no walk reads a cached child list

/**
 * Every read in src/ of a web-tree-sitter node's cached child list, as "file:line function". Each
 * `children` and `namedChildren` name is resolved by TypeScript's checker, so a page script's DOM
 * `children` is not counted, and each shape of read is: `a.children`, `a?.children`,
 * `a['children']`, and `const { children } = a`. Also returns every other web-tree-sitter member the
 * check resolved, so a check can make sure the types still resolve: if they did not, nothing would
 * resolve and nothing would be found.
 */
function cachedChildReads(): { reads: string[]; resolved: Set<string> } {
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
  const CACHED = new Set(['children', 'namedChildren']);
  const fromTreeSitter = (symbol: ts.Symbol | undefined): boolean =>
    !!symbol?.declarations?.some((d) => d.getSourceFile().fileName.includes('web-tree-sitter'));
  const memberOf = (object: ts.Expression, name: string): ts.Symbol | undefined =>
    checker.getPropertyOfType(checker.getNonNullableType(checker.getTypeAtLocation(object)), name);

  type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
  const isFn = (n: ts.Node): n is Fn =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const enclosingName = (n: ts.Node): string => {
    for (let p = n.parent; p; p = p.parent) {
      if (!isFn(p)) continue;
      if (p.name) return p.name.getText();
      if (p.parent && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText();
    }
    return '(top level)';
  };

  const reads: string[] = [];
  const resolved = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(srcDir)) continue;
    const scan = (n: ts.Node): void => {
      let name: string | null = null;
      let symbol: ts.Symbol | undefined;
      if (ts.isPropertyAccessExpression(n)) {
        name = n.name.text;
        symbol = checker.getSymbolAtLocation(n.name);
      } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
        name = n.argumentExpression.text;
        symbol = memberOf(n.expression, name);
      } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
        const key = n.propertyName ?? n.name;
        if (ts.isIdentifier(key)) {
          name = key.text;
          symbol = checker.getPropertyOfType(checker.getTypeAtLocation(n.parent), name);
        }
      }
      if (name !== null && fromTreeSitter(symbol)) {
        if (CACHED.has(name)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          reads.push(`${path.relative(REPO, sf.fileName)}:${line} ${enclosingName(n)}`);
        } else {
          resolved.add(name);
        }
      }
      ts.forEachChild(n, scan);
    };
    scan(sf);
  }
  return { reads, resolved };
}

describe('T-38 AC1: no walk in src/ reads a cached child list', () => {
  it('nothing reads `children` or `namedChildren` of a syntax node; children come from a cursor', () => {
    const { reads, resolved } = cachedChildReads();
    // The check is only worth something while it can resolve web-tree-sitter's types at all.
    for (const member of ['childForFieldName', 'walk', 'gotoFirstChild', 'nodeType', 'hasError']) {
      expect([...resolved], `the check no longer resolves \`${member}\` to web-tree-sitter: are its types resolving?`)
        .toContain(member);
    }
    expect(reads, `${reads.length} read(s) of a node's cached child list in src/: ${reads.join(', ')}. ` +
      'web-tree-sitter keeps one JS object per child on the node until the node is dropped, 270 bytes each, so ' +
      'a wide node holds gigabytes (T-38). Visit children with a cursor.').toEqual([]);
  }, 60_000);
});

// ------------------------------------------------------- AC2: the JS heap stays flat on a wide tree

/**
 * A full collection, asked for from inside the test, as `test/parser-memory.test.ts` does and with the
 * same note: vitest does not start this process with --expose-gc, and changing a V8 flag after
 * start-up is documented as unpredictable; this one only makes `gc` available to new contexts.
 */
async function collect(): Promise<void> {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  await new Promise((r) => setTimeout(r, 50));
  gc();
}

/**
 * The most live JS heap any collection saw while `run` ran, above what was live before it. A walk that
 * keeps one JS node per child keeps every one of them live until the file is done, so each collection
 * on the way counts them; a cursor's nodes are garbage at once. Also returns how many collections ran:
 * none would mean nothing was measured.
 */
async function liveHeapGrowth(run: () => Promise<unknown>): Promise<{ grownMiB: number; collections: number }> {
  await collect();
  const before = v8.getHeapStatistics().used_heap_size;
  const profiler = new v8.GCProfiler();
  profiler.start();
  await run();
  const { statistics } = profiler.stop();
  const peak = Math.max(before, ...statistics.map((s) => s.afterGC.heapStatistics.usedHeapSize));
  return { grownMiB: Math.round((peak - before) / MIB), collections: statistics.length };
}

/** About a million children on one node, each shape reaching a different walk. */
const WIDE: Array<{ label: string; language: string; file: string; source: () => string }> = [
  // an ERROR root with 1,048,579 children: `countErrors` and `jsSymbols`' top level
  { label: 'JavaScript, 1 MiB of `(`', language: 'javascript', file: 'src/wide.js', source: () => `var u = ${'('.repeat(MIB)}` },
  // an ERROR root with 1,048,578 children: `countErrors`, `pythonSymbols`, `pythonImports`
  { label: 'Python, 1 MiB of `(`', language: 'python', file: 'src/wide.py', source: () => `u = ${'('.repeat(MIB)}` },
  // a script-style module, all of it inside an IIFE: the body loop, not the root, holds the children
  {
    label: 'a script-style IIFE body of a million statements', language: 'javascript', file: 'src/script.js',
    source: () => `(function () {\n${'a;\n'.repeat(MIB)}})();\n`,
  },
];

describe('T-38 AC2: a wide tree does not grow the JS heap while it is walked', () => {
  for (const wide of WIDE) {
    it(wide.label, async () => {
      const root = tmp('repo-tour-t38-wide-');
      try {
        write(path.join(root, wide.file), wide.source());
        let result: Awaited<ReturnType<typeof extract>> | undefined;
        const { grownMiB, collections } = await liveHeapGrowth(async () => {
          result = await extract(root, [recordFor(wide.file, wide.language)]);
        });
        expect(result!.unparsed, 'the wide file should parse').toEqual([]);
        expect(result!.extracts).toHaveLength(1);
        expect(collections, 'no collection ran while the file was walked, so nothing was measured').toBeGreaterThan(0);
        expect(grownMiB, `walking ${wide.label} kept ${grownMiB} MiB more JS heap live than before it: ` +
          'a node\'s cached child list holds one JS object per child until the file is done').toBeLessThan(100);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);
  }
});

// ------------------------------------------------------- AC3: the output is unchanged

/** A grammar from the same place `extract()` loads it, in this file's own parser runtime. */
async function referenceParser(language: string): Promise<treeSitter.Parser> {
  await treeSitter.Parser.init();
  const parser = new treeSitter.Parser();
  parser.setLanguage(await treeSitter.Language.load(path.join(grammarsDir(), `tree-sitter-${language}.wasm`)));
  return parser;
}

/** The oracle: `countErrors` exactly as main had it, a stack of nodes and their cached child lists. */
function referenceCountErrors(node: SyntaxNode): number {
  let n = 0;
  const stack: SyntaxNode[] = [node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === 'ERROR' || cur.isMissing) n++;
    if (cur.hasError) for (const c of cur.children) if (c) stack.push(c);
  }
  return n;
}

/** MISSING nodes alone, so a check can make sure its inputs hold some. */
function referenceMissing(node: SyntaxNode): number {
  let n = 0;
  const stack: SyntaxNode[] = [node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.isMissing) n++;
    if (cur.hasError) for (const c of cur.children) if (c) stack.push(c);
  }
  return n;
}

const unquote = (s: string): string => s.replace(/^['"`]/, '').replace(/['"`]$/, '');

/** The oracle for JavaScript and TypeScript imports: main's recursive walk (as test/iterative-walks.test.ts). */
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

/** The oracle for Python imports: main's walk, capped at depth 4 (as test/iterative-walks.test.ts). */
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

/** A small seeded generator (mulberry32), so the mutants are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BREAKERS = ['(', ')', '{', '}', '[', ']', "'", '"', '`', '/*', '<', '${', ':', ',', '\n', 'def ', 'import '];

/** Two broken copies of `text`: spans deleted, and stray brackets and quotes put in. Seeded. */
function mutants(text: string, seed: number): string[] {
  const rnd = seeded(seed);
  const at = (): number => Math.floor(rnd() * Math.max(1, text.length));
  let cut = text;
  for (let i = 0; i < 3; i++) {
    const from = Math.floor(rnd() * Math.max(1, cut.length));
    cut = cut.slice(0, from) + cut.slice(from + 1 + Math.floor(rnd() * 40));
  }
  const spots = Array.from({ length: 5 }, at).sort((a, b) => b - a);
  let stray = text;
  for (const spot of spots) stray = stray.slice(0, spot) + BREAKERS[Math.floor(rnd() * BREAKERS.length)] + stray.slice(spot);
  return [cut, stray];
}

/** Python with every shape the walks read: definitions, a class, decorators, docstrings, imports at each depth. */
const PYTHON_SAMPLE = `"""A module docstring."""
import os, sys as system, collections.abc
from . import sibling
from .pkg.mod import thing as other
from typing import (TYPE_CHECKING, Any)

LIMIT = 10
_private_limit = 3

if TYPE_CHECKING:
    import json
try:
    from yaml import safe_load
except ImportError:
    safe_load = None


def documented(a, b=2):
    """Adds the two.

    Args:
        a: the first.
    """
    return a + b


def commented():
    # a comment first
    """The doc after a comment."""
    x = 1
    return x


@decorator
def decorated():
    pass


class Shape:
    """A shape."""

    def area(self):
        import math
        return math.pi

    @property
    def _hidden(self):
        return 0

    async def later(self):
        if True:
            import deep
        return None


a, B = 1, 2
LAST = (1,
        2)
`;

describe('T-38 AC3 guard: error counts and imports are what main\'s walks gave', () => {
  it('this repository\'s own files and seeded broken copies of them, in all four grammars', async () => {
    const parsers = {
      typescript: await referenceParser('typescript'),
      javascript: await referenceParser('javascript'),
      tsx: await referenceParser('tsx'),
      python: await referenceParser('python'),
    };
    const ext: Record<string, string> = { typescript: 'ts', javascript: 'js', tsx: 'tsx', python: 'py' };
    const texts = [...sourceFiles(path.join(REPO, 'src')), ...sourceFiles(path.join(REPO, 'test'))]
      .map((f) => fs.readFileSync(f, 'utf8'));
    expect(texts.length).toBeGreaterThan(40);

    const inputs: Array<{ language: keyof typeof parsers; text: string }> = [];
    texts.forEach((text, i) => {
      // TypeScript as itself, and as JavaScript and TSX, where its types and generics are errors
      for (const language of ['typescript', 'javascript', 'tsx'] as const) {
        inputs.push({ language, text });
        for (const broken of mutants(text, i * 7 + language.length)) inputs.push({ language, text: broken });
      }
    });
    for (let i = 0; i < 40; i++) {
      for (const broken of mutants(PYTHON_SAMPLE, 1000 + i)) inputs.push({ language: 'python', text: broken });
    }
    inputs.push({ language: 'python', text: PYTHON_SAMPLE });

    const dir = tmp('repo-tour-t38-errors-');
    try {
      const records = inputs.map((input, i) => {
        const rel = `f${String(i).padStart(5, '0')}.${ext[input.language]}`;
        fs.writeFileSync(path.join(dir, rel), input.text);
        return recordFor(rel, input.language);
      });
      const { extracts, unparsed } = await extract(dir, records);
      expect(unparsed).toEqual([]);
      const byPath = new Map(extracts.map((e) => [e.path, e] as const));

      let withErrors = 0;
      let withMissing = 0;
      records.forEach((record, i) => {
        const input = inputs[i]!;
        const tree = parsers[input.language].parse(input.text)!;
        const errors = referenceCountErrors(tree.rootNode);
        const imports = input.language === 'python' ? referencePythonImports(tree.rootNode) : referenceJsImports(tree.rootNode);
        if (errors > 0) withErrors++;
        if (referenceMissing(tree.rootNode) > 0) withMissing++;
        const got = byPath.get(record.path);
        expect(got?.parseErrors, `${record.path} (${input.language}): parse errors differ from main's count`).toBe(errors);
        expect(got?.imports.map((x) => ({ raw: x.raw, line: x.line })), `${record.path} (${input.language}): imports differ from main's walk`)
          .toEqual(imports);
        tree.delete();
      });
      // A guard over error counts is only worth something if its inputs carry errors, MISSING nodes among them.
      expect(withErrors, 'too few inputs with parse errors to test the count').toBeGreaterThan(200);
      expect(withMissing, 'too few inputs with MISSING nodes to test the count').toBeGreaterThan(50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

/** The real extractor over one in-memory source file (as test/module-iifes.test.ts). */
async function extractOf(source: string, language: string, ext: string): Promise<FileExtract> {
  const dir = tmp('repo-tour-t38-site-');
  try {
    const rel = `f.${ext}`;
    fs.writeFileSync(path.join(dir, rel), source);
    const { extracts } = await extract(dir, [recordFor(rel, language)]);
    expect(extracts, 'extract() produced nothing for this fixture').toHaveLength(1);
    return extracts[0]!;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const brief = (x: FileExtract): string[] =>
  x.symbols.map((s) => `${s.kind} ${s.name}@${s.line}-${s.endLine}${s.exported ? ' exported' : ''}${s.doc ? ` "${s.doc}"` : ''}`);

/**
 * Every child-listing site in one script, each written so that a child dropped, repeated or taken out of
 * order changes a symbol or an import: the first and the last top-level statements are declarations; a
 * class, a declaration and an IIFE body each hold three or more; one `require` holds two strings.
 */
const SCRIPT = `function zeroth() { return 0; }
const lib = require('./lib', './not-this');

/** Exported, at the top level. */
export function alpha() { return 1; }

class Beta {
  first() {}
  _middle() {}
  last() {}
}

const one = 1, two = () => 2, three = function () { return 3; };

var app = (function () {
  function init() {}
  var state = {};
  class Inner { run() {} }
})(), after = 4;

(function () {
  function runs() {}
  const also = () => 0;
  let tail;
})();

export * from './things';
function omega() { return import('./lazy'); }
`;

const TYPES = `export interface Shape { area(): number }
type Size = 'small' | 'large';
enum Kind { A, B }
export abstract class Base {
  abstract area(): number;
  describe(): string { return 'base'; }
  #secret(): void {}
}
export const { a, b } = { a: 1, b: 2 };
export default function main(): void {}
`;

describe('T-38 AC3 guard: each child-listing site gives the symbols and imports it gave on main', () => {
  it('a script: the top level, a class body, declarators, a module-pattern wrapper, an IIFE body, call arguments', async () => {
    const x = await extractOf(SCRIPT, 'javascript', 'js');
    expect(brief(x)).toEqual([
      'function zeroth@1-1',
      'variable lib@2-2',
      'function alpha@5-5 exported "Exported, at the top level."',
      'class Beta@7-11',
      'method first@8-8',
      'method _middle@9-9',
      'method last@10-10',
      'variable one@13-13',
      'function two@13-13',
      'function three@13-13',
      'variable app@15-19',
      'variable after@15-19',
      'function init@16-16',
      'variable state@17-17',
      'class Inner@18-18',
      'method run@18-18',
      'function runs@22-22',
      'function also@23-23',
      'variable tail@24-24',
      'function omega@28-28',
    ]);
    expect(x.imports.map((i) => `${i.raw}@${i.line}`)).toEqual(['./lib@2', './things@27', './lazy@28']);
    expect(x.parseErrors).toBe(0);
  });

  it('TypeScript declarations: interfaces, types, enums, an abstract class, and a default export', async () => {
    for (const [language, ext] of [['typescript', 'ts'], ['tsx', 'tsx']] as const) {
      const x = await extractOf(TYPES, language, ext);
      expect(brief(x), language).toEqual([
        'interface Shape@1-1 exported',
        'type Size@2-2',
        'enum Kind@3-3',
        'class Base@4-8 exported',
        'method describe@6-6 exported',
        'method #secret@7-7',
        'function main@10-10 exported',
      ]);
    }
  });

  it('Python: the top level, a class body, docstrings after a comment, decorators, and imports at each depth', async () => {
    const x = await extractOf(PYTHON_SAMPLE, 'python', 'py');
    expect(brief(x)).toEqual([
      'variable LIMIT@7-7 exported',
      'function documented@18-24 exported "Adds the two."',
      'function commented@27-31 exported "The doc after a comment."',
      'function decorated@35-36 exported',
      'class Shape@39-53 exported "A shape."',
      'method area@42-44 exported',
      'method _hidden@47-48',
      'method later@50-53 exported',
      'variable LAST@57-58 exported',
    ]);
    expect(x.imports.map((i) => `${i.raw}@${i.line}`)).toEqual([
      'os@2', 'sys@2', 'collections.abc@2', '.@3', '.pkg.mod@4', 'typing@5', 'json@11', 'yaml@13', 'math@43',
    ]);
    expect(x.parseErrors).toBe(0);
  });
});

describe('T-38 AC3 guard: every cursor a walk opens is deleted', () => {
  it('as many cursors deleted as opened, over files of every shape (a cursor\'s wasm memory is not collected)', async () => {
    await initParsers();
    // extract()'s own copy of the parser is the one in require.cache once its parsers are loaded
    const copy = requireHere('web-tree-sitter') as typeof treeSitter;
    const opened = vi.spyOn(copy.Node.prototype, 'walk');
    const deleted = vi.spyOn(copy.TreeCursor.prototype, 'delete');
    const dir = tmp('repo-tour-t38-cursors-');
    try {
      const files: Array<[string, string, string]> = [
        ['a.js', 'javascript', SCRIPT], ['b.ts', 'typescript', TYPES], ['c.tsx', 'tsx', TYPES],
        ['d.py', 'python', PYTHON_SAMPLE], ['e.js', 'javascript', `${SCRIPT}\nfoo(\n`], ['f.py', 'python', `${PYTHON_SAMPLE}\ndef (\n`],
      ];
      for (const [rel, , text] of files) fs.writeFileSync(path.join(dir, rel), text);
      const { extracts } = await extract(dir, files.map(([rel, language]) => recordFor(rel, language)));
      expect(extracts).toHaveLength(files.length);
      expect(opened.mock.calls.length, 'no walk opened a cursor').toBeGreaterThan(0);
      expect(deleted.mock.calls.length, `${opened.mock.calls.length} cursors opened, ${deleted.mock.calls.length} deleted`)
        .toBe(opened.mock.calls.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
