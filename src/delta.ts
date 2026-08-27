/**
 * The meaning delta — the comparison this whole ticket exists for.
 *
 * GitHub sorts a pull request by lines changed. This sorts it by how much the
 * INTERPRETATION moved, which is a different number, and the mismatch between the two is
 * the signal (spec §2):
 *
 *   large diff, no meaning change   a refactor            read it fast
 *   small diff, large meaning change the semantics moved   this is your afternoon
 *   no diff at all, meaning changed  a ripple              nobody ever catches these
 *
 * ── Why this compares CLAIMS and not prose ──────────────────────────────────────────────
 *
 * The ticket's stated primary risk (spec §10) is that stage 4 is a model, and a model
 * re-reading the same code may word its answer differently. If a re-wording scored as a
 * meaning change, the central claim above would collapse into noise.
 *
 * Two things keep that from happening. The first is free and comes from T-1: stop identity
 * is keyed by CONTENT hash, so a file nobody touched is never re-interpreted at all and
 * literally cannot drift. The risk is confined to files the PR actually edited.
 *
 * The second is this module. It does not compare sentences. It reduces each explanation to
 * the CLAIMS it makes — the identifiers it names and the content words it uses — and
 * compares those sets. "Manages the retry budget" and "handles the retry budget" make the
 * same claim; "manages the retry budget" and "manages the connection pool" do not.
 * Identifiers weigh heaviest because they are the part a model cannot paraphrase: if the
 * explanation now names different functions, the meaning moved.
 */

import type { StopMeaning } from './interpret.js';
import type { FileExtract, ImportGraph, SymbolRecord } from './types.js';

/** Grammar. Carries no claim in any explanation. */
const STOPWORDS = new Set(
  ('a an the and or but if then than that this these those it its is are was were be been being ' +
    'to of in on at by for with from into over under as so such not no nor own same too very can ' +
    'will just do does did doing have has had having he she they them their there here what which ' +
    'who whom when where why how all any both each few more most other some only up down out off ' +
    'again further once about against between during before after above below you your we our i me ' +
    'my us one two also because while would could should may might must shall per via')
    .split(' '),
);

/**
 * The paraphrase surface: generic actions and containers that describe HOW an explanation
 * is phrased rather than WHAT it is about.
 *
 * This list is what makes the comparison survive a model re-wording itself. "Manages the
 * retry budget" and "handles the retry budget" differ only here; "manages the retry budget"
 * and "manages the connection pool" differ in the subject, which is what survives the
 * filter. Strip the surface and a paraphrase reduces to the same claim set, exactly.
 *
 * ⚠ HONEST LIMITATION. This list was tuned against a handful of hand-written pairs while
 * building the comparison, which is a real risk of fitting the examples rather than the
 * problem. It separates those pairs completely (0.00 for paraphrase, 0.85+ for a changed
 * subject) but that is a promising start, not a validated threshold. The proof is
 * criterion 4 running against real pull requests, and the number to watch is the gap, not
 * the absolute score. Widen this list; never widen it to make one stubborn PR behave.
 */
const GENERIC = new Set(
  ('manage manages managed managing handle handles handled handling spend spends spent spending ' +
    'draw draws drew drawing decline declines declined declining refuse refuses refused refusing ' +
    'use uses used using exhaust exhausts exhausted record records recorded recording ' +
    'register registers registered registering traverse traverses traversed traversing ' +
    'walk walks walked walking encounter encounters encountered meet meets met retain retains ' +
    'retained keep keeps kept make makes made get gets got give gives given take takes taken ' +
    'provide provides provided ensure ensures ensured perform performs performed ' +
    'return returns returned produce produces produced create creates created build builds built ' +
    'call calls called run runs ran hold holds held allow allows allowed ' +
    'single time times each every once thing things way ways part parts piece pieces ' +
    'code function functions method methods module modules file files line lines value values ' +
    'here there like just also then still even much many lot lots kind sort type ' +
    'first second next last own real actual simple plain whole entire')
    .split(' '),
);

