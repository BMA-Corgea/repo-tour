/**
 * The architecture layer — what sits above the file.
 *
 * Stage 5 has been rolling up directory, subsystem and repo digests since T-1, and until
 * now nothing read them. That left a real hole: a tour made entirely of files teaches you
 * eight files. It does not teach you a system, because "how the pieces talk" is not
 * visible from inside any one of them.
 *
 * This derives the shape of the system from the tiers and the import graph:
 *
 *   - WHAT the parts are. When a tree contains nested repositories, those ARE the parts —
 *     GUTS is eight repos, and no directory heuristic beats simply saying so. Otherwise
 *     the parts are the directories that actually carry code.
 *   - HOW they talk. Every file-level import that crosses a part boundary is rolled up
 *     into a weighted edge between parts.
 *   - WHICH WAY the system flows. Parts nothing imports are entry points; parts everything
 *     imports are foundations. Peeling that graph gives the layers to draw.
 */

import path from 'node:path';
import type { DigestResult } from './digest.js';
import type { TierDigest } from './rollup.js';
import type { RankedFile } from './types.js';

export interface Subsystem {
  /** directory or repo root, relative to the scan root */
  path: string;
  name: string;
  kind: 'repo' | 'directory';
  fileCount: number;
  loc: number;
  publicSymbols: number;
  score: number;
  /** the best files inside it, for a reader who wants to go deeper */
  topFiles: Array<{ path: string; score: number; why: string }>;
  languages: Record<string, number>;
  /** filled by stage 4; null until interpreted */
  purpose: string | null;
}

export interface SubsystemEdge {
  from: string;
  to: string;
  /** how many distinct file-level imports cross this boundary */
  count: number;
}

export interface Architecture {
  subsystems: Subsystem[];
  edges: SubsystemEdge[];
  /** rows for drawing: entry points first, foundations last */
  layers: string[][];
  /**
   * Parts with no import edge in either direction. They are NOT entry points and must not
   * be drawn in the top row as though they were — they are simply unconnected, which is
   * itself worth saying (spikes, static assets, or something talking over a channel the
   * import graph cannot see).
   */
  unconnected: string[];
  /** files that belong to no named part — reported, never hidden */
  unassignedFiles: number;
  /** filled by stage 4; null until interpreted */
  overview: string | null;
}

const MAX_SUBSYSTEMS = 8;

function isCode(cls: string): boolean {
  return cls === 'source' || cls === 'structural' || cls === 'test';
}

/**
 * Choose the parts.
 *
 * Nested repositories win outright when there are several: a repo boundary is an explicit
 * statement by the authors that these things are separate, which beats anything inferred
 * from folder names.
 *
 * Otherwise the parts are directories that DIRECTLY hold code. That "directly" is the
 * whole trick. Sizing a part by everything beneath it makes containers look like parts:
 * autoSQL collapsed into `demo`, `spikes` and `ops`, hiding the four real components
 * inside `demo`, and GUTS listed its scan root as a peer of its own children with 1.8M
 * lines. Nesting is allowed here — `demo` and `demo/server` can both be parts — because
 * ownership is resolved by longest prefix, so each file lands in exactly one.
 */
function chooseSubsystems(result: DigestResult): TierDigest[] {
  const tiers = result.tiers;
  const repoRoots = new Set(result.manifest.repos.map((r) => r.root));

  if (repoRoots.size > 1) {
    const chosen = tiers
      .filter((t) => repoRoots.has(t.path))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUBSYSTEMS);
    if (chosen.length > 1) return chosen;
  }

  const codeByPath = new Map(result.inventory.files.map((f) => [f.path, isCode(f.classification)] as const));
  const directCode = (t: TierDigest): number => t.childFiles.filter((p) => codeByPath.get(p)).length;

  return tiers
    .filter((t) => t.path !== '' && directCode(t) >= 2 && t.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, MAX_SUBSYSTEMS);
}

/** Peel the graph: entry points (nothing imports them) first, foundations last. */
function layerOf(subsystems: Subsystem[], edges: SubsystemEdge[]): { layers: string[][]; unconnected: string[] } {
  const touched = new Set<string>();
  for (const e of edges) { touched.add(e.from); touched.add(e.to); }
  const connected = subsystems.filter((s) => touched.has(s.path));
  const unconnected = subsystems.filter((s) => !touched.has(s.path)).map((s) => s.path);

  const incoming = new Map<string, Set<string>>();
  for (const s of connected) incoming.set(s.path, new Set());
  for (const e of edges) incoming.get(e.to)?.add(e.from);

  const layers: string[][] = [];
  const placed = new Set<string>();

  while (placed.size < connected.length) {
    const row = connected
      .filter((s) => !placed.has(s.path))
      .filter((s) => [...(incoming.get(s.path) ?? [])].every((from) => placed.has(from) || from === s.path))
      .map((s) => s.path);

    if (row.length === 0) {
      // A cycle. Break it at the least-depended-upon remaining part rather than looping.
      const remaining = connected.filter((s) => !placed.has(s.path));
      const weakest = remaining.reduce((best, s) =>
        (incoming.get(s.path)?.size ?? 0) < (incoming.get(best.path)?.size ?? 0) ? s : best, remaining[0]!);
      layers.push([weakest.path]);
      placed.add(weakest.path);
      continue;
    }

    layers.push(row);
    for (const p of row) placed.add(p);
  }
  if (unconnected.length) layers.push(unconnected);
  return { layers, unconnected };
}

