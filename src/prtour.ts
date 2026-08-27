/**
 * Projecting a meaning delta into a tour.
 *
 * The ordering is the product. GitHub lists a pull request's files alphabetically and
 * sizes them by lines changed; this walks them by how far their INTERPRETATION moved, and
 * shows both numbers on every stop so the order can be argued with rather than trusted.
 *
 * Two disciplines are load-bearing here and neither is decoration:
 *
 *   §7 — every claim about WHY a change was made cites where it came from. The PR body, a
 *   commit message, a linked issue. Where no source exists the stop SAYS the author
 *   recorded no reason. It never fills the gap with a plausible story, because a plausible
 *   story about why code changed is worse than silence: it is unfalsifiable and it reads
 *   exactly like knowledge.
 *
 *   §5 — the ripple boundary is stated. Direct importers of moved meaning are stops;
 *   everything further out is named as structure and marked NOT re-interpreted. A
 *   boundary stated is arguable. A boundary implied is a claim of completeness we cannot
 *   support.
 */

import path from 'node:path';

import type { CodeStep } from './codetour.js';
import type { FileDelta, RippleResult } from './delta.js';
import { orderByMeaning } from './delta.js';
import type { Staleness } from './checkpoint.js';
import type { Hunk, PrRefs } from './pr.js';

export interface PrTourInput {
  refs: PrRefs;
  deltas: FileDelta[];
  ripple: RippleResult;
  staleness: Staleness;
  /** head-side hunks per file, so a stop points at the change and not at line 1 */
  hunksByFile: Map<string, Hunk[]>;
  /** how many files the tour visits before it stops being a tour and becomes a list */
  maxFiles?: number;
}

export interface PrTourPlan {
  steps: CodeStep[];
  itinerary: string[];
}

const CHAPTERS = {
  what: { key: 'pr-what', title: 'What this change is', subtitle: 'the shape of it, before the detail' },
  moved: { key: 'pr-moved', title: 'What changed meaning', subtitle: 'ordered by how far, not by how many lines' },
  quiet: { key: 'pr-quiet', title: 'What only moved on the surface', subtitle: 'real edits that left the meaning alone' },
  ripple: { key: 'pr-ripple', title: 'What else may be affected', subtitle: 'code this PR did not touch' },
};

/** The band a score falls in, in words a reader can act on. */
export function band(delta: number): 'moved' | 'shifted' | 'steady' {
  if (delta >= 0.45) return 'moved';
  if (delta >= 0.15) return 'shifted';
  return 'steady';
}

function n(x: number): string {
  return x.toLocaleString();
}

/** One trailing full stop, whoever wrote the sentence. Model text may or may not carry one. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Capitalise a sentence — unless it opens on an identifier.
 *
 * `churnByFile renames five locals` became `ChurnByFile renames five locals`, which names
 * a symbol that does not exist. In a tool whose entire claim is precision about code, a
 * silently mis-cased identifier is worse than an uncapitalised sentence.
 */
