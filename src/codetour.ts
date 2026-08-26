/**
 * Code-anchored tour generation.
 *
 * The earlier tour walked a viewer through a page of METRICS about a repo. That was the
 * wrong surface: score, churn and in-degree are how the engine decides what is worth
 * showing you, not what you want to read. They belong under the floor.
 *
 * A step here anchors to a FILE and a LINE RANGE. The narration is about the code on the
 * screen, and every claim in it is a fact the digest produced.
 *
 * What this cannot do without stage 4: say WHY a piece of code exists. Deterministic
 * narration can tell you what something is, how big it is, what it pulls in, and who
 * leans on it. It cannot tell you that a retry loop is there because of an outage last
 * March. That gap is exactly what the interpret stage is for, and it is stated on the
 * page rather than papered over.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DigestResult } from './digest.js';
import type { RankedFile, SymbolRecord } from './types.js';

export interface CodeStep {
  file: string;
  /** 1-indexed, inclusive */
  startLine: number;
  endLine: number;
  title: string;
  text: string;
  /**
   * A stop the tour wrote about itself rather than about the code under it — the closing
   * summary. Stage 4 must skip these: it anchors to the entry file's first few lines, and
   * interpreting them would replace "that is the spine of this repo" with an explanation
   * of three import statements.
   */
  synthetic?: boolean;
}

function n(x: number): string {
  return x.toLocaleString();
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

/** Who imports this file — the reverse of the import graph. */
function importersOf(result: DigestResult): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const e of result.graph.edges) {
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to)!.push(e.from);
  }
  return rev;
}

/**
 * What to stop at inside a file: things the author explained first, then public things,
 * then the biggest.
 *
 * Documented symbols rank first on purpose. A docstring is the only "why" available
 * without spending a token, so a stop at a documented function is worth more to a reader
 * than a stop at a longer undocumented one.
 */
function headlineSymbols(symbols: SymbolRecord[], limit: number): SymbolRecord[] {
  return symbols
    .filter((s) => s.kind !== 'variable')
    .slice()
    .sort((a, b) => {
      const aDoc = a.doc !== null, bDoc = b.doc !== null;
      if (aDoc !== bDoc) return aDoc ? -1 : 1;
      if (a.exported !== b.exported) return a.exported ? -1 : 1;
      return b.endLine - b.line - (a.endLine - a.line);
    })
    .slice(0, limit)
    .sort((a, b) => a.line - b.line);
}

function describeSymbol(s: SymbolRecord, file: string): { title: string; text: string } {
  const span = s.endLine - s.line + 1;
  const kind = s.kind === 'method' ? 'method' : s.kind;
  const sizeNote =
    span > 120
      ? `${n(span)} lines — big enough that it is probably doing several jobs`
      : span > 30
        ? `${n(span)} lines`
        : `${n(span)} lines`;

  // Lead with the author's own words when they left any. It is the only "why" available
  // without spending a token, and it beats anything structural I can say about the shape.
  const said = s.doc ? `The author says: “${s.doc}” ` : '';
  const reach = s.exported
    ? `It is public, so other files can call it — changing its shape reaches beyond ${path.basename(file)}.`
    : `It is private to ${path.basename(file)}, so it can be changed in place.`;

  return {
    title: s.name,
    text: `${said}${said ? '' : `A ${kind} at line ${n(s.line)}. `}${said ? `${n(span)} lines, from line ${n(s.line)}. ` : `${sizeNote}. `}${reach}`,
  };
}

/**
 * Split a long definition into sections a reader can actually be walked through.
 *
 * One stop on a 120-line function is not a walkthrough — it is a summary you nod at and
 * move past. Cuts land on blank lines inside the body, which is where the author already
 * separated one thought from the next, so no section starts mid-statement.
 */