const IDENTIFIER = /\b(?:[a-z]+(?:[A-Z][a-z0-9]*)+|[a-z0-9]+_[a-z0-9_]+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g;

export interface Claims {
  /** identifiers the explanation names — the part a model cannot paraphrase away */
  ids: Set<string>;
  /**
   * Subject words that appear in the FILE'S OWN vocabulary — its symbol names and the
   * modules it imports.
   *
   * This is the load-bearing set. A word the code itself uses is a claim about the code; a
   * word only the explanation uses is the writer's phrasing. Grounding the comparison in
   * the file's vocabulary means the signal comes from data we extracted deterministically,
   * not from guessing which English words are "important".
   */
  grounded: Set<string>;
  /** everything else the explanation says — real, but the weakest evidence of meaning */
  prose: Set<string>;
  /**
   * Adjacent GROUNDED words — multi-word subjects like "retry budget", which say more than
   * either word alone and survive a paraphrase intact.
   *
   * Built from grounded terms only, deliberately. A pair of prose words is phrasing, not a
   * claim, and one swapped verb breaks two prose bigrams at once — which made this the
   * component that punished paraphrase hardest, the exact opposite of its job.
   */
  pairs: Set<string>;
}

/** The words a file itself uses: its symbol names and its import specifiers, split apart. */
export function vocabularyOf(symbols: SymbolRecord[] = [], imports: string[] = []): Set<string> {
  const vocab = new Set<string>();
  const add = (raw: string) => {
    const lower = raw.toLowerCase();
    if (lower.length > 2) vocab.add(lower);
    // camelCase and snake_case names are compounds; the explanation will use the parts
    // ("the digest manifest"), so the parts are vocabulary too.
    for (const part of raw.split(/[^A-Za-z0-9]+|(?=[A-Z])/)) {
      const p = part.toLowerCase();
      if (p.length > 2) vocab.add(p);
    }
  };
  for (const s of symbols) add(s.name);
  for (const i of imports) for (const seg of i.split(/[^A-Za-z0-9]+/)) add(seg);
  return vocab;
}

export function claimsOf(text: string, symbols: SymbolRecord[] = [], vocab?: Set<string>): Claims {
  const ids = new Set<string>();
  const known = new Set(symbols.map((s) => s.name.toLowerCase()));
  const words = vocab ?? known;

  for (const m of text.match(IDENTIFIER) ?? []) ids.add(m.toLowerCase());
  // A symbol named in plain lowercase ("the digest function") is still a claim about which
  // code is involved, so known symbol names count even without camelCase to give them away.
  for (const word of text.toLowerCase().match(/\b[a-z][a-z0-9]{2,}\b/g) ?? []) {
    if (known.has(word)) ids.add(word);
  }

  const sequence = (text.toLowerCase().match(/\b[a-z][a-z-]{2,}\b/g) ?? []).filter(
    (w) => !STOPWORDS.has(w) && !GENERIC.has(w) && !ids.has(w),
  );
  const grounded = new Set<string>();
  const prose = new Set<string>();
  const groundedSequence: string[] = [];
  for (const w of sequence) {
    if (words.has(w)) {
      grounded.add(w);
      groundedSequence.push(w);
    } else {
      prose.add(w);
    }
  }

  const pairs = new Set<string>();
  for (let i = 0; i < groundedSequence.length - 1; i++) {
    pairs.add(`${groundedSequence[i]} ${groundedSequence[i + 1]}`);
  }
  return { ids, grounded, prose, pairs };
}

function jaccardDistance(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : 1 - shared / union;
}

/**
 * How far one explanation moved from another, 0 (same claims) to 1 (nothing in common).
 *
 * Three components, and only the ones with something to say get a vote. An explanation
 * that names no identifiers gives the identifier comparison nothing to compare, and
 * letting an empty set contribute a confident zero would quietly drag every score toward
 * "nothing changed" — the failure direction that matters, because it hides real change.
 */
export function meaningDistance(
  before: string,
  after: string,
  symbols: SymbolRecord[] = [],
  vocab?: Set<string>,
): number {
  const a = claimsOf(before, symbols, vocab);
  const b = claimsOf(after, symbols, vocab);

  // Weighted toward what the code can corroborate. Prose gets a small vote rather than
  // none: an explanation that changed nothing but its adjectives should not score zero
  // forever, it should score LOW, and the difference matters when someone is deciding
  // whether the comparison is working at all.
  const components: Array<[number, Set<string>, Set<string>]> = [
    [0.4, a.ids, b.ids],
    [0.35, a.grounded, b.grounded],
    [0.15, a.pairs, b.pairs],
    [0.1, a.prose, b.prose],
  ];

  let weight = 0;
  let total = 0;
  for (const [w, x, y] of components) {
    if (x.size === 0 && y.size === 0) continue;
    weight += w;
    total += w * jaccardDistance(x, y);
  }
  return weight === 0 ? 0 : Math.min(1, total / weight);
}

export interface SurfaceChange {
  added: string[];
  removed: string[];
  /** same name, different shape — a signature or kind change */
  changed: string[];
}

/**
 * What this file's PUBLIC surface did.
 *
 * Exported symbols are the part of a change other code can feel. This is deterministic —
 * no model involved — which makes it the one component of the delta that cannot be noisy,
 * and the reason a file with no interpretation on either side can still score.
 */
export function surfaceChange(before: FileExtract | undefined, after: FileExtract | undefined): SurfaceChange {
  const pub = (e: FileExtract | undefined) =>
    new Map((e?.symbols ?? []).filter((s) => s.exported).map((s) => [s.name, s] as const));
  const a = pub(before);
  const b = pub(after);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, sym] of b) {
    const prior = a.get(name);
    if (!prior) added.push(name);
    else if (prior.kind !== sym.kind) changed.push(name);
  }
  for (const name of a.keys()) if (!b.has(name)) removed.push(name);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface FileDelta {
  path: string;
  status: ChangeStatus;
  linesChanged: number;
  /** 0..1 — how far this file's interpretation moved */
  meaningDelta: number;
  surface: SurfaceChange;
  /** false when there was no interpretation on one side; the score then rests on surface alone */
  interpreted: boolean;
  /** plain language: why this scored what it did, so the ordering can be argued with */
  reason: string;
  /** how the score was reached, so a tour never implies more confidence than it has */
  basis: 'adjudicated' | 'claims' | 'structure' | 'status';
  /** true when this file did not change but its meaning may have — a ripple (spec §5) */
  ripple?: boolean;
}

