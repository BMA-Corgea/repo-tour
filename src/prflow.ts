/**
 * The PR flow, in one place, callable from anywhere.
 *
 * T-5 built this inside the CLI handler, where it did resolve → checkpoint → both sides →
 * adjudicate → build the tour → **write a file and print a table**. That last step is the
 * only part the app does not want, and having it welded on is why the served page's
 * "Pull requests" tab could not reach any of it.
 *
 * So the middle is here and the callers keep their endings: the CLI prints, the server
 * serves. No behaviour moved in the extraction — the same functions run in the same order.
 *
 * `onProgress` exists because a PR tour spends model calls and is not instant. The app
 * already has a building page that shows live lines for repo tours; this is what feeds it
 * the same way, so a person clicking a PR sees work happening rather than a hung tab.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CACHE_DIR } from './digest.js';
import { renderPrView } from './prview.js';
import { parseUnified, rawDiff, type FileDiff } from './diff.js';
import { interpretStops, type StopMeaning } from './interpret.js';
import { resolvePr, diffSet, lineCounts, hunks, type Hunk, type PrRefs } from './pr.js';
import { loadCheckpoint, sideAt, staleness, type Checkpoint, type Staleness } from './checkpoint.js';
import { fileDelta, ripple, orderByMeaning, type FileDelta, type RippleResult } from './delta.js';
import { buildPrTour, band } from './prtour.js';
import { adjudicate, type Adjudication } from './adjudicate.js';

export interface PrFlowOptions {
  pr?: number;
  base?: string;
  head?: string;
  /** spend tokens interpreting and adjudicating; false scores on structure alone */
  interpret?: boolean;
  model?: string;
  provider?: string;
  onProgress?: (line: string) => void;
}

export interface PrFlowResult {
  refs: PrRefs;
  /** the literal change per file, for the page to render */
  diffs: Map<string, FileDiff>;
  checkpoint: Checkpoint;
  staleness: Staleness;
  deltas: FileDelta[];
  ripple: RippleResult;
  /** the rendered page — the same surface a repo tour renders into */
  html: string;
  stops: number;
  /** null when the two commits are identical; the caller decides what to say about it */
  empty: boolean;
}

/**
 * Resolve, compare, and render — everything except deciding where the result goes.
 *
 * Throws `PrResolutionError` / `NoCheckpointError` unchanged. Both carry a message written
 * for a person, and both callers show it rather than translating it: an error that says
 * what to run is worth more than an error code.
 */