function opener(text: string): string {
  const t = text.trim();
  if (!t) return '';
  const first = t.split(/\s/)[0] ?? '';
  const looksLikeCode = /[a-z][A-Z]|[_.]|\(\)/.test(first);
  return looksLikeCode ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The sources §7 allows for a claim about why.
 *
 * Ordered by how specific they are: a commit that touched this exact file beats the PR
 * description, which beats nothing at all.
 */
export function whyFor(refs: PrRefs, file: string): { text: string; source: string } | null {
  const base = path.basename(file);
  const stem = base.replace(/\.[^.]+$/, '');
  for (const c of refs.prose.commits) {
    const first = c.message.split('\n')[0]?.trim() ?? '';
    if (!first) continue;
    if (c.message.includes(file) || c.message.includes(base) || (stem.length > 3 && c.message.includes(stem))) {
      return { text: first, source: `commit ${c.sha.slice(0, 8)}` };
    }
  }
  if (refs.prose.body) {
    const line = refs.prose.body.split('\n').map((l) => l.trim()).find((l) => l.length > 20 && !l.startsWith('#'));
    if (line) return { text: line, source: 'the pull request description' };
  }
  return null;
}

function whySentence(refs: PrRefs, file: string): string {
  const why = whyFor(refs, file);
  if (why) return `Why: "${why.text}" — from ${why.source}.`;
  return refs.prose.source === 'github'
    ? 'The author recorded no reason for this change — nothing in the description, the commits or a linked issue explains it.'
    : 'No reason is recorded for this change. This tour was built from two refs, so there is no pull request description to read.';
}

function fileStop(
  d: FileDelta,
  refs: PrRefs,
  hunks: Hunk[],
  chapter: { key: string; title: string; subtitle: string },
): CodeStep {
  const first = hunks[0];
  const last = hunks[hunks.length - 1];
  const start = first ? Math.max(1, first.start - 3) : 1;
  const end = last ? last.end + 3 : 40;

  const b = band(d.meaningDelta);
  const verdict =
    b === 'moved'
      ? 'MEANING MOVED'
      : b === 'shifted'
        ? 'Meaning partly shifted'
        : 'Meaning steady';

  const surfaceBits = [
    d.surface.added.length ? `+${d.surface.added.join(', +')}` : '',
    d.surface.removed.length ? `−${d.surface.removed.join(', −')}` : '',
    d.surface.changed.length ? `~${d.surface.changed.join(', ~')}` : '',
  ].filter(Boolean).join('  ');

  // The summary is the default level (§8) and MUST carry the verdict: it is the entire
  // reason the tour stopped here, and a reader skimming should never have to press to
  // find out whether a file matters.
  const summary =
    `${verdict} · ${d.meaningDelta.toFixed(2)} · ${n(d.linesChanged)} ${d.linesChanged === 1 ? 'line' : 'lines'}. ` +
    sentence(d.reason);

  const detail = [
    `${d.status === 'A' ? 'Added' : d.status === 'D' ? 'Deleted' : d.status === 'R' ? 'Renamed' : 'Modified'}.`,
    `Meaning delta ${d.meaningDelta.toFixed(2)} (${b}); ${n(d.linesChanged)} ${d.linesChanged === 1 ? 'line' : 'lines'} changed across ${n(hunks.length)} ${hunks.length === 1 ? 'hunk' : 'hunks'}.`,
    sentence(opener(d.reason)),
    surfaceBits ? `Public surface: ${surfaceBits}` : 'Public surface unchanged.',
    d.interpreted ? '' : 'This file was not interpreted on both sides, so its score rests on structure alone.',
    whySentence(refs, d.path),
  ].filter(Boolean).join('\n\n');

  return {
    file: d.path,
    startLine: start,
    endLine: end,
    title: `${path.basename(d.path)} — ${verdict.toLowerCase()}`,
    text: detail,
    summary,
    chapter,
  };
}

export function buildPrTour(input: PrTourInput): PrTourPlan {
  const { refs, deltas, staleness, hunksByFile } = input;
  const maxFiles = input.maxFiles ?? 12;
  const steps: CodeStep[] = [];

  const ordered = orderByMeaning(deltas);
  const moved = ordered.filter((d) => band(d.meaningDelta) !== 'steady');
  const steady = ordered.filter((d) => band(d.meaningDelta) === 'steady');

  // ---- opening: what this is, and the one claim worth leading with
  const biggest = ordered[0];
  const byLines = [...deltas].sort((a, b) => b.linesChanged - a.linesChanged)[0];
  const reordered = biggest && byLines && biggest.path !== byLines.path;

  const openSummary =
    `${n(deltas.length)} ${deltas.length === 1 ? 'file' : 'files'} changed. ` +
    `${n(moved.length)} moved in meaning, ${n(steady.length)} did not. ` +
    (reordered
      ? `The biggest diff is ${path.basename(byLines.path)}; the biggest change of meaning is ${path.basename(biggest.path)}.`
      : 'Read them in this order.');

  steps.push({
    file: ordered[0]?.path ?? '',
    startLine: 1,
    endLine: 1,
    synthetic: true,
    title: refs.prose.title ?? `${refs.headLabel} → ${refs.baseLabel}`,
    summary: openSummary,
    text: [
      refs.prose.title ? `"${refs.prose.title}"` : `Comparing ${refs.headLabel} against ${refs.baseLabel}.`,
      `Head ${refs.headSha.slice(0, 8)} · base ${refs.baseSha.slice(0, 8)}` +
        (refs.forkSha ? ` · forked at ${refs.forkSha.slice(0, 8)}` : ''),
      `${n(deltas.length)} ${deltas.length === 1 ? 'file' : 'files'} changed. This tour walks them by how far their meaning moved, not by how many lines did.`,
      refs.forkSha
        ? `The base has moved ${n(refs.baseAhead)} ${refs.baseAhead === 1 ? 'commit' : 'commits'} since this branch forked, so what you are reading is what will happen when it LANDS, not what the author wrote against.`
        : 'The branch is up to date with its base — the fork point and the landing point are the same commit.',
      refs.prose.body ? `\nFrom the description:\n${refs.prose.body.split('\n').slice(0, 6).join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
    chapter: CHAPTERS.what,
  });

  // ---- the checkpoint's own honesty: what it has not seen (§4)
  if (staleness.overlap.length > 0) {
    steps.push({
      file: staleness.overlap[0]!,
      startLine: 1,
      endLine: 30,
      title: 'The checkpoint has not seen these',
      summary:
        `Your digest is ${n(staleness.behind)} ${staleness.behind === 1 ? 'commit' : 'commits'} behind, and ` +
        `${n(staleness.overlap.length)} of the files it missed are files this PR also changes. Read this first.`,
      text: [
        `The interpretation this tour compares against was taken at ${staleness.sha?.slice(0, 8) ?? 'an unrecorded commit'}, ` +
          `which is ${n(staleness.behind)} ${staleness.behind === 1 ? 'commit' : 'commits'} behind the base.`,
        'That is usually harmless. It is not harmless here, because these files changed on the base AND in this pull request:',
        staleness.overlap.map((p) => `  · ${p}`).join('\n'),
        'Two changes that are each fine on their own can be wrong together, and neither diff shows it. ' +
          'Re-running `repo-tour digest .` refreshes the checkpoint and this stop goes away.',
      ].join('\n\n'),
      chapter: CHAPTERS.what,
    });
  }

  // ---- the files, meaning first
  for (const d of moved.slice(0, maxFiles)) {
    steps.push(fileStop(d, refs, hunksByFile.get(d.path) ?? [], CHAPTERS.moved));
  }
  for (const d of steady.slice(0, Math.max(0, maxFiles - moved.length))) {
    steps.push(fileStop(d, refs, hunksByFile.get(d.path) ?? [], CHAPTERS.quiet));
  }

  // ---- the ripple (§5)
  if (input.ripple.reinterpret.length > 0 || input.ripple.structuralOnly.length > 0) {
    const r = input.ripple;
    steps.push({
      file: r.reinterpret[0] ?? ordered[0]?.path ?? '',
      startLine: 1,
      endLine: 40,
      title: 'Code this PR did not touch',
      summary:
        `${n(r.reinterpret.length)} ${r.reinterpret.length === 1 ? 'file imports' : 'files import'} something whose meaning moved, ` +
        `without changing a character. ${n(r.structuralOnly.length)} more sit beyond that and were NOT re-interpreted.`,
      text: [
        'If this PR changed what a module is FOR, then code that imports it may now mean something different too — with no diff to show for it.',
        r.reinterpret.length
          ? `Re-interpreted (one hop):\n${r.reinterpret.map((p) => `  · ${p}`).join('\n')}`
          : 'Nothing imports the changed files directly.',
        r.structuralOnly.length
          ? `Reachable beyond one hop, NOT re-interpreted — listed so the boundary is visible rather than implied:\n${r.structuralOnly.slice(0, 20).map((p) => `  · ${p}`).join('\n')}` +
            (r.structuralOnly.length > 20 ? `\n  … and ${n(r.structuralOnly.length - 20)} more` : '')
          : '',
        `The reachable set is ${n(r.reachable)} ${r.reachable === 1 ? 'file' : 'files'}. One hop of meaning, the rest as structure — that boundary is a choice, and it is stated here so it can be argued with.`,
      ].filter(Boolean).join('\n\n'),
      chapter: CHAPTERS.ripple,
    });
  }

  const itinerary = [...new Set(steps.map((s) => s.file).filter(Boolean))];
  return { steps, itinerary };
}