function sectionsOf(
  lines: string[], start: number, end: number, target = 45, maxSections = 3,
): Array<{ start: number; end: number }> {
  const span = end - start + 1;
  if (span <= target * 1.4) return [{ start, end }];

  const breaks: number[] = [];
  for (let i = start + 1; i < end; i++) {
    if ((lines[i - 1] ?? '').trim() === '') breaks.push(i);
  }
  if (breaks.length === 0) return [{ start, end }];

  const wanted = Math.min(maxSections, Math.max(2, Math.round(span / target)));
  const cuts: number[] = [];
  for (let k = 1; k < wanted; k++) {
    const ideal = start + Math.round((span * k) / wanted);
    const nearest = breaks.reduce((best, b) =>
      Math.abs(b - ideal) < Math.abs(best - ideal) ? b : best, breaks[0]!);
    if (!cuts.includes(nearest) && nearest > start + 4 && nearest < end - 4) cuts.push(nearest);
  }
  cuts.sort((a, b) => a - b);

  const out: Array<{ start: number; end: number }> = [];
  let from = start;
  for (const cut of cuts) {
    out.push({ start: from, end: cut - 1 });
    from = cut;
  }
  out.push({ start: from, end });
  return out;
}

export interface CodeTourOptions {
  /** how many files the tour visits */
  maxFiles?: number;
  /** stops per file, including the file's opening stop */
  perFile?: number;
}

export interface CodeTourPlan {
  steps: CodeStep[];
  /** the files whose full text must be embedded for the tour to work */
  itinerary: string[];
}

/**
 * Plan a tour across a repository.
 *
 * The itinerary is chosen BEFORE any stops are allocated, and every file on it gets the
 * same budget. An earlier version walked files in rank order and stopped when it ran out
 * of steps, which meant the top-ranked file swallowed half the tour (7 of 14 stops on
 * autoSQL's app.py) and everything after it got a single "here is a file" nod. A tour
 * that spends half its time in one file has not shown you a system.
 */