export async function runPrFlow(root: string, opts: PrFlowOptions): Promise<PrFlowResult> {
  const say = opts.onProgress ?? (() => {});

  const refs = resolvePr(root, { pr: opts.pr, base: opts.base, head: opts.head });
  say(`head ${refs.headSha.slice(0, 8)} · base ${refs.baseSha.slice(0, 8)}`);

  const checkpoint = loadCheckpoint(root);
  say(`checkpoint ${checkpoint.sha?.slice(0, 8) ?? 'unrecorded'}`);

  /**
   * The FILE SET is the branch's own work — three-dot, from the fork point.
   *
   * `git diff base..head` is the wrong diff for a pull request. Once the base moves, a
   * two-dot diff reports everything the BASE gained as though the branch had deleted it,
   * and a two-file PR arrives as eleven files with phantom deletions at the top of the
   * tour. That is not a stale fixture; it is the wrong question.
   *
   * `baseSha` stays the landing point and keeps doing its §4 job — staleness, and the
   * overlap stop that says main touched files this PR also touches. What it must not do is
   * decide which files this PR changed.
   */
  const diffFrom = refs.forkSha ?? refs.baseSha;

  const changes = diffSet(root, diffFrom, refs.headSha).filter(
    (c) => !c.path.startsWith(`${CACHE_DIR}/`),
  );
  const lines = lineCounts(root, diffFrom, refs.headSha);
  const paths = changes.map((c) => c.path);
  const stale = staleness(root, checkpoint.sha, refs.baseSha, paths);

  if (changes.length === 0) {
    const verdicts = new Map<string, Adjudication>();
    void verdicts;
    const plan = buildPrTour({
      refs, deltas: [], ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
      staleness: stale, hunksByFile: new Map(),
    });
    return {
      refs, checkpoint, staleness: stale, deltas: [], diffs: new Map(),
      ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
      html: renderPrView({
        refs, deltas: [], diffs: new Map(), steps: plan.steps,
        ripple: { reinterpret: [], structuralOnly: [], reachable: 0 }, verdicts: new Map(),
      }),
      stops: plan.steps.length, empty: true,
    };
  }

  say(`${changes.length} files changed`);

  const renamedFrom = new Map<string, string>();
  for (const c of changes) if (c.status === 'R' && c.from) renamedFrom.set(c.path, c.from);
  const beforeSide = await sideAt(root, diffFrom, paths, renamedFrom);
  const afterSide = await sideAt(root, refs.headSha, paths);

  try {
    const hunksByFile = new Map<string, Hunk[]>();
    for (const p of paths) hunksByFile.set(p, hunks(root, diffFrom, refs.headSha, p));

    // The literal change, parsed once. The page renders it and the model reads it — both
    // from the same text, so what the reader sees is what the narrative was written about.
    const diffs = new Map<string, { raw: string; parsed: FileDiff }>();
    for (const p of paths) {
      const raw = rawDiff(root, diffFrom, refs.headSha, p);
      diffs.set(p, { raw, parsed: parseUnified(p, raw) });
    }

    const stopsFor = (side: typeof beforeSide) =>
      side.files.map((f) => {
        const hs = hunksByFile.get(f.path) ?? [];
        const first = hs[0];
        const last = hs[hs.length - 1];
        return {
          file: f.path,
          startLine: first ? Math.max(1, first.start - 3) : 1,
          endLine: Math.min(f.loc || 1, last ? last.end + 3 : 60),
          title: path.basename(f.path),
          text: '',
        };
      });

    let beforeMeanings = new Map<string, StopMeaning>();
    let afterMeanings = new Map<string, StopMeaning>();
    const verdicts = new Map<string, Adjudication>();

    if (opts.interpret !== false) {
      say(`interpreting ${beforeSide.files.length} files, both sides`);
      const b = await interpretStops(beforeSide.dir, stopsFor(beforeSide), beforeSide.files, beforeSide.extracts, [], { model: opts.model, provider: opts.provider });
      const a = await interpretStops(afterSide.dir, stopsFor(afterSide), afterSide.files, afterSide.extracts, [], { model: opts.model, provider: opts.provider });
      beforeMeanings = b.meanings;
      afterMeanings = a.meanings;
      say(`interpreted ${a.cost.interpretedStops + b.cost.interpretedStops} stops, ${a.cost.cachedStops + b.cost.cachedStops} reused`);

      // Who imports what, from the checkpoint's own graph — the reason a change in one
      // file can be felt in another, and half of the context the narrative is written from.
      const importersOf = new Map<string, string[]>();
      for (const e of checkpoint.graph.edges) {
        const list = importersOf.get(e.to) ?? [];
        list.push(e.from);
        importersOf.set(e.to, list);
      }

      let n = 0;
      for (const c of changes) {
        n++;
        say(`reading ${n}/${changes.length} — ${c.path}`);
        // The checkpoint's own reading of the file: what it already does, before this PR.
        const prior = [...beforeMeanings.entries()].find(([k]) => k.startsWith(`${c.path}:`))?.[1];
        verdicts.set(c.path, await adjudicate(
          c.path,
          diffs.get(c.path)?.raw ?? '',
          { what: prior?.what, why: prior?.why, importers: importersOf.get(c.path) ?? [] },
          { model: opts.model, provider: opts.provider, cwd: root },
        ));
      }
    } else {
      say('not interpreting — scores rest on structure alone');
    }

    const beforeExtracts = new Map(beforeSide.extracts.map((e) => [e.path, e] as const));
    const afterExtracts = new Map(afterSide.extracts.map((e) => [e.path, e] as const));

    const deltas: FileDelta[] = changes.map((c) => {
      const collect = (m: Map<string, StopMeaning>, p: string) =>
        [...m.entries()].filter(([k]) => k.startsWith(`${p}:`)).map(([, v]) => v);
      return fileDelta({
        path: c.path, status: c.status, linesChanged: lines.get(c.path) ?? 0,
        before: collect(beforeMeanings, c.path),
        after: collect(afterMeanings, c.path),
        beforeExtract: beforeExtracts.get(c.path),
        afterExtract: afterExtracts.get(c.path),
        adjudication: verdicts.get(c.path),
      });
    });

    const moved = deltas.filter((d) => band(d.meaningDelta) === 'moved').map((d) => d.path);
    const rip = ripple(checkpoint.graph, moved);
    const plan = buildPrTour({ refs, deltas, ripple: rip, staleness: stale, hunksByFile });
    say(`${plan.steps.length} stops`);

    return {
      refs, checkpoint, staleness: stale,
      diffs: new Map([...diffs].map(([k, v]) => [k, v.parsed])),
      deltas: orderByMeaning(deltas), ripple: rip,
      html: renderPrView({
        refs, deltas: orderByMeaning(deltas), diffs: new Map([...diffs].map(([k, v]) => [k, v.parsed])),
        steps: plan.steps, ripple: rip, verdicts,
      }),
      stops: plan.steps.length, empty: false,
    };
  } finally {
    beforeSide.dispose();
    afterSide.dispose();
  }
}
