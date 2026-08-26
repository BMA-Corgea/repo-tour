/**
 * The digest driver — stages 1 through 3.
 *
 * Stage 4 (interpret) and stage 5 (roll up) are not built yet. This deliberately runs
 * the free, exact stages to completion first so their output can be judged before a
 * single token is spent: ordering IS the cost-control mechanism (spec §3).
 */

import fs from 'node:fs';
import path from 'node:path';
import { inventory, type InventoryOptions } from './inventory.js';
import { extract } from './extract.js';
import { rank, type RankOptions } from './rank.js';
import type { FileExtract, FileRecord, ImportGraph, Inventory, RankedFile, RepoRef } from './types.js';

export const SCHEMA_VERSION = 1;
export const CACHE_DIR = '.repo-tour';

export interface DigestManifest {
  schemaVersion: number;
  root: string;
  generatedAt: string;
  repos: RepoRef[];
  stagesRun: string[];
  stagesNotBuilt: string[];
  counts: {
    files: number;
    byClassification: Record<string, number>;
    parsed: number;
    symbols: number;
    edges: number;
    deepSlice: number;
    sweepEligible: number;
  };
  /**
   * Criterion 7: a run that spends tokens silently fails. Stages 1-3 spend none, and
   * this says so explicitly rather than omitting the field.
   */
  cost: {
    wallMs: number;
    inventoryMs: number;
    extractMs: number;
    rankMs: number;
    filesScanned: number;
    filesInterpreted: number;
    tokens: { fast: number; strong: number };
  };
  /** Criterion 10 in spirit: the graph states its own coverage rather than implying completeness. */
  graphCoverage: ImportGraph['coverage'] & { note: string };
  skipped: Array<{ path: string; reason: string }>;
}

export interface DigestResult {
  manifest: DigestManifest;
  inventory: Inventory;
  extracts: FileExtract[];
  graph: ImportGraph;
  ranked: RankedFile[];
  deepSlice: string[];
}

export interface DigestOptions extends InventoryOptions, RankOptions {
  /** write the on-disk cache; false keeps the run purely in memory (used by tests) */
  write?: boolean;
  outDir?: string;
}

function tally(files: FileRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) out[f.classification] = (out[f.classification] ?? 0) + 1;
  return out;
}

export async function digest(rootInput: string, opts: DigestOptions = {}): Promise<DigestResult> {
  const started = Date.now();
  const root = path.resolve(rootInput);

  const t0 = Date.now();
  const inv = inventory(root, opts);
  const inventoryMs = Date.now() - t0;

  const t1 = Date.now();
  const { extracts, graph } = await extract(root, inv.files);
  const extractMs = Date.now() - t1;

  const t2 = Date.now();
  const { ranked, deepSlice, sweepCount } = rank(root, inv.files, inv.repos, graph, opts);
  const rankMs = Date.now() - t2;

  const symbolCount = extracts.reduce((n, e) => n + e.symbols.length, 0);

  const manifest: DigestManifest = {
    schemaVersion: SCHEMA_VERSION,
    root,
    generatedAt: new Date().toISOString(),
    repos: inv.repos,
    stagesRun: ['1-inventory', '2-rank', '3-extract'],
    stagesNotBuilt: ['4-interpret', '5-rollup'],
    counts: {
      files: inv.files.length,
      byClassification: tally(inv.files),
      parsed: extracts.length,
      symbols: symbolCount,
      edges: graph.edges.length,
      deepSlice: deepSlice.length,
      sweepEligible: sweepCount,
    },
    cost: {
      wallMs: Date.now() - started,
      inventoryMs,
      extractMs,
      rankMs,
      filesScanned: inv.files.length,
      filesInterpreted: 0,
      tokens: { fast: 0, strong: 0 },
    },
    graphCoverage: {
      ...graph.coverage,
      note:
        'Intra-repo import edges only. Services that talk over HTTP contracts rather than ' +
        'imports produce few or no edges; this is a structure, not the structure.',
    },
    skipped: inv.skipped,
  };

  if (opts.write !== false) {
    const outDir = opts.outDir ?? path.join(root, CACHE_DIR);
    const filesDir = path.join(outDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });

    fs.writeFileSync(path.join(outDir, 'digest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify(graph, null, 2));
    fs.writeFileSync(path.join(outDir, 'ranked.json'), JSON.stringify(ranked, null, 2));

    // Keyed by CONTENT hash, not path: a rename with no edit costs nothing, and a revert
    // re-uses the digest it had before (spec §4).
    const extractByPath = new Map(extracts.map((e) => [e.path, e] as const));
    const rankByPath = new Map(ranked.map((r) => [r.path, r] as const));
    for (const file of inv.files) {
      const payload = {
        file,
        rank: rankByPath.get(file.path) ?? null,
        extract: extractByPath.get(file.path) ?? null,
      };
      fs.writeFileSync(path.join(filesDir, `${file.sha256}.json`), JSON.stringify(payload, null, 2));
    }
  }

  return { manifest, inventory: inv, extracts, graph, ranked, deepSlice };
}
