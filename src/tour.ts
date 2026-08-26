/**
 * Tour generation — a tour is a PROJECTION of the digest, never a separate artifact.
 *
 * Every step below is computed from digest data at render time. Nothing is hand-written
 * about any particular repository, and no model is involved: if the tour says a file is
 * important, that claim is a number the digest produced and the step shows the number.
 *
 * This is the property that makes tours disposable (spec §2). The tour is not repaired
 * when code moves — it is regenerated, which is only affordable because generating it
 * costs nothing.
 */

import path from 'node:path';
import type { DigestResult } from './digest.js';
import type { RankedFile } from './types.js';
import type { TierDigest } from './rollup.js';

export interface TourStep {
  target: string;
  title?: string;
  text: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  spotlight?: boolean;
  /** path to type into the table filter before this step, so the row exists to point at */
  filterTo?: string;
  /** expand the row's detail panel when the step opens */
  expand?: boolean;
}

function n(x: number): string {
  return x.toLocaleString();
}

/** The highest-value file that is SMALL — the case ranking exists to get right. */
function findSmallButCritical(ranked: RankedFile[]): RankedFile | null {
  const scored = ranked.filter((r) => r.score > 0 && r.loc > 0 && r.loc < 400 && r.churn > 0);
  if (scored.length === 0) return null;
  return scored.reduce((best, r) => (r.churn > best.churn ? r : best), scored[0]!);
}

/** The biggest file in the tree, whatever it is — usually exhaust. */
function findLargest(ranked: RankedFile[]): RankedFile | null {
  const withLoc = ranked.filter((r) => r.loc > 0);
  if (withLoc.length === 0) return null;
  return withLoc.reduce((big, r) => (r.loc > big.loc ? r : big), withLoc[0]!);
}

/** The subsystem tier holding the most valuable work. */
function topSubsystem(tiers: TierDigest[]): TierDigest | null {
  const subs = tiers.filter((t) => t.kind === 'subsystem' && t.fileCount > 1);
  if (subs.length === 0) return null;
  return subs.reduce((best, t) => (t.score > best.score ? t : best), subs[0]!);
}

