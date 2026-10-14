/**
 * The scaffold writer — turns a reference file into something that still PARSES with its
 * load-bearing parts hidden (spec §4.5). A stub keeps the signature (the boilerplate a
 * learner would not be asked to invent) and replaces the body with a language-correct
 * placeholder that references the step by number, so the learner's editor shows exactly
 * which decision belongs where. Everything outside `loadBearing` is copied byte-for-byte.
 *
 * This never tries to be clever about a shape it does not recognize. TS/JS pairs every
 * bracket in the range and hides the inside of ONE matched pair `{ … }`, keeping everything
 * before its `{` and everything from its own `}` on; failing that, it turns the arrow on the
 * range's first line into a block, keeping whatever follows the arrow's expression. Python
 * finds the colon that ends the header and then writes whichever body shape that header
 * already has — a same-line `raise` for an inline body, an indented one (measured, never
 * assumed) for a block. Anything neither pattern fits — a bare exported constant with no
 * body to hide, a range the bracket scan cannot read — is left completely untouched. A stub
 * that occasionally under-hides content is a cosmetic gap; a stub that occasionally emits
 * invalid syntax defeats AC5 outright, so every fallback in this file resolves toward "leave
 * it alone", never toward a guess.
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

/** A `{ … }` the scan matched: offsets into the range's text, and the brackets around it. */
interface Block {
  open: number;
  close: number;
  /** how many brackets enclose it */
  depth: number;
  /** every one of them is a `(`: none is a `[`, a `{` or a template's `${` */
  inParens: boolean;
}

/** A `=>` on the range's first line, and where the expression after it ends. */
interface Arrow {
  at: number;
  depth: number;
  inParens: boolean;
  /** its body is a block (`=> {`), which the scan already reports as a `Block` */
  blockBody: boolean;
  /**
   * Where its expression ends: the closer of the bracket around it, else the range's own final
   * `;`, else the range's end. Never a `,` or `;` beside it: JSX text holds both freely
   * (`() => <p>Hello, world</p>`), and running on to the closer only drops what the stub drops
   * anyway.
   */
  end: number | null;
}

/** After one of these, a `/` starts a regex; after anything else it divides. `<` is not one: `</` closes a JSX tag. */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '>']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const CLOSER_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

/**
 * Pair every bracket in a TS/JS range, the way the language reads it: past comments, quotes,
 * template literals (their `${ … }` included) and regex literals (told from a division by the
 * token before the `/`). Returns null — "unsure" — when a closer has no opener, a bracket or a
 * template is still open at the end of the range, or a block comment never ends. That is what
 * makes every cut below safe: removing the inside of a pair this scan matched cannot unbalance
 * anything, and a range it cannot read is never cut at all.
 *
 * One deliberate leniency: a quote that reaches the end of its line ends there. JavaScript has
 * no multi-line quotes, so the only way to get there is JSX text (`<p>Don't</p>`), whose
 * apostrophe opens nothing.
 */
