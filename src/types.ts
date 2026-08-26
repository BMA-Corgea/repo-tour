/**
 * Shared shapes for the digest pipeline.
 *
 * Stages 1-3 are deterministic and produce everything here. Stage 4 (interpret)
 * is the only stage that spends tokens, and it consumes these — it is never
 * asked what is *in* a file, only what it means.
 */

export type Classification =
  | 'source'
  | 'test'
  | 'structural'
  | 'generated'
  | 'vendored'
  | 'data'
  | 'lockfile';

/** A repository root. Every nested `.git` is one of these — the parent's git sees none of it. */
export interface RepoRef {
  /** posix path of the repo root relative to the scan root; '' is the scan root itself */
  root: string;
  absRoot: string;
  head: string | null;
  branch: string | null;
  commitCount: number;
  /** true when `.git` is a file (worktree / submodule pointer) rather than a directory */
  pointer: boolean;
}

export interface FileRecord {
  /** posix path relative to the scan root */
  path: string;
  /** the `root` of the RepoRef this file belongs to (nearest enclosing repo) */
  repo: string;
  bytes: number;
  loc: number;
  language: string | null;
  sha256: string;
  classification: Classification;
  /** the deterministic signals that produced the classification, in the order they fired */
  signals: string[];
  binary: boolean;
}

export interface Inventory {
  root: string;
  repos: RepoRef[];
  files: FileRecord[];
  skipped: Array<{ path: string; reason: string }>;
  stats: {
    dirsWalked: number;
    filesSeen: number;
    filesRecorded: number;
    bytesRead: number;
    wallMs: number;
  };
}

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable';

export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  /** 1-indexed, inclusive */
  line: number;
  endLine: number;
  /** part of the module's public surface (explicit `export`, or non-underscore at Python top level) */
  exported: boolean;
  /**
   * The author's own explanation, if they left one: a Python docstring, or the comment
   * block immediately above a JS/TS declaration. This is the only source of "why" that
   * costs no tokens, so it is read wherever it exists.
   */
  doc: string | null;
}

export interface ImportRecord {
  /** the module specifier exactly as written */
  raw: string;
  /** posix path relative to the scan root, or null when it leaves the tree */
  resolved: string | null;
  line: number;
}

export interface FileExtract {
  path: string;
  language: string;
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  /** tree-sitter ERROR nodes — a file that parsed badly should not be trusted downstream */
  parseErrors: number;
}

export interface ImportGraph {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
  inDegree: Record<string, number>;
  /**
   * The graph states its own coverage. A service-shaped repo whose organs talk over
   * HTTP produces almost no edges, and v1 must not present that as a complete picture.
   */
  coverage: {
    totalImports: number;
    resolvedInternal: number;
    leftTheTree: number;
    filesParsed: number;
    filesWithParseErrors: number;
  };
}

export interface RankedFile {
  path: string;
  score: number;
  classification: Classification;
  churn: number;
  inDegree: number;
  loc: number;
  /** each normalized signal and the classification multiplier, so a score can be argued with */
  components: {
    churn: number;
    inDegree: number;
    size: number;
    multiplier: number;
  };
}