export function buildCodeTour(result: DigestResult, opts: CodeTourOptions = {}): CodeTourPlan {
  const maxFiles = opts.maxFiles ?? 8;
  const perFile = Math.max(2, opts.perFile ?? 3);

  const m = result.manifest;
  const repoName = path.basename(m.root) || m.root;
  const rev = importersOf(result);
  const extractByPath = new Map(result.extracts.map((e) => [e.path, e] as const));
  const fileByPath = new Map(result.inventory.files.map((f) => [f.path, f] as const));

  // Only files we can actually show code for, and that have something inside worth stopping at.
  const candidates = result.ranked.filter((r) => {
    const f = fileByPath.get(r.path);
    const ex = extractByPath.get(r.path);
    return r.score > 0 && f && !f.binary && f.loc > 0 && ex && ex.symbols.length > 0;
  });
  if (candidates.length === 0) return { steps: [], itinerary: [] };

  // ---- 1. choose the itinerary first
  const entry = candidates[0]!;
  const hub = candidates
    .slice()
    .sort((a, b) => b.inDegree - a.inDegree)
    .find((r) => r.inDegree > 0 && r.path !== entry.path);

  const roles = new Map<string, 'entry' | 'hub' | 'other'>();
  const itinerary: string[] = [entry.path];
  roles.set(entry.path, 'entry');
  if (hub) { itinerary.push(hub.path); roles.set(hub.path, 'hub'); }

  // Fill in rank order, but cap how many files any one directory contributes.
  //
  // The cap is a TIEBREAKER, not an override. An earlier version preferred any file from
  // an unseen directory, which dragged in `spikes/` and a vendor test while skipping
  // autoSQL's builder.py and legality.py — the 8th and 9th most important files in the
  // repo. Rank decides what matters; the cap only stops a tour becoming a tour of one
  // folder. The second pass drops the cap so the itinerary always fills.
  const perDir = new Map<string, number>();
  for (const p of itinerary) {
    const d = path.posix.dirname(p);
    perDir.set(d, (perDir.get(d) ?? 0) + 1);
  }
  // Deliberately LOOSE: no single directory supplies more than half the tour, and rank
  // decides everything else. Tighter caps were tried and each one traded one bad outcome
  // for another — a cap of 3 dropped autoSQL's legality.py (rank 9) for a spike at rank
  // 17. This only bites on the pathological case it exists for: a tour of one folder.
  const dirCap = Math.max(2, Math.ceil(maxFiles / 2));

  for (const capped of [true, false]) {
    for (const c of candidates) {
      if (itinerary.length >= maxFiles) break;
      if (itinerary.includes(c.path)) continue;
      const dir = path.posix.dirname(c.path);
      if (capped && (perDir.get(dir) ?? 0) >= dirCap) continue;
      itinerary.push(c.path);
      roles.set(c.path, 'other');
      perDir.set(dir, (perDir.get(dir) ?? 0) + 1);
    }
  }

  // ---- 2. every file on the itinerary gets the same budget
  const rankByPath = new Map(candidates.map((r) => [r.path, r] as const));
  const steps: CodeStep[] = [];

  for (const filePath of itinerary) {
    const r = rankByPath.get(filePath)!;
    const ex = extractByPath.get(filePath)!;
    const role = roles.get(filePath) ?? 'other';
    const loc = fileByPath.get(filePath)?.loc ?? 0;

    const importers = rev.get(filePath) ?? [];
    const internalImports = ex.imports.filter((i) => i.resolved !== null);
    const firstCode = ex.symbols.length ? Math.max(1, ex.symbols[0]!.line - 1) : 1;
    const openingEnd = Math.min(Math.max(Math.min(firstCode, 24), 6), Math.max(loc, 1));

    const roleLine =
      role === 'entry'
        ? `This is where I would start reading. Of ${n(m.counts.files)} files, this one ranked first: ` +
          `${plural(r.churn, 'commit')} touched it and it is ${n(r.loc)} lines.`
        : role === 'hub'
          ? `${plural(importers.length, 'other file')} in this repo import this one. ` +
            `It is load-bearing — the rest of the system leans on it.`
          : `${n(r.loc)} lines, ${plural(r.churn, 'commit')}` +
            (importers.length ? `, imported by ${plural(importers.length, 'file')}.` : '.');

    const importLine = internalImports.length
      ? `It pulls in ${plural(internalImports.length, 'module')} from inside this repo` +
        (internalImports.length <= 4
          ? `: ${internalImports.map((i) => i.raw).join(', ')}.`
          : `, including ${internalImports.slice(0, 3).map((i) => i.raw).join(', ')}.`)
      : ex.imports.length
        ? `Everything it imports comes from outside this repo — ${plural(ex.imports.length, 'external dependency', 'external dependencies')}.`
        : 'It imports nothing.';

    steps.push({
      file: filePath, startLine: 1, endLine: openingEnd,
      title: path.basename(filePath),
      text: `${roleLine} ${importLine}`,
    });

    let budget = perFile - 1; // the opening stop is spent
    let srcLines: string[] = [];
    try { srcLines = fs.readFileSync(path.join(m.root, filePath), 'utf8').split(/\r?\n/); } catch { /* one stop per symbol */ }

    for (const sym of headlineSymbols(ex.symbols, budget)) {
      if (budget <= 0) break;
      const d = describeSymbol(sym, filePath);
      let sections = srcLines.length ? sectionsOf(srcLines, sym.line, sym.endLine) : [{ start: sym.line, end: sym.endLine }];
      // All of a function's sections or none: a stop labelled "(1/3)" whose 2 and 3 were
      // cut is worse than never splitting it.
      if (sections.length > budget) sections = [{ start: sym.line, end: sym.endLine }];

      sections.forEach((sec, idx) => {
        steps.push({
          file: filePath, startLine: sec.start, endLine: sec.end,
          title: sections.length > 1 ? `${d.title} (${idx + 1}/${sections.length})` : d.title,
          text: d.text,
        });
      });
      budget -= sections.length;
    }
  }

  // ---- 3. closing
  const publicCount = itinerary.reduce(
    (t, p) => t + (extractByPath.get(p)?.symbols.filter((s) => s.exported).length ?? 0), 0,
  );
  steps.push({
    file: entry.path,
    startLine: 1,
    endLine: Math.min(3, Math.max(fileByPath.get(entry.path)?.loc ?? 3, 1)),
    title: `That is the spine of ${repoName}`,
    synthetic: true,
    text:
      `${plural(itinerary.length, 'file')}, ${plural(publicCount, 'public symbol')}, out of ` +
      `${n(m.counts.files)} files in the tree. These are the ones churn, imports and structure ` +
      `agree carry the most weight — not the whole repo, but the part you would have had to ` +
      `find yourself before you could read any of the rest. Everything else is still in the ` +
      `tree on the left; the tour picked a path through it, it did not hide the rest.`,
  });

  return { steps, itinerary };
}