export function buildArchitecture(result: DigestResult): Architecture {
  const chosen = chooseSubsystems(result);
  if (chosen.length === 0) {
    return {
      subsystems: [], edges: [], layers: [], unconnected: [],
      unassignedFiles: result.inventory.files.length, overview: null,
    };
  }

  // Longest-prefix wins, so a file in demo/server/ lands in demo/server rather than demo.
  const roots = chosen.map((t) => t.path).sort((a, b) => b.length - a.length);
  const owner = (filePath: string): string | null =>
    roots.find((r) => filePath === r || filePath.startsWith(`${r}/`)) ?? null;

  const why = (r: RankedFile): string => {
    const bits: string[] = [];
    if (r.churn > 0) bits.push(`${r.churn} commits`);
    if (r.inDegree > 0) bits.push(`${r.inDegree} importers`);
    if (r.loc > 0) bits.push(`${r.loc} loc`);
    return bits.join(' · ');
  };

  // Every part is measured by what it OWNS, never by the whole subtree beneath it.
  const owned = new Map<string, string[]>(chosen.map((t) => [t.path, []] as const));
  for (const f of result.inventory.files) {
    const o = owner(f.path);
    if (o !== null) owned.get(o)!.push(f.path);
  }

  const fileByPath = new Map(result.inventory.files.map((f) => [f.path, f] as const));
  const publicByPath = new Map(
    result.extracts.map((e) => [e.path, e.symbols.filter((s) => s.exported).length] as const),
  );
  const rankOrder = new Map(result.ranked.map((r, i) => [r.path, i] as const));

  const subsystems: Subsystem[] = chosen.map((t) => {
    const mine = owned.get(t.path) ?? [];
    const code = mine.filter((p) => isCode(fileByPath.get(p)?.classification ?? ''));
    const languages: Record<string, number> = {};
    let loc = 0;
    let publicSymbols = 0;
    for (const p of code) {
      const f = fileByPath.get(p)!;
      if (f.loc > 0) loc += f.loc;
      if (f.language) languages[f.language] = (languages[f.language] ?? 0) + 1;
      publicSymbols += publicByPath.get(p) ?? 0;
    }
    const topFiles = code
      .filter((p) => rankOrder.has(p))
      .sort((a, b) => rankOrder.get(a)! - rankOrder.get(b)!)
      .slice(0, 4)
      .map((p) => {
        const r = result.ranked[rankOrder.get(p)!]!;
        return { path: p, score: r.score, why: why(r) };
      });

    return {
      path: t.path,
      name: t.path.split('/').filter(Boolean).slice(-2).join('/') || '(repo root)',
      kind: (t.kind === 'repo' ? 'repo' : 'directory') as Subsystem['kind'],
      fileCount: code.length,
      loc,
      publicSymbols,
      score: t.score,
      topFiles,
      languages,
      purpose: null,
    };
  }).filter((s) => s.fileCount > 0);

  // Roll the file-level import graph up to part level.
  const tally = new Map<string, number>();
  for (const e of result.graph.edges) {
    const a = owner(e.from);
    const b = owner(e.to);
    if (!a || !b || a === b) continue;
    const key = `${a} ${b}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const edges: SubsystemEdge[] = [...tally.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(' ') as [string, string];
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  const assigned = result.inventory.files.filter((f) => owner(f.path) !== null).length;

  const { layers, unconnected } = layerOf(subsystems, edges);

  return {
    subsystems,
    edges,
    layers,
    unconnected,
    unassignedFiles: result.inventory.files.length - assigned,
    overview: null,
  };
}

/** A compact, factual description of the system for stage 4 to interpret. */
export function architectureBrief(arch: Architecture, repoName: string, totalFiles: number): string {
  const lines: string[] = [];
  lines.push(`Repository: ${repoName} (${totalFiles.toLocaleString()} files total)`);
  lines.push(`It divides into ${arch.subsystems.length} parts:`);
  lines.push('');

  for (const s of arch.subsystems) {
    const langs = Object.entries(s.languages)
      .filter(([k]) => k !== 'markdown' && k !== 'text')
      .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k).join('/');
    lines.push(`- ${s.path}${s.kind === 'repo' ? '  (its own git repository)' : ''}`);
    lines.push(`    ${s.fileCount} code files, ${s.loc.toLocaleString()} lines, ${s.publicSymbols} public symbols${langs ? `, mostly ${langs}` : ''}`);
    if (s.topFiles.length) {
      lines.push(`    most-weighted files: ${s.topFiles.map((f) => `${f.path} (${f.why})`).join('; ')}`);
    }
  }

  lines.push('');
  if (arch.edges.length) {
    lines.push('Import flow between the parts (A imports from B):');
    for (const e of arch.edges.slice(0, 20)) {
      lines.push(`- ${e.from} -> ${e.to}   (${e.count} import${e.count === 1 ? '' : 's'})`);
    }
  } else {
    lines.push(
      'No imports cross between these parts. Either they are independent, or they talk ' +
      'over something the import graph cannot see (HTTP, a queue, a shared database).',
    );
  }
  return lines.join('\n');
}