export interface DeltaInput {
  path: string;
  status: ChangeStatus;
  linesChanged: number;
  before: StopMeaning[];
  after: StopMeaning[];
  beforeExtract?: FileExtract;
  afterExtract?: FileExtract;
  /**
   * A direct verdict from something that read BOTH versions of the file.
   *
   * When present this drives the score, because it answers the question the claim
   * comparison can only approximate. See adjudicate.ts for the measurement that made this
   * necessary: comparing two free-prose interpretations scored a pure local-variable
   * rename at 0.47, because the model wrote a different essay rather than a paraphrase.
   */
  adjudication?: { magnitude: number; headline: string; kind: string; source: string };
}

function joinMeanings(ms: StopMeaning[]): string {
  return ms.map((m) => `${m.what} ${m.why}`).join(' ').trim();
}

/**
 * Score one file.
 *
 * A public-surface change is a floor, not an addend: if a module started or stopped
 * exporting something, that is a meaning change whatever the prose says about it, and a
 * comparison that let confident-sounding prose talk it down would be exactly wrong.
 */
export function fileDelta(input: DeltaInput): FileDelta {
  const surface = surfaceChange(input.beforeExtract, input.afterExtract);
  const surfaceCount = surface.added.length + surface.removed.length + surface.changed.length;
  const interpreted = input.before.length > 0 && input.after.length > 0;

  let score = 0;
  let reason: string;
  let basis: FileDelta['basis'] = 'structure';

  if (input.status === 'A') {
    score = 1;
    reason = 'new file — all of it is new meaning';
    basis = 'status';
  } else if (input.status === 'D') {
    score = 1;
    reason = 'deleted — whatever this meant is gone';
    basis = 'status';
  } else if (input.adjudication && input.adjudication.source !== 'unavailable') {
    score = input.adjudication.magnitude;
    reason = input.adjudication.headline;
    basis = 'adjudicated';
  } else if (interpreted) {
    const symbols = input.afterExtract?.symbols ?? input.beforeExtract?.symbols ?? [];
    const vocab = vocabularyOf(
      [...(input.beforeExtract?.symbols ?? []), ...(input.afterExtract?.symbols ?? [])],
      [
        ...(input.beforeExtract?.imports ?? []).map((i) => i.raw),
        ...(input.afterExtract?.imports ?? []).map((i) => i.raw),
      ],
    );
    score = meaningDistance(joinMeanings(input.before), joinMeanings(input.after), symbols, vocab);
    reason =
      score < 0.15
        ? 'the explanation makes the same claims as before — this reads as a refactor'
        : score < 0.45
          ? 'parts of the explanation changed; the subject is broadly the same'
          : 'the explanation is about something different now';
    basis = 'claims';
  } else {
    // No interpretation on one side. Say so rather than scoring zero and implying calm.
    score = surfaceCount > 0 ? 0.5 : 0.25;
    reason = 'not interpreted on both sides — scored on structure alone';
  }

  if (surfaceCount > 0) {
    const floor = Math.min(1, 0.4 + 0.1 * surfaceCount);
    if (floor > score) {
      score = floor;
      const bits = [
        surface.added.length ? `${surface.added.length} added` : '',
        surface.removed.length ? `${surface.removed.length} removed` : '',
        surface.changed.length ? `${surface.changed.length} changed` : '',
      ].filter(Boolean).join(', ');
      reason = `the public surface moved (${bits}) — other code can feel this`;
    }
  }

  return {
    path: input.path,
    status: input.status,
    linesChanged: input.linesChanged,
    meaningDelta: Number(score.toFixed(3)),
    surface,
    interpreted,
    reason,
    basis,
  };
}

