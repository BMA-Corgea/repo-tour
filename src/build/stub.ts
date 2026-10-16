/**
 * The scaffold writer — turns a reference file into something that still PARSES with its
 * load-bearing parts hidden (spec §4.5). A stub keeps the signature (the boilerplate a
 * learner would not be asked to invent) and replaces the body with a language-correct
 * placeholder that references the step by number, so the learner's editor shows exactly
 * which decision belongs where. Everything outside `loadBearing` is copied byte-for-byte.
 *
 * This never tries to be clever about a shape it does not recognize. TS/JS pairs every
 * bracket in the range and hides the inside of ONE matched pair, keeping everything before it
 * and everything from its own closer on, or turns an arrow's expression into a block; which
 * pair is the body depends on what the range declares (`stubJsLikeRange`). Python
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

/** A `{ … }`, or a list literal `[ … ]`, that the scan matched: offsets into the range's text, and what surrounds it. */
interface Group {
  kind: '{' | '[';
  open: number;
  close: number;
  /** how many brackets enclose it */
  depth: number;
  /** every one of them is a `(`: none is a `[`, a `{` or a template's `${` */
  inParens: boolean;
  /** it sits inside a generic's `<…>`: a type argument, never a body */
  inAngle: boolean;
  /** a type, not a value: after an annotation's `:`, or after `as`, `satisfies`, `extends` or `implements` */
  typeLiteral: boolean;
}

/** A `=>`, and where the expression after it ends. */
interface Arrow {
  at: number;
  depth: number;
  inParens: boolean;
  inAngle: boolean;
  /** its body is a block (`=> {`), which the scan already reports as a `Group` */
  blockBody: boolean;
  /**
   * It is the first branch of a conditional (`c ? () => a : b`), so its expression ends at a `:`
   * the arrow rule does not look for. Such an arrow is never cut.
   */
  inConsequent: boolean;
  /**
   * Where its expression ends: a `;` beside it or the closer of the bracket around it, else the
   * range's end. Never a `,` beside it: running on to the closer only drops what the stub drops
   * anyway. JSX text, whose commas and semicolons once ended an arrow early, is read as text.
   */
  end: number | null;
}

interface JsScan {
  groups: Group[];
  arrows: Arrow[];
  /** the first `=` at depth 0 outside a generic's `<…>` — where a variable's or a type's value starts — or -1 */
  assignAt: number;
  /** the first conditional `?` at depth 0 (`T extends U ? A : B`), or -1 */
  conditionalAt: number;
  /** the first `;` at depth 0 after `assignAt`: where that statement ends, when more follow on its line — or -1 */
  statementEndAt: number;
}

/** Where a `<` may open a JSX element: where an expression may start. */
const JSX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '>']);
const JSX_AFTER_WORD = new Set(['return', 'yield', 'default']);

/**
 * After one of these, a `/` starts a regex; after anything else it divides. `<` is not one: `</`
 * closes a JSX tag. Two more exceptions live in the scan: `/>` after a `}` ends a JSX tag
 * (`attr={x} />`), and a `!` straight after a value is TypeScript's non-null assertion
 * (`sum[0]! / n`), which leaves the `/` a division.
 */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '>']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** After one of these words, a `{` or `[` is a type: `x as { … }`, `class A extends B<…>`. */
const TYPE_AFTER_WORD = new Set(['as', 'satisfies', 'extends', 'implements']);
const CLOSER_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

/**
 * Pair every bracket in a TS/JS range, the way the language reads it: past comments, quotes,
 * template literals (their `${ … }` included) and regex literals (told from a division by the
 * token before the `/`). Returns null — "unsure" — when a closer has no opener or closes the
 * wrong kind, a bracket or a template is still open at the end of the range, or a block comment
 * never ends. Removing the inside of a pair this scan matched cannot unbalance the range.
 *
 * Two readings are approximate, and both only ever narrow what may be cut: a `<` straight after
 * a name opens a generic's `<…>` (dropped again at a `;`, a conditional's `?` or an outer closer,
 * so a comparison like `i<n` costs nothing), and a quote that reaches the end of its line ends
 * there (JavaScript has no multi-line quotes).
 *
 * With `jsx` (a `.tsx` or `.js` file), a `<` where an expression may start, followed by a tag
 * name, opens a JSX element. Its tag holds attributes (whose strings may span lines), its children
 * are text up to a `<` or a `{`, and every `{ … }` inside it is a container that is never a body.
 * So an apostrophe, a URL or a `1)` in what the page says is read as the text it is.
 */
