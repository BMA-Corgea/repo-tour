/**
 * The scaffold writer — turns a reference file into something that still PARSES with its
 * load-bearing parts hidden (spec §4.5). A stub keeps the signature (the boilerplate a
 * learner would not be asked to invent) and replaces the body with a language-correct
 * placeholder that references the step by number, so the learner's editor shows exactly
 * which decision belongs where. Everything outside `loadBearing` is copied byte-for-byte.
 *
 * This never tries to be clever about a shape it does not recognize. TS/JS looks for a
 * brace to open a block; failing that, an arrow to convert into one. Python finds the
 * colon that ends the header and then writes whichever body shape that header already has
 * — a same-line `raise` for an inline body, an indented one (measured, never assumed) for
 * a block. Anything neither pattern fits
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

/** A line that opens a Python block this stubber understands: `def`, `async def`, `class`. */
const PY_HEADER = /^\s*(?:async\s+)?(?:def|class)\b/;

/**
 * Where a Python header ends: the first `:` at bracket depth zero and outside any string,
 * scanned from `start`. Depth is what makes this safe — a default argument's dict, a slice,
 * an annotation like `Dict[str, int]`, a `lambda a: a` used as a default all hold colons,
 * and every one of them is inside a bracket, so only the header's own colon is ever at
 * depth zero. Returns null when the range holds no such colon, which is this stubber's
 * signal to leave the range alone rather than guess.
 */
function pythonHeaderColon(lines: string[], start: number, end: number): { line: number; col: number } | null {
  let depth = 0;
  let quote: string | null = null;

  for (let lineNo = start; lineNo <= end; lineNo++) {
    const text = lines[lineNo - 1] ?? '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (quote !== null) {
        if (ch === '\\') { i++; continue; }
        if (text.startsWith(quote, i)) { i += quote.length - 1; quote = null; }
        continue;
      }
      if (ch === '#') break; // a comment runs to the end of the line
      if (ch === '"' || ch === "'") {
        const triple = ch.repeat(3);
        quote = text.startsWith(triple, i) ? triple : ch;
        i += quote.length - 1;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); continue; }
      if (ch === ':' && depth === 0) return { line: lineNo, col: i };
    }
    if (quote !== null && quote.length === 1) quote = null; // a single-quoted string cannot span lines
  }
  return null;
}

/**
 * Replace one range of a Python file: keep the whole header up to and including the colon
 * that ends it, replace the body with one `raise NotImplementedError`.
 *
 * Python has two body shapes and they need different output, which is the defect this
 * function was rewritten for. A BLOCK body (`def f():` then an indented suite) takes an
 * indented `raise` on the next line, indented to match the body's OWN indentation measured
 * from the first body line rather than assumed — the file's style wins over a convention.
 * An INLINE body (`def f(): return 1`, `class X(Exception): pass` — both of which
 * `extract()` genuinely reports with `line === endLine`) must be replaced ON THE SAME
 * LINE: appending an indented line after a header that already has its suite is an
 * `IndentationError`, which tree-sitter's ERROR-node count happily accepts and the real
 * interpreter does not.
 *
 * Scanning for the header's colon rather than assuming it ends the first line also fixes a
 * multi-line signature (`def wide(\n  a,\n  b,\n):`), where keeping only the first line
 * produced `def wide(` — an unterminated bracket, likewise invalid.
 *
 * A range whose header this cannot find (no depth-zero colon; no `def`/`class` line before
 * it) is copied through untouched, the same "leave it alone" resolution as everywhere else
 * in this file.
 */
function stubPythonRange(lines: string[], start: number, end: number, questions: StubQuestion[], index: number): string[] {
  const untouched = lines.slice(start - 1, end);
  const colon = pythonHeaderColon(lines, start, end);
  if (colon === null) return untouched;

  // Where the header actually starts — anything before it inside the range (a decorator,
  // a comment) is copied through verbatim ahead of the stubbed header.
  let headerStart = -1;
  for (let n = start; n <= colon.line; n++) {
    if (PY_HEADER.test(lines[n - 1] ?? '')) { headerStart = n; break; }
  }
  if (headerStart === -1) return untouched;

  const prefix = lines.slice(start - 1, headerStart - 1);
  const headLines = lines.slice(headerStart - 1, colon.line - 1); // a multi-line signature's earlier lines
  const colonLine = lines[colon.line - 1] ?? '';
  const afterColon = colonLine.slice(colon.col + 1).trim();
  const todo = todoLine('#', questions, index);

  // An inline body: replace it where it is, on the header's own line.
  if (afterColon !== '' && !afterColon.startsWith('#')) {
    return [...prefix, ...headLines, `${colonLine.slice(0, colon.col + 1)} raise NotImplementedError  ${todo}`];
  }

  // A block body: measure the suite's own indentation, and never emit an indent that is
  // not deeper than the header's — that would be an IndentationError too.
  const headerIndent = /^(\s*)/.exec(lines[headerStart - 1] ?? '')?.[1] ?? '';
  let measured: string | undefined;
  for (let n = colon.line + 1; n <= end; n++) {
    const m = /^(\s*)\S/.exec(lines[n - 1] ?? '');
    if (m) { measured = m[1]!; break; }
  }
  const indent = measured !== undefined && measured.length > headerIndent.length ? measured : `${headerIndent}    `;
  return [...prefix, ...headLines, colonLine, `${indent}raise NotImplementedError  ${todo}`];
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