function scanJs(text: string): { blocks: Block[]; arrows: Arrow[] } | null {
  const stack: Array<{ ch: string; at: number; depth: number; inParens: boolean }> = [];
  const blocks: Block[] = [];
  const arrows: Arrow[] = [];
  const firstLineEnd = text.includes('\n') ? text.indexOf('\n') : text.length;
  let inTemplate = false;
  let prev = ''; // the last significant character; 'w' after a word or any other value
  let word = '';

  const allParens = (): boolean => stack.every((o) => o.ch === '(');
  // A closer at an arrow's own depth closes the bracket around it, which ends its expression.
  const endArrowsHere = (at: number): void => {
    for (const a of arrows) if (a.end === null && !a.blockBody && a.depth === stack.length) a.end = at;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inTemplate) {
      if (ch === '\\') i++;
      else if (ch === '`') { inTemplate = false; prev = 'w'; word = ''; }
      else if (ch === '$' && text[i + 1] === '{') {
        stack.push({ ch: '${', at: i + 1, depth: stack.length, inParens: false });
        inTemplate = false;
        prev = '{';
        i++;
      }
      continue;
    }

    if (/\s/.test(ch)) continue;

    if (ch === '/' && text[i + 1] === '/') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? text.length : eol;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j;
      prev = 'w';
      word = '';
      continue;
    }

    if (ch === '`') { inTemplate = true; continue; }

    if (ch === '/') {
      const regex = (prev === '' || REGEX_AFTER.has(prev) || (prev === 'w' && REGEX_AFTER_WORD.has(word))) && text[i + 1] !== '>';
      if (regex) {
        let j = i + 1;
        let inClass = false;
        for (; j < text.length && text[j] !== '\n'; j++) {
          const c = text[j];
          if (c === '\\') j++;
          else if (inClass) { if (c === ']') inClass = false; }
          else if (c === '[') inClass = true;
          else if (c === '/') break;
        }
        if (text[j] === '/') while (j + 1 < text.length && /[A-Za-z]/.test(text[j + 1]!)) j++;
        i = j;
        prev = 'w';
        word = '';
        continue;
      }
      prev = '/';
      word = '';
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ ch, at: i, depth: stack.length, inParens: allParens() });
      prev = ch;
      word = '';
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      endArrowsHere(i);
      const open = stack.pop();
      if (!open) return null;
      if (open.ch === '${') {
        if (ch !== '}') return null;
        inTemplate = true;
        continue;
      }
      if (CLOSER_OF[open.ch] !== ch) return null;
      if (ch === '}') blocks.push({ open: open.at, close: i, depth: open.depth, inParens: open.inParens });
      prev = ch;
      word = '';
      continue;
    }

    if (ch === '=' && text[i + 1] === '>') {
      if (i < firstLineEnd) {
        const rest = text.slice(i + 2).trimStart();
        arrows.push({ at: i, depth: stack.length, inParens: allParens(), blockBody: rest.startsWith('{'), end: null });
      }
      i++;
      prev = '>';
      word = '';
      continue;
    }

    if (isWordChar(ch)) {
      let j = i;
      while (j + 1 < text.length && isWordChar(text[j + 1]!)) j++;
      word = text.slice(i, j + 1);
      prev = 'w';
      i = j;
      continue;
    }

    prev = ch;
    word = '';
  }

  if (inTemplate || stack.length > 0) return null;
  const trimmed = text.trimEnd();
  const rangeEnd = trimmed.endsWith(';') ? trimmed.length - 1 : text.length;
  for (const a of arrows) if (a.end === null) a.end = rangeEnd;
  return { blocks, arrows };
}

/** The leading whitespace of the line that holds offset `at`. */
function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/**
 * Replace one range of a TS/JS/TSX file. The body to hide is chosen from the brackets the scan
 * paired, outermost first, and only among those inside nothing but parentheses: a `[ … ]` is a
 * list, and hiding one element of it would hide the wrong thing.
 *
 *   1. A block: the biggest `{ … }` at the shallowest depth any block reaches (the first, on a
 *      tie). At depth 0 that is a declaration's own body, never a destructured or default
 *      parameter (those sit inside the parameter list's parentheses), and the body rather than a
 *      smaller `Readonly<{ … }>` or return-type literal. With nothing at depth 0 it is what the
 *      declaration hands to a call: the module pattern's function, a callback, an `extend({ … })`
 *      object. Keep everything through its `{`, add the TODO line, then keep everything from its
 *      own `}` to the end of the range, so `})();`, `});` and `}>;` survive.
 *   2. Else the arrow on the range's FIRST line, if it is as shallow as any block: its expression
 *      body becomes a block, and what followed the expression (`);`, a final `;`) is kept. A block
 *      at the same depth wins, because there the arrow is a type (`f(): () => void { … }`).
 *   3. Neither, or a range the scan cannot read: leave the range exactly as it was.
 *
 * The TODO line sits two spaces inside the line it opens, and a closing line keeps its own
 * indentation, so a function inside a wrapper still reads as one.
 */
function stubJsLikeRange(lines: string[], start: number, end: number, questions: StubQuestion[], index: number): string[] {
  const untouched = lines.slice(start - 1, end);
  const text = untouched.join('\n');
  const scan = scanJs(text);
  if (scan === null) return untouched;

  const blocks = scan.blocks.filter((b) => b.inParens);
  const arrows = scan.arrows.filter((a) => a.inParens && !a.blockBody);
  const depth = Math.min(...blocks.map((b) => b.depth), ...arrows.map((a) => a.depth));
  if (depth === Infinity) return untouched;
  const todo = todoLine('//', questions, index);

  const atDepth = blocks.filter((b) => b.depth === depth);
  if (atDepth.length > 0) {
    const body = atDepth.reduce((best, b) => (b.close - b.open > best.close - best.open ? b : best));
    const closeLineStart = text.lastIndexOf('\n', body.close) + 1;
    const tail = text.slice(closeLineStart, body.close).trim() === '' ? text.slice(closeLineStart) : text.slice(body.close);
    return `${text.slice(0, body.open + 1)}\n${indentAt(text, body.open)}  ${todo}\n${tail}`.split('\n');
  }

  const arrow = arrows.find((a) => a.depth === depth)!;
  const indent = indentAt(text, arrow.at);
  return `${text.slice(0, arrow.at + 2)} {\n${indent}  ${todo}\n${indent}}${text.slice(arrow.end!)}`.split('\n');
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
