/**
 * The scaffold writer — turns a reference file into something that still PARSES with its
 * load-bearing parts hidden (spec §4.5). A stub keeps the signature (the boilerplate a
 * learner would not be asked to invent) and replaces the body with a language-correct
 * placeholder that references the step by number, so the learner's editor shows exactly
 * which decision belongs where. Everything outside `loadBearing` is copied byte-for-byte.
 *
 * This never tries to be clever about a shape it does not recognize. TS/JS looks for a
 * brace to open a block; failing that, an arrow to convert into one. Python measures the
 * body's own indentation rather than assuming four spaces. Anything neither pattern fits
 * — a bare exported constant with no body to hide, a signature this simple stubber cannot
 * parse — is left completely untouched. A stub that occasionally under-hides content is a
 * cosmetic gap; a stub that occasionally emits invalid syntax defeats AC5 outright, so
 * every fallback in this file resolves toward "leave it alone", never toward a guess.
 */

import type { Range } from './types.js';

export interface StubQuestion {
  ordinal: number;
  question: string;
}

const JS_LANGUAGES = new Set(['typescript', 'javascript', 'tsx']);

function todoLine(marker: '//' | '#', questions: StubQuestion[], index: number): string {
  const q = questions[index];
  const label = q ? `step ${q.ordinal}` : 'this step';
  const text = q ? q.question : 'fill this in';
  return `${marker} TODO(${label}): ${text}`;
}

/**
 * Replace one range of a TS/JS/TSX file. Three cases, in order of how much of the
 * original signature survives:
 *
 *   1. A `{` appears somewhere in the range (function, method, class, arrow-with-block):
 *      keep everything up to and including it, drop the rest, close with one `}`.
 *   2. No `{` anywhere, but the FIRST line has `=>` (an arrow with an expression body):
 *      keep up to and including `=>`, add a block around the placeholder.
 *   3. Neither: leave the range exactly as it was.
 */
function stubJsLikeRange(lines: string[], start: number, end: number, questions: StubQuestion[], index: number): string[] {
  for (let lineNo = start; lineNo <= end; lineNo++) {
    const text = lines[lineNo - 1] ?? '';
    const braceAt = text.indexOf('{');
    if (braceAt !== -1) {
      const head = text.slice(0, braceAt + 1);
      const prefix = lines.slice(start - 1, lineNo - 1); // any signature lines before the brace line
      return [...prefix, head, `  ${todoLine('//', questions, index)}`, '}'];
    }
  }

  const first = lines[start - 1] ?? '';
  const arrowAt = first.indexOf('=>');
  if (arrowAt !== -1) {
    const head = `${first.slice(0, arrowAt + 2)} {`;
    return [head, `  ${todoLine('//', questions, index)}`, '}'];
  }

  return lines.slice(start - 1, end);
}

/**
 * Replace one range of a Python file: keep the `def`/`class` line, replace the body with
 * one `raise NotImplementedError`, indented to match the body's OWN indentation (measured
 * from the first body line) rather than assumed — the file's own style wins over a
 * convention.
 */
function stubPythonRange(lines: string[], start: number, end: number, questions: StubQuestion[], index: number): string[] {
  const first = lines[start - 1] ?? '';
  const bodyLine = end > start ? (lines[start] ?? '') : '';
  const measured = /^(\s*)\S/.exec(bodyLine)?.[1];
  const defIndent = /^(\s*)/.exec(first)?.[1] ?? '';
  const indent = measured ?? `${defIndent}    `;
  return [first, `${indent}raise NotImplementedError  ${todoLine('#', questions, index)}`];
}

/**
 * Stub `source`, hiding each `loadBearing` range behind a language-correct placeholder.
 * Ranges are sorted and processed independently; everything between and around them is
 * copied verbatim. `questions[i]` describes `loadBearing[i]` — fewer questions than ranges
 * degrades to a generic placeholder rather than throwing, since a caller that only wants
 * the parse-safety property should not be forced to supply narration too.
 */
export function stubFile(source: string, loadBearing: Range[], language: string, questions: StubQuestion[]): string {
  const lines = source.split(/\r?\n/);
  const ranges = loadBearing
    .map((r, originalIndex) => ({ ...r, originalIndex }))
    .sort((a, b) => a.startLine - b.startLine);

  const out: string[] = [];
  let cursor = 1; // next not-yet-emitted 1-indexed line

  for (const range of ranges) {
    if (range.startLine < cursor) continue; // an overlapping/out-of-order range — skip rather than corrupt output
    if (range.startLine > cursor) out.push(...lines.slice(cursor - 1, range.startLine - 1));

    if (JS_LANGUAGES.has(language)) {
      out.push(...stubJsLikeRange(lines, range.startLine, range.endLine, questions, range.originalIndex));
    } else if (language === 'python') {
      out.push(...stubPythonRange(lines, range.startLine, range.endLine, questions, range.originalIndex));
    } else {
      out.push(...lines.slice(range.startLine - 1, range.endLine)); // an unrecognized language — never invent syntax we do not understand
    }
    cursor = range.endLine + 1;
  }

  if (cursor <= lines.length) out.push(...lines.slice(cursor - 1));
  return out.join('\n');
}