export function buildTourSteps(result: DigestResult): TourStep[] {
  const m = result.manifest;
  const name = path.basename(m.root) || m.root;
  const steps: TourStep[] = [];

  const cls = m.counts.byClassification;
  const sourceish = (cls['source'] ?? 0) + (cls['structural'] ?? 0);
  const noise = (cls['generated'] ?? 0) + (cls['vendored'] ?? 0) + (cls['lockfile'] ?? 0);

  steps.push({
    target: '#hdr',
    title: `This is ${name}`,
    text:
      `${n(m.counts.files)} files across ${m.repos.length} ` +
      `${m.repos.length === 1 ? 'repository' : 'repositories'}. ` +
      `I read all of it — ${n(m.counts.symbols)} symbols and ${n(m.counts.edges)} import edges — ` +
      `in ${(m.cost.wallMs / 1000).toFixed(0)} seconds, and it cost nothing. ` +
      `Nothing you are about to see was written by an AI. Every number came off a parser or off git. ` +
      `Let me show you what actually matters in here.`,
    placement: 'bottom',
  });

  if (m.repos.length > 1) {
    const deepest = m.repos
      .slice()
      .sort((a, b) => b.root.split('/').length - a.root.split('/').length)[0]!;
    const total = m.repos.reduce((s, r) => s + r.commitCount, 0);
    const parent = m.repos.find((r) => r.root === '');
    steps.push({
      target: '#repos',
      title: 'It is not one repository',
      text:
        `It is ${m.repos.length}, nested inside each other, each with its own history. ` +
        (parent ? `The outer one has ${n(parent.commitCount)} commits; ` : '') +
        `together they have ${n(total)}. ` +
        `The deepest is ${deepest.root}, ${deepest.root.split('/').length} levels down. ` +
        `A tool that runs "git ls-files" at the top of this tree gives you a confident, wrong answer — ` +
        `it simply cannot see most of this code.`,
      placement: 'top',
    });
  }

  steps.push({
    target: '#classification',
    title: 'Most of a repo is not worth reading',
    text:
      `Of ${n(m.counts.files)} files, ${n(sourceish)} are source or structural. ` +
      `${n(noise)} are generated, vendored or lockfiles — scored to exactly zero, so they can never ` +
      `reach the expensive stage. That is not a filter I guessed at: each one carries the specific ` +
      `signal that classified it, and you can check any of them.`,
    placement: 'top',
  });

  steps.push({
    target: '#coverage',
    title: 'What I can see, and what I cannot',
    text:
      `${m.graphCoverage.resolvedInternal === 0 ? '0' : Math.round((m.graphCoverage.resolvedInternal / Math.max(1, m.graphCoverage.totalImports)) * 100)}% ` +
      `of imports resolved to a real file inside this tree; ` +
      `${n(m.graphCoverage.leftTheTree)} left it. ` +
      `I am telling you that rather than showing you a graph and letting you assume it is complete. ` +
      `Services that talk over HTTP instead of imports are invisible to this particular signal.`,
    placement: 'top',
  });

  const small = findSmallButCritical(result.ranked);
  const largest = findLargest(result.ranked);

  steps.push({
    target: '#controls',
    title: 'Ranked by three signals, in this order',
    text:
      `How often a file changes, how many things import it, and — last — how long it is. ` +
      `The order is the whole trick. Rank by length and you get the opposite of the truth.` +
      (largest ? ` Watch: the longest file here is ${n(largest.loc)} lines.` : ''),
    placement: 'bottom',
  });

  const top = result.ranked.find((r) => r.score > 0);
  if (top) {
    steps.push({
      target: `[data-tour-path="${top.path}"]`,
      title: 'The most load-bearing file in the system',
      text:
        `${top.path} — ${n(top.churn)} commits, ${n(top.inDegree)} things import it, ${n(top.loc)} lines. ` +
        `Open it and you can see exactly how that score was built. Nothing here is a black box: ` +
        `three numbers, three weights, one multiplier for what kind of file it is.`,
      filterTo: top.path,
      expand: true,
      placement: 'bottom',
    });
  }

  if (small && largest && small.path !== largest.path) {
    const smallAt = result.ranked.findIndex((r) => r.path === small.path) + 1;
    const largeAt = result.ranked.findIndex((r) => r.path === largest.path) + 1;
    steps.push({
      target: `[data-tour-path="${small.path}"]`,
      title: 'This is the case that breaks other tools',
      text:
        `${small.path} is ${n(small.loc)} lines — but it has been changed ${n(small.churn)} times. ` +
        `It ranks #${n(smallAt)}. ` +
        `The longest file in this tree, ${largest.path} at ${n(largest.loc)} lines, ranks #${n(largeAt)}. ` +
        `Sort by size and you would read the second one first and learn almost nothing. ` +
        `Churn and imports are what make a file matter; length is a tiebreaker.`,
      filterTo: small.path,
      expand: true,
      placement: 'bottom',
    });
  }

  const sub = topSubsystem(result.tiers);
  if (sub) {
    steps.push({
      target: '#cards',
      title: 'And it stacks up, not just down',
      text:
        `Every directory, subsystem and repository has its own digest, built from the tier below it — ` +
        `${n(m.counts.tiers)} of them here. No step ever reads the whole repo, which is why size stops ` +
        `being a problem. The busiest subsystem is ${sub.path} (${n(sub.fileCount)} files, ` +
        `${n(sub.publicSymbols)} public symbols). A tour can start at any altitude: the whole system, ` +
        `one subsystem, or one file.`,
      placement: 'bottom',
    });
  }

  steps.push({
    target: '#hdr',
    title: 'That is the digest',
    text:
      `Everything you just saw is stage 1, 2, 3 and 5 — all free, all deterministic, all re-runnable. ` +
      `Stage 4 is the one that spends tokens, and it has not run: it would be handed this skeleton and ` +
      `asked only what things MEAN, never what is in them. ` +
      `This tour is a projection of the digest, so when the code moves it is not repaired — it is ` +
      `regenerated, which is affordable precisely because it costs nothing.`,
    placement: 'bottom',
  });

  return steps;
}
