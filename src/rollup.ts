/**
 * Stage 5 — Roll up. Bottom-up, hash-keyed, resumable.
 *
 *     files ──▶ directories ──▶ subsystems ──▶ repo
 *
 * Each tier is written from the tier BELOW, never from source. Three things fall out of
 * that one rule, and they are the reason the rule is absolute:
 *
 *   1. No single step ever needs the whole repo in context — the answer to "too big".
 *   2. A tour can enter at any altitude: repo, subsystem, or file.
 *   3. Invalidation is free: a tier is stale iff one of its children is, which is exactly
 *      what hashing a tier from its children's hashes gives you.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FileExtract, FileRecord, RankedFile } from './types.js';

export type TierKind = 'repo' | 'subsystem' | 'directory';

export interface TierDigest {
  /** posix path of the directory this tier covers; '' is the scan root */
  path: string;
  kind: TierKind;
  repo: string;
  /** immediate children: tier paths and file paths, sorted */
  childTiers: string[];
  childFiles: string[];
  /** recursive totals */
  fileCount: number;
  loc: number;
  /** the best-scoring descendants, so a tour knows where to go next */
  topFiles: Array<{ path: string; score: number; why: string }>;
  score: number;
  languages: Record<string, number>;
  classifications: Record<string, number>;
  publicSymbols: number;
  /**
   * sha256 over this tier's children's hashes. A tier is stale iff a child is —
   * no separate invalidation bookkeeping exists, or is needed.
   */
  hash: string;
  /** proof, carried in the data, that no tier was ever handed raw source */
  sourcedFrom: 'children';
}

/** A directory directly inside a repo root is that repo's subsystem. */
function kindFor(dirPath: string, repoRoot: string, isRepoRoot: boolean): TierKind {
  if (isRepoRoot) return 'repo';
  const rel = repoRoot === '' ? dirPath : dirPath.slice(repoRoot.length + 1);
  return rel.includes('/') ? 'directory' : 'subsystem';
}

function why(r: RankedFile): string {
  const parts: string[] = [];
  if (r.churn > 0) parts.push(`${r.churn} commits`);
  if (r.inDegree > 0) parts.push(`${r.inDegree} importers`);
  if (r.loc >= 0) parts.push(`${r.loc} loc`);
  parts.push(r.classification);
  return parts.join(' · ');
}

export interface RollupResult {
  tiers: TierDigest[];
  byPath: Map<string, TierDigest>;
}

export function rollup(
  files: FileRecord[],
  ranked: RankedFile[],
  extracts: FileExtract[],
  repoRoots: string[],
): RollupResult {
  const rankByPath = new Map(ranked.map((r) => [r.path, r] as const));
  const publicByPath = new Map(
    extracts.map((e) => [e.path, e.symbols.filter((s) => s.exported).length] as const),
  );
  const repoSet = new Set(repoRoots);

  // Every directory that exists, including ancestors with no direct files.
  const dirs = new Set<string>(repoRoots);
  const filesByDir = new Map<string, FileRecord[]>();
  for (const f of files) {
    const dir = path.posix.dirname(f.path);
    const d = dir === '.' ? '' : dir;
    if (!filesByDir.has(d)) filesByDir.set(d, []);
    filesByDir.get(d)!.push(f);
    let cur = d;
    for (;;) {
      dirs.add(cur);
      if (cur === '') break;
      const parent = path.posix.dirname(cur);
      cur = parent === '.' ? '' : parent;
    }
  }

  const childDirs = new Map<string, string[]>();
  for (const d of dirs) {
    if (d === '') continue;
    const parent = path.posix.dirname(d);
    const p = parent === '.' ? '' : parent;
    if (!childDirs.has(p)) childDirs.set(p, []);
    childDirs.get(p)!.push(d);
  }

  // Deepest first: a tier is only ever built after every child it reads is finished.
  const ordered = [...dirs].sort((a, b) => {
    const da = a === '' ? 0 : a.split('/').length;
    const db = b === '' ? 0 : b.split('/').length;
    return db - da || (a < b ? -1 : 1);
  });

  const byPath = new Map<string, TierDigest>();

  /** the repo a directory belongs to: the longest repo root that is a prefix of it */
  const repoFor = (dir: string): string => {
    let best = '';
    for (const r of repoRoots) {
      if (r === '') continue;
      if (dir === r || dir.startsWith(`${r}/`)) {
        if (r.length > best.length) best = r;
      }
    }
    return best;
  };

  for (const dir of ordered) {
    const ownFiles = (filesByDir.get(dir) ?? []).slice().sort((a, b) => (a.path < b.path ? -1 : 1));
    const kids = (childDirs.get(dir) ?? [])
      .map((c) => byPath.get(c))
      .filter((t): t is TierDigest => t !== undefined)
      .sort((a, b) => (a.path < b.path ? -1 : 1));

    let fileCount = 0;
    let loc = 0;
    let publicSymbols = 0;
    let score = 0;
    const languages: Record<string, number> = {};
    const classifications: Record<string, number> = {};
    const candidates: Array<{ path: string; score: number; why: string }> = [];

    // --- from the tier below: child directories, already complete
    for (const kid of kids) {
      fileCount += kid.fileCount;
      loc += kid.loc;
      publicSymbols += kid.publicSymbols;
      if (kid.score > score) score = kid.score;
      for (const [k, v] of Object.entries(kid.languages)) languages[k] = (languages[k] ?? 0) + v;
      for (const [k, v] of Object.entries(kid.classifications)) classifications[k] = (classifications[k] ?? 0) + v;
      candidates.push(...kid.topFiles);
    }

    // --- from the tier below: this directory's own files
    for (const f of ownFiles) {
      fileCount += 1;
      if (f.loc > 0) loc += f.loc;
      publicSymbols += publicByPath.get(f.path) ?? 0;
      if (f.language) languages[f.language] = (languages[f.language] ?? 0) + 1;
      classifications[f.classification] = (classifications[f.classification] ?? 0) + 1;
      const r = rankByPath.get(f.path);
      if (r) {
        if (r.score > score) score = r.score;
        candidates.push({ path: r.path, score: r.score, why: why(r) });
      }
    }

    candidates.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));

    // The tier's hash is built ONLY from its children's hashes and its files' content
    // hashes — never from file contents read here. That is what makes it resumable.
    const h = createHash('sha256');
    for (const kid of kids) h.update(`${kid.path}:${kid.hash}\n`);
    for (const f of ownFiles) h.update(`${f.path}:${f.sha256}\n`);

    const repo = repoFor(dir);
    byPath.set(dir, {
      path: dir,
      kind: kindFor(dir, repo, repoSet.has(dir)),
      repo,
      childTiers: kids.map((k) => k.path),
      childFiles: ownFiles.map((f) => f.path),
      fileCount,
      loc,
      topFiles: candidates.slice(0, 10),
      score,
      languages,
      classifications,
      publicSymbols,
      hash: h.digest('hex'),
      sourcedFrom: 'children',
    });
  }

  const tiers = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  return { tiers, byPath };
}