function scanJs(text: string, jsx: boolean, ends?: { inCode: boolean }): JsScan | null {
  const stack: Array<{ ch: string; at: number; depth: number; inParens: boolean; inAngle: boolean; typeLiteral: boolean; inTag?: boolean }> = [];
  let notParens = 0; // stack entries that are not a `(`
  const angles: number[] = []; // the stack depth at which each open generic `<` was seen
  const ternaries: number[] = [0]; // the conditional `?`s still waiting for their `:`, per bracket level
  const groups: Group[] = [];
  const arrows: Arrow[] = [];
  const openArrows = new Map<number, Arrow[]>(); // expression-bodied arrows still running, by depth
  let assignAt = -1;
  let statementEndAt = -1;
  let conditionalAt = -1;
  let inTemplate = false;
  let prev = ''; // the last significant character; 'w' after a word or any other value
  let word = '';
  let typeColon = false; // the last `:` was an annotation's, not a conditional's

  const push = (ch: string, at: number): void => {
    const typeLiteral = (prev === ':' && typeColon) || (prev === 'w' && TYPE_AFTER_WORD.has(word));
    stack.push({ ch, at, depth: stack.length, inParens: notParens === 0, inAngle: angles.length > 0, typeLiteral });
    if (ch !== '(') notParens++;
    ternaries.push(0);
  };
  const dropAngles = (above: number): void => {
    while (angles.length > 0 && angles[angles.length - 1]! >= above) angles.pop();
  };
  // The text ends inside a template, a comment, a JSX attribute string or a JSX element, not in plain code.
  const notCode = (): null => {
    if (ends) ends.inCode = false;
    return null;
  };
  const pop = (at: number) => {
    // A closer at an arrow's own depth closes the bracket around it, which ends its expression.
    for (const a of openArrows.get(stack.length) ?? []) a.end = at;
    openArrows.delete(stack.length);
    const open = stack.pop();
    if (!open) return null;
    if (open.ch !== '(') notParens--;
    ternaries.pop();
    dropAngles(stack.length + 1);
    return open;
  };
  // After a JSX element closes, the code around it (if any) has just seen a value.
  const afterElement = (): void => {
    prev = 'w';
    word = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const top = stack[stack.length - 1];

    if (!inTemplate && top?.ch === '<jsx') {
      if (top.inTag) {
        if (ch === '/' && text[i + 1] === '>') { pop(i); i++; if (stack[stack.length - 1]?.ch !== '<jsx') afterElement(); }
        else if (ch === '/' && text[i + 1] === '/') { const eol = text.indexOf('\n', i); i = eol === -1 ? text.length : eol; } // a comment between attributes
        else if (ch === '/' && text[i + 1] === '*') {
          const close = text.indexOf('*/', i + 2);
          if (close === -1) return notCode();
          i = close + 1;
        } else if (ch === '>') top.inTag = false;
        else if (ch === '"' || ch === "'") {
          const close = text.indexOf(ch, i + 1); // a JSX attribute string has no escapes and may span lines
          if (close === -1) return notCode();
          i = close;
        } else if (ch === '{') push('{jsx', i);
        else if (ch === '<' && /[A-Za-z_$]/.test(text[i + 1] ?? '')) { push('<jsx', i); stack[stack.length - 1]!.inTag = true; }
      } else if (ch === '{') push('{jsx', i);
      else if (ch === '<' && text[i + 1] === '/') {
        const close = text.indexOf('>', i + 2);
        if (close === -1) return notCode();
        pop(i);
        i = close;
        if (stack[stack.length - 1]?.ch !== '<jsx') afterElement();
      } else if (ch === '<' && /[A-Za-z_$>]/.test(text[i + 1] ?? '')) {
        push('<jsx', i);
        stack[stack.length - 1]!.inTag = true;
      }
      continue; // anything else in a tag is an attribute's name or `=`, and in children it is text
    }

    if (inTemplate) {
      if (ch === '\\') i++;
      else if (ch === '`') { inTemplate = false; prev = 'w'; word = ''; }
      else if (ch === '$' && text[i + 1] === '{') {
        push('${', i + 1);
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
      if (close === -1) return notCode();
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
      const regex = (prev === '' || REGEX_AFTER.has(prev) || (prev === 'w' && REGEX_AFTER_WORD.has(word)))
        && !(prev === '}' && text[i + 1] === '>');
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
      // A `[` straight after a value indexes it (`a[0]`, `T[]`); only one after anything else is a list.
      const list = ch === '[' && !(prev === ')' || prev === ']' || prev === '}' || (prev === 'w' && !REGEX_AFTER_WORD.has(word)));
      push(ch === '[' && !list ? '[index' : ch, i);
      prev = ch;
      word = '';
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      const open = pop(i);
      if (!open) return null;
      if (open.ch === '${') {
        if (ch !== '}') return null;
        inTemplate = true;
        continue;
      }
      if (open.ch === '{jsx') {
        if (ch !== '}') return null;
        continue; // back in the element's tag or children
      }
      if (CLOSER_OF[open.ch === '[index' ? '[' : open.ch] !== ch) return null;
      if (open.ch === '{' || open.ch === '[') {
        groups.push({
          kind: open.ch, open: open.at, close: i, depth: open.depth,
          inParens: open.inParens, inAngle: open.inAngle, typeLiteral: open.typeLiteral,
        });
      }
      prev = ch;
      word = '';
      continue;
    }

    if (ch === '=' && text[i + 1] === '>') {
      let next = i + 2;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      const arrow: Arrow = {
        at: i, depth: stack.length, inParens: notParens === 0, inAngle: angles.length > 0,
        blockBody: text[next] === '{', inConsequent: ternaries[ternaries.length - 1]! > 0, end: null,
      };
      arrows.push(arrow);
      if (!arrow.blockBody) openArrows.set(stack.length, [...(openArrows.get(stack.length) ?? []), arrow]);
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

    // A JSX element, where an expression may start. `<T,>(` and `<T extends U>(` are a generic arrow's type parameters.
    if (ch === '<' && jsx && (JSX_AFTER.has(prev) || (prev === 'w' && JSX_AFTER_WORD.has(word)))
      && /[A-Za-z_$>]/.test(text[i + 1] ?? '') && !/^<[A-Za-z_$][\w$]*\s*(?:,|extends\b)/.test(text.slice(i, i + 64))) {
      push('<jsx', i);
      stack[stack.length - 1]!.inTag = true;
      continue;
    }

    // A `!` straight after a value is a non-null assertion, not a `not`: the value is still the last thing seen.
    if (ch === '!' && text[i + 1] !== '=' && (prev === ')' || prev === ']' || (prev === 'w' && !REGEX_AFTER_WORD.has(word)))) continue;
    // A `<` straight after a name, or after a `=` where no JSX began (`type F = <T>(x: T) => T`), opens a generic's
    // `<…>`; its `>` closes it. A `;` or an outer closer ends a comparison taken for one.
    if (ch === '<' && ((i > 0 && isWordChar(text[i - 1]!)) || prev === '=')) angles.push(stack.length);
    if (ch === '>' && text[i + 1] !== '=' && angles.length > 0 && angles[angles.length - 1] === stack.length) angles.pop();
    if (ch === ';') {
      // A `;` beside an arrow ends its expression, as a closer does. (JSX text is read as text, so its `;` never gets here.)
      for (const a of openArrows.get(stack.length) ?? []) a.end = i;
      openArrows.delete(stack.length);
      dropAngles(stack.length);
      if (stack.length === 0 && assignAt !== -1 && statementEndAt === -1) statementEndAt = i;
    }
    // `?.` and `??` are not a conditional's `?`; every conditional `?` is answered by a `:` at its own level.
    if (ch === '?' && text[i + 1] !== '.' && text[i + 1] !== '?' && prev !== '?') {
      ternaries[ternaries.length - 1]!++;
      dropAngles(stack.length);
      if (stack.length === 0 && conditionalAt === -1) conditionalAt = i;
    }
    if (ch === ':') {
      typeColon = !(ternaries[ternaries.length - 1]! > 0);
      if (!typeColon) ternaries[ternaries.length - 1]!--;
    }
    if (ch === '=' && assignAt === -1 && stack.length === 0 && angles.length === 0
      && text[i + 1] !== '=' && !'=!<>+-*/%&|^?'.includes(text[i - 1] ?? '')) assignAt = i;
    prev = ch;
    word = '';
  }

  if (inTemplate || stack.some((o) => o.ch === '${' || o.ch === '<jsx')) return notCode();
  if (stack.length > 0) return null;
  const trimmed = text.trimEnd();
  const rangeEnd = trimmed.endsWith(';') ? trimmed.length - 1 : text.length;
  for (const a of arrows) if (a.end === null) a.end = rangeEnd;
  return { groups, arrows, assignAt, conditionalAt, statementEndAt };
}

/**
 * Whether line `startLine` begins in plain code. A range is scanned on its own, so a range whose
 * first line begins inside a template, a comment or JSX that opened earlier (a minified bundle
 * puts a declaration right after a template's closing backtick) would be read with code and
 * template swapped. The file is scanned from line 1 up to the range; only a scan that ends
 * inside one of those says no. One that cannot read the lines before (a misread) changes
 * nothing.
 */
function startsInCode(lines: string[], startLine: number, jsx: boolean): boolean {
  if (startLine <= 1) return true;
  const ends = { inCode: true };
  scanJs(`${lines.slice(0, startLine - 1).join('\n')}\n`, jsx, ends);
  return ends.inCode;
}

/** The leading whitespace of the line that holds offset `at`. */
function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** Hide the inside of one matched pair: everything through its opener, the TODO line, everything from its own closer on. */
function cutPair(text: string, g: Group, todo: string): string {
  const closeLineStart = text.lastIndexOf('\n', g.close) + 1;
  const tail = text.slice(closeLineStart, g.close).trim() === '' ? text.slice(closeLineStart) : text.slice(g.close);
  return `${text.slice(0, g.open + 1)}\n${indentAt(text, g.open)}  ${todo}\n${tail}`;
}

/** Turn an arrow's expression body into a block, keeping whatever followed the expression. */
function cutArrow(text: string, a: Arrow, todo: string): string {
  const indent = indentAt(text, a.at);
  return `${text.slice(0, a.at + 2)} {\n${indent}  ${todo}\n${indent}}${text.slice(a.end!)}`;
}

/** `type X = …`, `export declare type X<T> = …`. */
const TYPE_ALIAS = /^\s*(?:export\s+)?(?:declare\s+)?type\s+[A-Za-z_$]/;
/** `const x = …`, `export let x: T = …`; not `const enum`. */
const VARIABLE = /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(?!enum\b)/;

/**
 * Replace one range of a TS/JS/TSX file. Which pair holds the body depends on what the range
 * declares, and only pairs inside nothing but parentheses are ever candidates (a `[ … ]` element,
 * a `{ … }` member and a template's `${ … }` are all part of something bigger):
 *
 *   - A function, class, interface, enum or method: its LAST top-level `{ … }`. Its body comes
 *     after its signature, return type, heritage and decorators; a type argument (`<…>`) and a
 *     return-type literal are never it.
 *   - A variable: only what follows its top-level `=`, never its type annotation, a type
 *     argument or a return-type literal. The shallowest candidate, the biggest on a tie: an
 *     arrow's expression body (on any line), or a block — the module pattern's function, a
 *     callback, an `extend({ … })` object. A list of records is hidden whole, and only when
 *     nothing else is there (`[1, 2].map((n) => …)` hides the callback).
 *   - A type alias: main's own cut from its first top-level `{` (every union member goes with
 *     it, and a range-final `;` stays); a function type's return type; or, inside a generic, the
 *     pair itself, so `Readonly<{ … }>` keeps its `}>;`.
 *
 * An arrow that is a conditional's first branch is never cut, and a range the scan cannot read is
 * left exactly as it was. The TODO line sits two spaces inside the line it opens, and a closing
 * line keeps its own indentation, so a function inside a wrapper still reads as one.
 */
function stubJsLikeRange(lines: string[], start: number, end: number, language: string, questions: StubQuestion[], index: number): string[] {
  const untouched = lines.slice(start - 1, end);
  const text = untouched.join('\n');
  const scan = scanJs(text, language !== 'typescript');
  if (scan === null) return untouched;
  const todo = todoLine('//', questions, index);
  const out = VARIABLE.test(text) ? stubValue(text, scan, todo)
    : TYPE_ALIAS.test(text) ? stubTypeAlias(text, scan, todo)
    : stubDeclarationBody(text, scan, todo);
  return out === null ? untouched : out.split('\n');
}

function stubDeclarationBody(text: string, scan: JsScan, todo: string): string | null {
  const tops = scan.groups.filter((g) => g.kind === '{' && g.depth === 0 && !g.inAngle && !g.typeLiteral);
  return tops.length > 0 ? cutPair(text, tops[tops.length - 1]!, todo) : null;
}

function stubValue(text: string, scan: JsScan, todo: string): string | null {
  if (scan.assignAt === -1) return null;
  // Only the variable's own statement: a minified line holds the statements after it too, and they are not its body.
  const end = scan.statementEndAt === -1 ? Infinity : scan.statementEndAt;
  const inValue = (at: number, inParens: boolean, inAngle: boolean): boolean => at > scan.assignAt && at < end && inParens && !inAngle;
  type Candidate = { start: number; end: number; depth: number; cut: () => string };
  const candidates: Candidate[] = [
    ...scan.groups
      .filter((g) => g.kind === '{' && !g.typeLiteral && inValue(g.open, g.inParens, g.inAngle))
      .map((g) => ({ start: g.open, end: g.close, depth: g.depth, cut: () => cutPair(text, g, todo) })),
    ...scan.arrows
      .filter((a) => !a.blockBody && !a.inConsequent && inValue(a.at, a.inParens, a.inAngle))
      .map((a) => ({ start: a.at, end: a.end!, depth: a.depth, cut: () => cutArrow(text, a, todo) })),
  ];
  const chosen = pick(candidates) ?? pick(scan.groups
    .filter((g) => g.kind === '[' && !g.typeLiteral && inValue(g.open, g.inParens, g.inAngle))
    .map((g) => ({ start: g.open, end: g.close, depth: g.depth, cut: () => cutPair(text, g, todo) })));
  return chosen ? chosen.cut() : null;
}

/**
 * The shallowest candidate, then the biggest, then the first. A candidate inside another at the
 * same depth (a block in an arrow's expression) is always the smaller, so it is never the pick.
 */
function pick<C extends { start: number; end: number; depth: number }>(candidates: C[]): C | null {
  let best: C | null = null;
  for (const c of candidates) {
    if (!best || c.depth < best.depth || (c.depth === best.depth && c.end - c.start > best.end - best.start)) best = c;
  }
  return best;
}

function stubTypeAlias(text: string, scan: JsScan, todo: string): string | null {
  if (scan.assignAt === -1) return null;
  const blocks = scan.groups.filter((g) => g.kind === '{' && g.open > scan.assignAt && g.inParens);
  const top = blocks.find((g) => g.depth === 0 && !g.inAngle);
  if (top && scan.conditionalAt > scan.assignAt) return cutPair(text, top, todo); // a conditional type keeps its `? … : …`
  if (top) {
    // Main's cut, which hid a whole union: what follows this `{` at the top level is complete
    // groups (`| { … }`, `& Reason`, `[]`), so dropping it with the inside keeps the range balanced.
    const semicolon = text.trimEnd().endsWith(';') ? ';' : '';
    return `${text.slice(0, top.open + 1)}\n${indentAt(text, top.open)}  ${todo}\n}${semicolon}`;
  }
  // A function type's arrow, but never one in a conditional type's check (`T extends (x: infer I) => R ? A : B`):
  // its return type ends at that `?`, which the arrow rule does not look for.
  const inCheck = (at: number): boolean => scan.conditionalAt > scan.assignAt && at < scan.conditionalAt;
  const fnType = scan.arrows.find((a) => a.at > scan.assignAt && a.depth === 0 && !a.inAngle && !a.blockBody && !a.inConsequent && !inCheck(a.at));
  if (fnType) return cutArrow(text, fnType, todo);
  const inner = blocks.slice().sort((a, b) => a.depth - b.depth || a.open - b.open)[0];
  return inner ? cutPair(text, inner, todo) : null;
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
      out.push(...(startsInCode(lines, range.startLine, language !== 'typescript')
        ? stubJsLikeRange(lines, range.startLine, range.endLine, language, questions, range.originalIndex)
        : lines.slice(range.startLine - 1, range.endLine)));
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
