/**
 * Criterion 6 — incremental re-digest. Cost proportional to the diff, not the repo.
 *
 * File digests are keyed by CONTENT hash, not path, so the four outcomes in spec §5 fall
 * out of comparing two inventories:
 *
 *   | change                 | action                              |
 *   | unchanged              | reuse — hash matches, free          |
 *   | modified               | re-run stages 1-4 for that file     |
 *   | renamed, same content  | carry the digest across             |
 *   | deleted                | drop, invalidate ancestors          |
 *
 * Hash comparison rather than `git diff` is deliberate: it is the same answer, it works on
 * a dirty working tree and on a tree with no commits, and it cannot disagree with the
 * cache key the digests are actually stored under.
 */

import path from 'node:path';
import type { FileRecord } from './types.js';
import type { TierDigest } from './rollup.js';

export interface PriorFile {
  path: string;
  sha256: string;
}

export interface IncrementalPlan {
  /** same path, same content — the digest on disk is reused as-is */
  reuse: string[];
  /** same path, new content — stages 1-4 re-run for this file */
  recompute: string[];
  /** new path, content we have already digested — the digest is carried across, free */
  carried: Array<{ from: string; to: string; sha256: string }>;
  /** new path, content never seen */
  added: string[];
  /** gone, and its content is not present anywhere else */
  deleted: string[];
  /** every tier that must be rebuilt because a descendant moved */
  invalidatedTiers: string[];
  counts: {
    total: number;
    reused: number;
    recomputed: number;
    carried: number;
    added: number;
    deleted: number;
    /** the headline: what fraction of the tree cost nothing this run */
    reusePercent: number;
  };
}

function ancestorsOf(filePath: string): string[] {
  const out: string[] = [];
  let cur = path.posix.dirname(filePath);
  if (cur === '.') cur = '';
  for (;;) {
    out.push(cur);
    if (cur === '') break;
    const parent = path.posix.dirname(cur);
    cur = parent === '.' ? '' : parent;
  }
  return out;
}

/**
 * Compare a stored inventory against a fresh one and say what actually has to be done.
 *
 * `priorTiers` is optional; when given, the plan names exactly which tiers are stale.
 * A tier is stale iff a descendant changed — the same rule the rollup hashes encode.
 */
export function planIncremental(
  prior: PriorFile[],
  current: FileRecord[],
  priorTiers: TierDigest[] = [],
): IncrementalPlan {
  const priorByPath = new Map(prior.map((f) => [f.path, f.sha256] as const));
  const currentByPath = new Map(current.map((f) => [f.path, f.sha256] as const));

  // Content we have already digested, whatever path it lived at.
  const priorPathsByHash = new Map<string, string[]>();
  for (const f of prior) {
    if (!priorPathsByHash.has(f.sha256)) priorPathsByHash.set(f.sha256, []);
    priorPathsByHash.get(f.sha256)!.push(f.path);
  }

  const reuse: string[] = [];
  const recompute: string[] = [];
  const carried: Array<{ from: string; to: string; sha256: string }> = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const touched = new Set<string>();

  for (const f of current) {
    const priorSha = priorByPath.get(f.path);

    if (priorSha === f.sha256) {
      reuse.push(f.path);
      continue;
    }

    if (priorSha !== undefined) {
      recompute.push(f.path);
      touched.add(f.path);
      continue;
    }

    // New path. Have we digested this exact content before, somewhere else?
    const previousHomes = (priorPathsByHash.get(f.sha256) ?? []).filter((p) => !currentByPath.has(p));
    const from = previousHomes.sort()[0];
    if (from !== undefined) {
      carried.push({ from, to: f.path, sha256: f.sha256 });
      touched.add(f.path);
      touched.add(from);
      continue;
    }

    added.push(f.path);
    touched.add(f.path);
  }

  for (const f of prior) {
    if (currentByPath.has(f.path)) continue;
    // A path that vanished but whose content reappeared elsewhere is a rename, already recorded.
    if (carried.some((c) => c.from === f.path)) continue;
    deleted.push(f.path);
    touched.add(f.path);
  }

  const stale = new Set<string>();
  for (const p of touched) for (const a of ancestorsOf(p)) stale.add(a);

  const knownTiers = new Set(priorTiers.map((t) => t.path));
  const invalidatedTiers = [...stale]
    .filter((t) => knownTiers.size === 0 || knownTiers.has(t))
    .sort();

  const total = current.length;
  return {
    reuse,
    recompute,
    carried,
    added,
    deleted,
    invalidatedTiers,
    counts: {
      total,
      reused: reuse.length,
      recomputed: recompute.length,
      carried: carried.length,
      added: added.length,
      deleted: deleted.length,
      reusePercent: total === 0 ? 0 : Math.round((reuse.length / total) * 100),
    },
  };
}