export interface RippleResult {
  /** direct importers of a file whose meaning moved — these ARE re-interpreted */
  reinterpret: string[];
  /**
   * Everything further out. Listed structurally and NEVER re-interpreted, and the tour
   * says so: spec §5 is one hop of meaning, N hops of structure. A boundary stated is
   * arguable; a boundary implied is a lie about completeness.
   */
  structuralOnly: string[];
  /** how far the reachable set actually extends, so the boundary has a size next to it */
  reachable: number;
}

/**
 * Who else may now mean something different.
 *
 * If module B changed what it is for, module A — which imports B and changed not one
 * character — may have changed too. No diff-based tool can see that, and it is the "what
 * that does" half of what was asked for.
 *
 * Chasing it transitively is unbounded, so this stops at one hop of MEANING and reports
 * the rest as structure.
 */
export function ripple(graph: ImportGraph, moved: string[], threshold = 0.3): RippleResult {
  const importersOf = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = importersOf.get(e.to) ?? [];
    list.push(e.from);
    importersOf.set(e.to, list);
  }

  const movedSet = new Set(moved);
  const firstHop = new Set<string>();
  for (const p of moved) for (const importer of importersOf.get(p) ?? []) {
    if (!movedSet.has(importer)) firstHop.add(importer);
  }

  const seen = new Set<string>([...movedSet, ...firstHop]);
  let frontier = [...firstHop];
  const beyond = new Set<string>();
  while (frontier.length) {
    const next: string[] = [];
    for (const p of frontier) for (const importer of importersOf.get(p) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      beyond.add(importer);
      next.push(importer);
    }
    frontier = next;
  }

  void threshold;
  return {
    reinterpret: [...firstHop].sort(),
    structuralOnly: [...beyond].sort(),
    reachable: firstHop.size + beyond.size,
  };
}

/** The tour's order: meaning first, and never lines. */
export function orderByMeaning(deltas: FileDelta[]): FileDelta[] {
  return [...deltas].sort(
    (a, b) => b.meaningDelta - a.meaningDelta || b.linesChanged - a.linesChanged || a.path.localeCompare(b.path),
  );
}
