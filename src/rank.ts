/**
 * Stage 2 — Rank. Free, and the stage most likely to be quietly wrong.
 *
 * Three signals, and the ORDER of their weights is the whole point. A trial scan of
 * GUTS on 2026-08-25 found its five largest files were all benchmark exhaust — the
 * biggest 38,367 lines, one commit, zero importers — while its highest-value file was
 * `manifest.yaml` at 96 lines with 134 commits. Ranked by length those two sit ~4,000
 * places apart with the exhaust on top. Length is real signal; it just has to be third.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Classification, FileRecord, ImportGraph, RankedFile, RepoRef } from './types.js';

export const WEIGHTS = { churn: 0.45, inDegree: 0.35, size: 0.2 } as const;

/**
 * Classification multipliers. Generated, vendored and lockfile content is floored to
 * zero — acceptance criterion 2 — so it can never enter the paid stage.
 */
export const MULTIPLIER: Record<Classification, number> = {
  structural: 1.4,
  source: 1.0,
  test: 0.05,
  data: 0.3,
  generated: 0,
  vendored: 0,
  lockfile: 0,
};

/**
 * Churn per file, counted in that file's OWN repository.
 *
 * A nested repo has its own history that the parent's git cannot see, so this runs once
 * per repo root and maps each result back to a scan-root-relative path.
 */
export function churnByFile(root: string, repos: RepoRef[]): Map<string, number> {
  const churn = new Map<string, number>();

  for (const repo of repos) {
    let out: string;
    try {
      out = execFileSync('git', ['-C', repo.absRoot, 'log', '--format=', '--name-only'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 512 * 1024 * 1024,
      });
    } catch {
      continue; // a repo with no commits yet — every file scores 0 churn, which is true
    }

    const prefix = repo.root === '' ? '' : `${repo.root}/`;
    for (const line of out.split('\n')) {
      const rel = line.trim();
      if (!rel) continue;
      const scanPath = path.posix.normalize(prefix + rel);
      churn.set(scanPath, (churn.get(scanPath) ?? 0) + 1);
    }
  }

  return churn;
}

/**
 * Log-scale then divide by the max.
 *
 * Plain max-normalization lets a single 38k-line outlier squash every real file to
 * near zero. log1p keeps the ordering while compressing the tail.
 */
function normalizer(values: number[]): (v: number) => number {
  let max = 0;
  for (const v of values) {
    const scaled = Math.log1p(Math.max(0, v));
    if (scaled > max) max = scaled;
  }
  if (max === 0) return () => 0;
  return (v: number) => Math.log1p(Math.max(0, v)) / max;
}

export interface RankOptions {
  /** default deep-slice cut: top 15% or score >= 0.30, whichever is larger (spec §4) */
  slicePercent?: number;
  sliceThreshold?: number;
}

export interface RankResult {
  ranked: RankedFile[];
  /** the files stage 4 would deep-interpret, by the spec's default cut */
  deepSlice: string[];
  /** files eligible for the cheap sweep — everything not floored to zero */
  sweepCount: number;
}

export function rank(
  root: string,
  files: FileRecord[],
  repos: RepoRef[],
  graph: ImportGraph,
  opts: RankOptions = {},
): RankResult {
  const churn = churnByFile(root, repos);

  const churnValues = files.map((f) => churn.get(f.path) ?? 0);
  const degreeValues = files.map((f) => graph.inDegree[f.path] ?? 0);
  const sizeValues = files.map((f) => (f.loc < 0 ? 0 : f.loc));

  const normChurn = normalizer(churnValues);
  const normDegree = normalizer(degreeValues);
  const normSize = normalizer(sizeValues);

  const ranked: RankedFile[] = files.map((f) => {
    const rawChurn = churn.get(f.path) ?? 0;
    const rawDegree = graph.inDegree[f.path] ?? 0;
    const rawSize = f.loc < 0 ? 0 : f.loc;

    const c = normChurn(rawChurn);
    const d = normDegree(rawDegree);
    const s = normSize(rawSize);
    const multiplier = MULTIPLIER[f.classification];

    const base = WEIGHTS.churn * c + WEIGHTS.inDegree * d + WEIGHTS.size * s;
    const score = Math.min(1, base * multiplier);

    return {
      path: f.path,
      score,
      classification: f.classification,
      churn: rawChurn,
      inDegree: rawDegree,
      loc: f.loc,
      components: { churn: c, inDegree: d, size: s, multiplier },
    };
  });

  ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));

  const slicePercent = opts.slicePercent ?? 0.15;
  const sliceThreshold = opts.sliceThreshold ?? 0.3;
  const scored = ranked.filter((r) => r.score > 0);
  const byPercent = Math.ceil(scored.length * slicePercent);
  const byThreshold = scored.filter((r) => r.score >= sliceThreshold).length;
  const cut = Math.max(byPercent, byThreshold);

  return {
    ranked,
    deepSlice: scored.slice(0, cut).map((r) => r.path),
    sweepCount: scored.length,
  };
}
