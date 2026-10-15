/**
 * Stage 3 — Extract. Parsers, never models.
 *
 * A parser cannot invent a function that does not exist. Everything here is a fact
 * read off a syntax tree; nothing is inferred, guessed, or summarized. Stage 4 is
 * handed this skeleton and asked only what it *means*.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Node as SyntaxNode, Parser, Tree } from 'web-tree-sitter';
import type {
  FileExtract, FileRecord, ImportGraph, ImportRecord, SymbolKind, SymbolRecord, UnparsedFile,
} from './types.js';
import { grammarsDir } from './assets.js';

type TreeSitter = typeof import('web-tree-sitter');

/** Grammar versions are pinned by the resolved package — see spec §10, grammar drift. */
function grammarPath(name: string): string {
  return path.join(grammarsDir(), `tree-sitter-${name}.wasm`);
}

const GRAMMAR_FOR: Record<string, string> = {
  python: 'python',
  javascript: 'javascript',
  typescript: 'typescript',
  tsx: 'tsx',
};

/**
 * T-31 — the parser runtime, held so that it can be let go of.
 *
 * web-tree-sitter runs ONE wasm instance per loaded copy of the package, with a heap capped at
 * 2 GiB. A file that needs more aborts it, and every later call into that copy throws
 * `Aborted()`: for the rest of the digest, and for every digest after it in a server that runs
 * for days. A copy cannot be restarted in place. It has to be dropped, and a fresh one loaded.
 *
 * So the package is loaded with `require`, never `import`: an ES module stays loaded for the
 * life of the process, and the dead copy's heap with it. Each copy comes through its own
 * `createRequire`, and letting go of one deletes it from `require.cache`. With its parsers
 * dropped too, nothing reaches it, and V8 frees its heap at the next collection. Measured: 2.1 GB
 * back to 70 MB after one collection, and three aborts in a row never held more than one heap.
 * Neither loading a copy nor letting go of one adds a process listener.
 */
interface Runtime {
  treeSitter: TreeSitter;
  parsers: Map<string, Parser>;
  /** Delete this copy from `require.cache`: once its parsers are dropped, the last thing that reaches it. */
  forget(): void;
}

let runtime: Runtime | null = null;
let starting: Promise<Runtime> | null = null;

function liveRuntime(): Promise<Runtime> {
  if (runtime) return Promise.resolve(runtime);
  starting ??= (async () => {
    const load = createRequire(import.meta.url);
    const id = load.resolve('web-tree-sitter');
    const treeSitter = load('web-tree-sitter') as TreeSitter;
    const forget = (): void => { delete load.cache[id]; };
    try {
      await treeSitter.Parser.init();
    } catch (err) {
      forget();
      throw err;
    }
    const rt: Runtime = { treeSitter, parsers: new Map(), forget };
    runtime = rt;
    return rt;
  })().finally(() => { starting = null; });
  return starting;
}

/** Let go of a runtime that trapped: its state cannot be trusted, and after an abort it holds its whole heap. */
function release(rt: Runtime): void {
  if (runtime !== rt) return;
  runtime = null;
  rt.parsers.clear();
  rt.forget();
}

/**
 * The live runtime's parser for `language`, or null. Read without awaiting, so that nothing can
 * let go of the runtime between this read and the parse that follows it.
 */
function readyParser(language: string): { rt: Runtime; parser: Parser } | null {
  const rt = runtime;
  const parser = rt?.parsers.get(language);
  return rt && parser ? { rt, parser } : null;
}

export async function initParsers(languages: string[] = Object.keys(GRAMMAR_FOR)): Promise<void> {
  const rt = await liveRuntime();
  for (const lang of languages) {
    if (rt.parsers.has(lang)) continue;
    const grammar = GRAMMAR_FOR[lang];
    if (!grammar) continue;
    const language = await rt.treeSitter.Language.load(grammarPath(grammar));
    if (rt.parsers.has(lang)) continue; // another digest loaded it while this one waited
    const parser = new rt.treeSitter.Parser();
    parser.setLanguage(language);
    rt.parsers.set(lang, parser);
  }
}

