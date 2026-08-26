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

export interface CodeTourOptions {
  /** how many files to embed and walk */
  maxFiles?: number;
  maxSteps?: number;
}

export interface CodeTourPlan {
  steps: CodeStep[];
  /** the files whose full text must be embedded for the tour to work */
  itinerary: string[];
}

export function buildCodeTour(result: DigestResult, opts: CodeTourOptions = {}): CodeTourPlan {
  const maxFiles = opts.maxFiles ?? 6;
  const maxSteps = opts.maxSteps ?? 14;

  const m = result.manifest;
  const repoName = path.basename(m.root) || m.root;
  const rev = importersOf(result);
  const extractByPath = new Map(result.extracts.map((e) => [e.path, e] as const));
  const fileByPath = new Map(result.inventory.files.map((f) => [f.path, f] as const));

  // Only files we can actually show code for.
  const candidates = result.ranked.filter((r) => {
    const f = fileByPath.get(r.path);
    return r.score > 0 && f && !f.binary && f.loc > 0 && extractByPath.has(r.path);
  });

  const steps: CodeStep[] = [];
  const itinerary: string[] = [];

  const entry = candidates[0];
  if (!entry) return { steps, itinerary };

  // The hub: what the most other files import. Often not the same as the entry point.
  const hub = candidates
    .slice()
    .sort((a, b) => b.inDegree - a.inDegree)
    .find((r) => r.inDegree > 0 && r.path !== entry.path);

  const walk = (r: RankedFile, role: 'entry' | 'hub' | 'other'): void => {
    if (itinerary.includes(r.path)) return;
    if (itinerary.length >= maxFiles) return;
    const ex = extractByPath.get(r.path);
    if (!ex) return;
    itinerary.push(r.path);

    const importers = rev.get(r.path) ?? [];
    const internalImports = ex.imports.filter((i) => i.resolved !== null);
    const firstCode = ex.symbols.length ? Math.max(1, ex.symbols[0]!.line - 1) : 1;

    // --- the file's opening: what it depends on
    // Clamp to the file's real length: a 3-line module has no line 6 to point at, and a
    // spotlight anchored past EOF has nothing to bind to.
    const loc = fileByPath.get(r.path)?.loc ?? 0;
    const openingEnd = Math.min(firstCode, 24, Math.max(loc, 1));
    const roleLine =
      role === 'entry'
        ? `This is where I would start reading. Of ${n(m.counts.files)} files, this one ranked first: ` +
          `${plural(r.churn, 'commit')} touched it and it is ${n(r.loc)} lines.`
        : role === 'hub'
          ? `${plural(importers.length, 'other file')} in this repo import this one. ` +
            `It is load-bearing — the rest of the system leans on it.`
          : `${n(r.loc)} lines, ${plural(r.churn, 'commit')}.`;

    const importLine = internalImports.length
      ? `It pulls in ${plural(internalImports.length, 'module')} from inside this repo` +
        (internalImports.length <= 4
          ? `: ${internalImports.map((i) => i.raw).join(', ')}.`
          : `, including ${internalImports.slice(0, 3).map((i) => i.raw).join(', ')}.`)
      : ex.imports.length
        ? `Everything it imports comes from outside this repo — ${plural(ex.imports.length, 'external dependency', 'external dependencies')}.`
        : `It imports nothing.`;

    steps.push({
      file: r.path,
      startLine: 1,
      endLine: Math.min(Math.max(openingEnd, 6), Math.max(loc, 1)),
      title: path.basename(r.path),
      text: `${roleLine} ${importLine}`,
    });

    // --- the substantial pieces inside it
    const picks = headlineSymbols(ex.symbols, role === 'other' ? 1 : 3);
    for (const s of picks) {
      if (steps.length >= maxSteps - 1) break;
      const d = describeSymbol(s, r.path);
      steps.push({ file: r.path, startLine: s.line, endLine: s.endLine, title: d.title, text: d.text });
    }
  };

  walk(entry, 'entry');
  if (hub) walk(hub, 'hub');
  for (const c of candidates) {
    if (steps.length >= maxSteps - 1) break;
    if (itinerary.length >= maxFiles) break;
    walk(c, 'other');
  }

  // --- closing step, anchored to the top of the entry file
  const publicCount = itinerary.reduce(
    (t, p) => t + (extractByPath.get(p)?.symbols.filter((s) => s.exported).length ?? 0),
    0,
  );
  steps.push({
    file: entry.path,
    startLine: 1,
    endLine: Math.min(3, Math.max(fileByPath.get(entry.path)?.loc ?? 3, 1)),
    title: `That is the spine of ${repoName}`,
    text:
      `${plural(itinerary.length, 'file')}, ${plural(publicCount, 'public symbol')}, out of ${n(m.counts.files)} files in the tree. ` +
      `Everything I said was read off a parser or off git — which means I can tell you what this code IS, ` +
      `how big it is, what it pulls in and who leans on it, but not yet WHY any of it exists. ` +
      `That last part is the interpret stage, and it has not run.`,
  });

  return { steps: steps.slice(0, maxSteps), itinerary };
}
