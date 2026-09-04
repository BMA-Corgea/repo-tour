/**
 * Stage 3 — Extract. Parsers, never models.
 *
 * A parser cannot invent a function that does not exist. Everything here is a fact
 * read off a syntax tree; nothing is inferred, guessed, or summarized. Stage 4 is
 * handed this skeleton and asked only what it *means*.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type {
  FileExtract, FileRecord, ImportGraph, ImportRecord, SymbolKind, SymbolRecord,
} from './types.js';
import { grammarsDir } from './assets.js';

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

const parsers = new Map<string, Parser>();
let initialized = false;

export async function initParsers(languages: string[] = Object.keys(GRAMMAR_FOR)): Promise<void> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  for (const lang of languages) {
    if (parsers.has(lang)) continue;
    const grammar = GRAMMAR_FOR[lang];
    if (!grammar) continue;
    const language = await Language.load(grammarPath(grammar));
    const parser = new Parser();
    parser.setLanguage(language);
    parsers.set(lang, parser);
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
      const mod =
        node.childForFieldName('module_name') ??
        node.children.find((c) => c?.type === 'relative_import' || c?.type === 'dotted_name');
      if (mod) push(mod.text, node);
      return;
    }
    // imports hide inside `if TYPE_CHECKING:` and `try:` blocks often enough to be worth descending
    if (depth < 4) for (const child of node.children) if (child) visit(child, depth + 1);
  };

  for (const child of root.children) if (child) visit(child, 0);
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

  for (const node of root.children) {
    if (!node) continue;
    if (node.type === 'export_statement') {
      const decl = node.childForFieldName('declaration');
      if (decl) recordDecl(decl, true);
      continue;
    }
    recordDecl(node, false);
  }
  return out;
}

function jsImports(root: SyntaxNode): ImportRecord[] {
  const out: ImportRecord[] = [];

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'import_statement' || node.type === 'export_statement') {
      const source = node.childForFieldName('source');
      if (source) out.push({ raw: unquote(source.text), resolved: null, line: lineOf(node) });
    } else if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      const args = node.childForFieldName('arguments');
      const isRequire = fn?.text === 'require';
      const isDynamic = fn?.type === 'import';
      if ((isRequire || isDynamic) && args) {
        const str = args.children.find((c) => c?.type === 'string');
        if (str) out.push({ raw: unquote(str.text), resolved: null, line: lineOf(node) });
      }
    }
    for (const child of node.children) if (child) visit(child);
  };

  visit(root);
  return out;
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
}

/** Parse every parseable, non-floored file and build the intra-repo import graph. */
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
  let filesWithParseErrors = 0;

  for (const file of targets) {
    const parser = parsers.get(file.language!);
    if (!parser) continue;

    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file.path), 'utf8');
    } catch {
      continue;
    }

    const tree = parser.parse(text);
    if (!tree) continue;
    const rootNode = tree.rootNode;
    const parseErrors = rootNode.hasError ? countErrors(rootNode) : 0;
    if (parseErrors > 0) filesWithParseErrors++;

    const isPython = file.language === 'python';
    const symbols = isPython ? pythonSymbols(rootNode) : jsSymbols(rootNode);
    const imports = isPython ? pythonImports(rootNode) : jsImports(rootNode);

    const repoRoot = repoOf.get(file.path) ?? '';
    for (const imp of imports) {
      imp.resolved = resolveImport(imp.raw, file.path, file.language!, repoRoot, index);
    }

    extracts.push({ path: file.path, language: file.language!, symbols, imports, parseErrors });
    tree.delete();
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
  };
}