const QUOTE_CHARS = new Set(["'", '"', '`']);

function unquote(s: string): string {
  let out = s;
  if (out.length > 0 && QUOTE_CHARS.has(out[0]!)) out = out.slice(1);
  if (out.length > 0 && QUOTE_CHARS.has(out[out.length - 1]!)) out = out.slice(0, -1);
  return out;
}

/** tree-sitter rows are 0-indexed; every line we report is 1-indexed. */
function lineOf(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function endLineOf(node: SyntaxNode): number {
  return node.endPosition.row + 1;
}

const QUOTE_RUN = /^("""|'''|"|')|("""|'''|"|')$/g;
const DOC_LEAD = /^\s*(\*|\/\/+|#+)\s?/;
const SECTION_HEAD = /^(@param|@returns?|@throws|@example|Args:|Returns:|Raises:|Yields:|:param|:return)/i;

/** Trim a raw docstring / comment down to its first paragraph of real prose. */
function cleanDoc(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/^(\/\*\*?|\/\/+|#+)/, '').replace(/\*\/$/, '');
  s = s.replace(QUOTE_RUN, '');
  const lines = s.split(/\r?\n/).map((l) => l.replace(DOC_LEAD, '').trim());
  const out: string[] = [];
  for (const l of lines) {
    if (l === '' && out.length) break; // first paragraph only
    if (l === '') continue;
    if (SECTION_HEAD.test(l)) break;
    out.push(l);
  }
  const text = out.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length < 3) return null;
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

/** Python: the first string literal in a definition's body is its docstring. */
function pythonDoc(node: SyntaxNode): string | null {
  const body = node.childForFieldName('body');
  if (!body) return null;
  const first = body.children.find((c) => c && c.type !== 'comment');
  if (!first || first.type !== 'expression_statement') return null;
  const str = first.children.find((c) => c?.type === 'string');
  return str ? cleanDoc(str.text) : null;
}

/** JS/TS: the comment block immediately above the declaration (or above its `export`). */
function jsDoc(node: SyntaxNode): string | null {
  let probe: SyntaxNode = node;
  if (probe.parent && probe.parent.type === 'export_statement') probe = probe.parent;
  let prev = probe.previousSibling;
  while (prev && prev.type !== 'comment' && prev.text.trim() === '') prev = prev.previousSibling;
  if (!prev || prev.type !== 'comment') return null;
  // gather a run of consecutive `//` lines above it
  const parts = [prev.text];
  let up = prev.previousSibling;
  while (up && up.type === 'comment' && up.text.startsWith('//')) {
    parts.unshift(up.text);
    up = up.previousSibling;
  }
  return cleanDoc(parts.join('\n'));
}

function countErrors(node: SyntaxNode): number {
  let n = 0;
  const stack: SyntaxNode[] = [node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.type === 'ERROR' || cur.isMissing) n++;
    if (cur.hasError) for (const c of cur.children) if (c) stack.push(c);
  }
  return n;
}

// ---------------------------------------------------------------- python

function pythonSymbols(root: SyntaxNode): SymbolRecord[] {
  const out: SymbolRecord[] = [];

  const unwrap = (n: SyntaxNode): SyntaxNode =>
    n.type === 'decorated_definition' ? (n.childForFieldName('definition') ?? n) : n;

  const record = (n: SyntaxNode, kind: SymbolKind): void => {
    const nameNode = n.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    out.push({
      name, kind, line: lineOf(n), endLine: endLineOf(n),
      exported: !name.startsWith('_'), doc: pythonDoc(n),
    });
  };

  for (const raw of root.children) {
    if (!raw) continue;
    const node = unwrap(raw);
    if (node.type === 'function_definition') {
      record(node, 'function');
    } else if (node.type === 'class_definition') {
      record(node, 'class');
      const body = node.childForFieldName('body');
      if (body) {
        for (const memberRaw of body.children) {
          if (!memberRaw) continue;
          const member = unwrap(memberRaw);
          if (member.type === 'function_definition') record(member, 'method');
        }
      }
    } else if (node.type === 'expression_statement') {
      // module-level constants: NAME = ...
      const assign = node.children.find((c) => c?.type === 'assignment');
      const target = assign?.childForFieldName('left');
      if (target && target.type === 'identifier' && /^[A-Z][A-Z0-9_]*$/.test(target.text)) {
        out.push({
          name: target.text,
          kind: 'variable',
          line: lineOf(node),
          endLine: endLineOf(node),
          exported: !target.text.startsWith('_'),
          doc: null,
        });
      }
    }
  }
  return out;
}

function pythonImports(root: SyntaxNode): ImportRecord[] {
  const out: ImportRecord[] = [];
  const push = (raw: string, node: SyntaxNode): void => {
    if (raw) out.push({ raw, resolved: null, line: lineOf(node) });
  };

  // T-31: an explicit stack, not recursion — no syntax-tree walk in src/ recurses. Children go
  // on in reverse so they come off in source order: the order the recursive walk reported.
  const stack: Array<{ node: SyntaxNode; depth: number }> = [];
  const pushChildren = (node: SyntaxNode, depth: number): void => {
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push({ node: child, depth });
    }
  };

  pushChildren(root, 0);
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (node.type === 'import_statement') {
      for (const child of node.children) {
        if (!child) continue;
        if (child.type === 'dotted_name') push(child.text, node);
        else if (child.type === 'aliased_import') {
          const inner = child.children.find((c) => c?.type === 'dotted_name');
          if (inner) push(inner.text, node);
        }
      }
      continue;
    }
    if (node.type === 'import_from_statement') {
      const mod =
        node.childForFieldName('module_name') ??
        node.children.find((c) => c?.type === 'relative_import' || c?.type === 'dotted_name');
      if (mod) push(mod.text, node);
      continue;
    }
    // imports hide inside `if TYPE_CHECKING:` and `try:` blocks often enough to be worth descending
    if (depth < 4) pushChildren(node, depth + 1);
  }
  return out;
}

// ------------------------------------------------------ javascript / typescript

const JS_DECL_KIND: Record<string, SymbolKind> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

/** Literals whose body runs when they are called. A generator is not one: calling it only returns an iterator. */
const IIFE_FN_TYPES = new Set(['function_expression', 'arrow_function']);

/**
 * T-16 — the methods that run a function on the spot: `fn.call(...)` and `fn.apply(...)`.
 * `bind` is deliberately not here: `fn.bind(this)` only makes a bound copy, whose body runs
 * when that copy is itself called — `fn.bind(this)()` — and `invokedLiteral` checks for that
 * call separately. `(function(){}).bind(this);` parses exactly like `.call(this);` apart from
 * this property name (write-ahead dump, `.autodev/specs/T-16-module-iifes.md`), so the name is
 * what decides.
 */
const INVOKING_METHODS = new Set(['call', 'apply']);
const BINDING_METHODS = new Set(['bind']);

/** Peel away any number of redundant `( ... )` wrappers around a single inner expression. */
function unwrapParens(node: SyntaxNode): SyntaxNode {
  let n = node;
  while (n.type === 'parenthesized_expression' && n.namedChildCount === 1) n = n.namedChild(0)!;
  return n;
}

/** The function/arrow literal `node` is, behind any parens, or null. */
function functionLiteral(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  const n = unwrapParens(node);
  return IIFE_FN_TYPES.has(n.type) ? n : null;
}

/** For `<literal>.<method>` with `method` in `methods`: the literal. Anything else: null. */
function literalBefore(node: SyntaxNode, methods: Set<string>): SyntaxNode | null {
  if (node.type !== 'member_expression') return null;
  const property = node.childForFieldName('property');
  if (!property || !methods.has(property.text)) return null;
  return functionLiteral(node.childForFieldName('object'));
}

/**
 * T-15, widened by T-16 — the function/arrow literal that `expr` runs on the spot, or null.
 * `expr` must be a call — the call itself, the function being called, or both, may sit
 * inside `( ... )` — optionally behind a single leading unary operator (`!function(){}()` is
 * the documented example; the T-15 locate doc's own rule is "unary-prefixed", not
 * "`!`-prefixed", so this does not special-case the operator). What it calls is one of:
 *
 *   (function () {...})()             the literal itself (T-15)
 *   (function () {...}).call(this)    its .call / .apply, any receiver and arguments (T-16)
 *   (function () {...}).bind(this)()  a bound copy of it, called at once (T-16)
 *
 * Confirmed identical between the javascript, typescript and tsx grammars — write-ahead
 * dumps for T-15 (`.autodev/handoffs/T-15.md`) and T-16. Anything else (a call to a named
 * function, a call whose callee is itself a plain call, `.bind(this)` never called,
 * `.toString()`, a generator) is not an IIFE and returns null.
 */
function invokedLiteral(expr: SyntaxNode): SyntaxNode | null {
  let e = unwrapParens(expr);
  if (e.type === 'unary_expression') {
    const arg = e.childForFieldName('argument');
    if (!arg) return null;
    e = unwrapParens(arg);
  }
  if (e.type !== 'call_expression') return null;
  const fn = e.childForFieldName('function');
  if (!fn) return null;
  const callee = unwrapParens(fn);
  if (IIFE_FN_TYPES.has(callee.type)) return callee;
  const viaMethod = literalBefore(callee, INVOKING_METHODS);
  if (viaMethod) return viaMethod;
  if (callee.type === 'call_expression') {
    const bound = callee.childForFieldName('function');
    if (bound) return literalBefore(unwrapParens(bound), BINDING_METHODS);
  }
  return null;
}

/** A literal's `statement_block` body, or null — an arrow with an expression body declares nothing. */
function blockBody(fn: SyntaxNode | null): SyntaxNode | null {
  const body = fn?.childForFieldName('body');
  return body && body.type === 'statement_block' ? body : null;
}

/**
 * T-15 — a top-level IIFE statement is the one place script-style JS hides real declarations
 * from the top-level walk below: `stmt` must be a top-level `expression_statement` whose
 * expression runs a literal on the spot (`invokedLiteral`). Returns that literal's body — the
 * ONE level `jsSymbols` recurses into, exactly as top-level, never further (a helper nested
 * inside an ordinary, non-IIFE function is not reachable from here at all: its own enclosing
 * node is a plain `function_declaration`, which this is never even called on).
 */
function iifeBody(stmt: SyntaxNode): SyntaxNode | null {
  if (stmt.type !== 'expression_statement') return null;
  const expr = stmt.namedChild(0);
  return expr ? blockBody(invokedLiteral(expr)) : null;
}

/**
 * T-16 — the module pattern, `var app = (function () {...})()`: the IIFE is a declarator's
 * VALUE, so it sits inside a `lexical_declaration`/`variable_declaration` that `iifeBody`
 * never looks into. Returns the body each declarator's value runs, for every declarator whose
 * value is an IIFE (a multi-declarator statement can hold several). The declared name itself
 * is recorded by `recordDecl` exactly as before — a `variable` spanning the whole wrapper —
 * and `src/build/plan.ts` lets that wrapper yield its build step to the code recorded inside
 * it. Called from the top-level loop only, like `iifeBody`, so a wrapper nested inside a
 * recorded body is recorded but never entered: one level, as T-15.
 */
function declaratorIifeBodies(decl: SyntaxNode): SyntaxNode[] {
  if (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration') return [];
  const out: SyntaxNode[] = [];
  for (const declarator of decl.children) {
    if (!declarator || declarator.type !== 'variable_declarator') continue;
    const value = declarator.childForFieldName('value');
    const body = value ? blockBody(invokedLiteral(value)) : null;
    if (body) out.push(body);
  }
  return out;
}

function jsSymbols(root: SyntaxNode): SymbolRecord[] {
  const out: SymbolRecord[] = [];

  const recordDecl = (node: SyntaxNode, exported: boolean): void => {
    const kind = JS_DECL_KIND[node.type];
    if (kind) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        out.push({
          name: nameNode.text, kind, line: lineOf(node), endLine: endLineOf(node),
          exported, doc: jsDoc(node),
        });
      }
      if (kind === 'class') {
        const body = node.childForFieldName('body');
        if (body) {
          for (const member of body.children) {
            if (!member || member.type !== 'method_definition') continue;
            const mName = member.childForFieldName('name');
            if (!mName) continue;
            const isPrivate = mName.text.startsWith('#') || mName.text.startsWith('_');
            out.push({
              name: mName.text,
              kind: 'method',
              line: lineOf(member),
              endLine: endLineOf(member),
              exported: exported && !isPrivate,
              doc: jsDoc(member),
            });
          }
        }
      }
      return;
    }

    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      for (const declarator of node.children) {
        if (!declarator || declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        if (!nameNode || nameNode.type !== 'identifier') continue;
        const value = declarator.childForFieldName('value');
        const isFn =
          value != null &&
          (value.type === 'arrow_function' ||
            value.type === 'function_expression' ||
            value.type === 'function');
        out.push({
          name: nameNode.text,
          kind: isFn ? 'function' : 'variable',
          line: lineOf(node),
          endLine: endLineOf(node),
          exported,
          doc: jsDoc(node),
        });
      }
    }
  };

  // Exactly the top-level treatment, one level down: an IIFE's own direct declarations are
  // never exported (there is no `export` inside a function body), and we stop there — a
  // nested IIFE, or a plain function, inside the body is not recursed into again (T-15 AC1,
  // T-16 AC4: recurse one level only).
  const recordBody = (body: SyntaxNode): void => {
    for (const inner of body.children) if (inner) recordDecl(inner, false);
  };

  for (const node of root.children) {
    if (!node) continue;
    if (node.type === 'export_statement') {
      const decl = node.childForFieldName('declaration');
      if (decl) {
        recordDecl(decl, true);
        for (const body of declaratorIifeBodies(decl)) recordBody(body);
      }
      continue;
    }
    const body = iifeBody(node);
    if (body) {
      recordBody(body);
      continue;
    }
    recordDecl(node, false);
    for (const inner of declaratorIifeBodies(node)) recordBody(inner);
  }
  return out;
}

/** The module an import, an `export ... from`, a `require(...)` or an `import(...)` names, or null. */
function jsImportAt(node: SyntaxNode): ImportRecord | null {
  if (node.type === 'import_statement' || node.type === 'export_statement') {
    const source = node.childForFieldName('source');
    return source ? { raw: unquote(source.text), resolved: null, line: lineOf(node) } : null;
  }
  // call_expression
  const fn = node.childForFieldName('function');
  const args = node.childForFieldName('arguments');
  const isRequire = fn?.text === 'require';
  const isDynamic = fn?.type === 'import';
  if (!(isRequire || isDynamic) || !args) return null;
  const str = args.children.find((c) => c?.type === 'string');
  return str ? { raw: unquote(str.text), resolved: null, line: lineOf(node) } : null;
}

/**
 * Every import in the file, in source order.
 *
 * T-31: a cursor, not recursion. A string concatenation or a method chain nests to the left,
 * so its tree is as deep as it is long, and the recursive walk this replaces overflowed the
 * stack at about 5,000 terms of generated code — taking the whole digest down with it. The
 * cursor visits the same nodes in the same order (pre-order, children left to right) at any
 * depth, and only builds a node object where an import can be.
 */
function jsImports(root: SyntaxNode): ImportRecord[] {
  const out: ImportRecord[] = [];
  const cursor = root.walk();
  try {
    for (;;) {
      const type = cursor.nodeType;
      if (type === 'import_statement' || type === 'export_statement' || type === 'call_expression') {
        const found = jsImportAt(cursor.currentNode);
        if (found) out.push(found);
      }
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return out;
      }
    }
  } finally {
    cursor.delete();
  }
}

// ---------------------------------------------------------------- resolution

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/**
 * Resolve an import to a real file in the tree, or null when it leaves the tree.
 * `index` holds every scan-root-relative path the inventory recorded.
 */
function resolveImport(
  raw: string,
  fromPath: string,
  language: string,
  repoRoot: string,
  index: Set<string>,
): string | null {
  const fromDir = path.posix.dirname(fromPath);

  const tryPaths = (candidates: string[]): string | null => {
    for (const c of candidates) {
      const norm = path.posix.normalize(c);
      if (index.has(norm)) return norm;
    }
    return null;
  };

  if (language === 'python') {
    const dots = /^\.+/.exec(raw)?.[0]?.length ?? 0;
    const bare = raw.slice(dots).replace(/\./g, '/');
    const bases: string[] = [];
    if (dots > 0) {
      // one dot = this package; each extra dot climbs one level
      let dir = fromDir;
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      bases.push(bare ? path.posix.join(dir, bare) : dir);
    } else {
      bases.push(path.posix.join(repoRoot, bare));
      bases.push(path.posix.join(repoRoot, 'src', bare));
      bases.push(bare);
    }
    const candidates: string[] = [];
    for (const b of bases) candidates.push(`${b}.py`, `${b}/__init__.py`, `${b}.pyi`);
    return tryPaths(candidates);
  }

  // javascript / typescript / tsx
  if (!raw.startsWith('.')) return null; // bare specifier — a package, outside the tree
  const base = path.posix.join(fromDir, raw);
  const candidates: string[] = [base];
  for (const ext of JS_EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of JS_EXTENSIONS) candidates.push(`${base}/index${ext}`);
  // `./x.js` in an ESM TypeScript project means `./x.ts` on disk
  const swapped = base.replace(/\.(js|mjs|cjs)$/, '');
  if (swapped !== base) for (const ext of JS_EXTENSIONS) candidates.push(`${swapped}${ext}`);
  return tryPaths(candidates);
}

// ---------------------------------------------------------------- driver

export interface ExtractResult {
  extracts: FileExtract[];
  graph: ImportGraph;
  /** T-31: the files that could not be read, parsed or walked, each with why. They have no extract. */
  unparsed: UnparsedFile[];
}

/**
 * T-31 — content that made a parser runtime trap, keyed `language:sha256`, with the reason: it
 * is never parsed again in this process. A file too big for the parser takes seconds to fail and
 * 2 GiB while it does, and a server rebuilds the same repository every time it changes.
 */
const fatalContent = new Map<string, string>();

const contentKey = (language: string, text: string): string =>
  `${language}:${createHash('sha256').update(text).digest('hex')}`;

/** What `Aborted()` means here: allocation failure is where the parser's wasm build aborts. */
const OUT_OF_MEMORY = 'the parser ran out of memory on it (its limit is 2 GiB)';

/** Why a file could not be extracted, in one line: the error's own words, or what an abort means. */
function why(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'RuntimeError' && err.message.startsWith('Aborted(')) return OUT_OF_MEMORY;
  const line = `${err.name}: ${err.message.split('\n')[0] ?? ''}`;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Parse every parseable, non-floored file and build the intra-repo import graph.
 *
 * T-31: one file can never stop this. A file that cannot be read, that the parser gives no tree
 * for, or whose tree cannot be walked is recorded in `unparsed` with why, gets no extract, and
 * every other file is extracted exactly as it would be without it.
 */
export async function extract(root: string, files: FileRecord[]): Promise<ExtractResult> {
  const targets = files.filter(
    (f) =>
      !f.binary &&
      f.language !== null &&
      GRAMMAR_FOR[f.language] !== undefined &&
      f.classification !== 'vendored' &&
      f.classification !== 'generated',
  );
  await initParsers([...new Set(targets.map((f) => f.language!))]);

  const index = new Set(files.map((f) => f.path));
  const repoOf = new Map(files.map((f) => [f.path, f.repo] as const));
  const extracts: FileExtract[] = [];
  const unparsed: UnparsedFile[] = [];
  let filesWithParseErrors = 0;

  for (const file of targets) {
    const language = file.language!;
    const skip = (reason: string): void => { unparsed.push({ path: file.path, reason }); };

    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file.path), 'utf8');
    } catch (err) {
      skip(`could not be read: ${(err as NodeJS.ErrnoException).code ?? why(err)}`);
      continue;
    }

    const fatal = fatalContent.size > 0 ? fatalContent.get(contentKey(language, text)) : undefined;
    if (fatal) {
      skip(fatal);
      continue;
    }

    // Normally ready at once. After a runtime has been let go of, the next file loads a fresh
    // one. The parser is read AFTER the last await, so from here to the end of this file nothing
    // awaits, and no other digest can let go of the runtime this file is parsed on.
    let ready = readyParser(language);
    try {
      for (let tries = 0; !ready && tries < 3; tries++) {
        await initParsers([language]);
        ready = readyParser(language);
      }
    } catch (err) {
      skip(`the parser could not be started: ${why(err)}`);
      continue;
    }
    if (!ready) {
      skip('the parser could not be started');
      continue;
    }

    let tree: Tree | null = null;
    try {
      tree = ready.parser.parse(text);
      if (!tree) {
        skip('the parser returned no tree');
        continue;
      }
      const rootNode = tree.rootNode;
      const parseErrors = rootNode.hasError ? countErrors(rootNode) : 0;

      const isPython = language === 'python';
      const symbols = isPython ? pythonSymbols(rootNode) : jsSymbols(rootNode);
      const imports = isPython ? pythonImports(rootNode) : jsImports(rootNode);

      const repoRoot = repoOf.get(file.path) ?? '';
      for (const imp of imports) {
        imp.resolved = resolveImport(imp.raw, file.path, language, repoRoot, index);
      }

      if (parseErrors > 0) filesWithParseErrors++;
      extracts.push({ path: file.path, language, symbols, imports, parseErrors });
    } catch (err) {
      const reason = why(err);
      skip(reason);
      if (err instanceof Error && err.name === 'RuntimeError') {
        // A wasm trap: this copy of the parser cannot be trusted again, and after an abort it
        // holds its whole heap. Let go of it, and never parse this content again.
        fatalContent.set(contentKey(language, text), reason);
        release(ready.rt);
      }
    } finally {
      // A runtime that has been let go of can free nothing, and needs to free nothing.
      if (tree && runtime === ready.rt) tree.delete();
    }
  }

  const edges: Array<{ from: string; to: string }> = [];
  const inDegree: Record<string, number> = {};
  for (const f of files) inDegree[f.path] = 0;

  let totalImports = 0;
  let resolvedInternal = 0;
  const seen = new Set<string>();
  for (const ex of extracts) {
    for (const imp of ex.imports) {
      totalImports++;
      if (!imp.resolved || imp.resolved === ex.path) continue;
      resolvedInternal++;
      const key = `${ex.path} ${imp.resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: ex.path, to: imp.resolved });
      inDegree[imp.resolved] = (inDegree[imp.resolved] ?? 0) + 1;
    }
  }

  return {
    extracts,
    graph: {
      nodes: extracts.map((e) => e.path),
      edges,
      inDegree,
      coverage: {
        totalImports,
        resolvedInternal,
        leftTheTree: totalImports - resolvedInternal,
        filesParsed: extracts.length,
        filesWithParseErrors,
      },
    },
    unparsed,
  };
}
