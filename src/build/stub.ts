/**
 * The scaffold writer — turns a reference file into something that still PARSES with its
 * load-bearing parts hidden (spec §4.5). A stub keeps the signature (the boilerplate a
 * learner would not be asked to invent) and replaces the body with a language-correct
 * placeholder that references the step by number, so the learner's editor shows exactly
 * which decision belongs where. Everything outside `loadBearing` is copied byte-for-byte.
 *
 * This never tries to be clever about a shape it does not recognize. TS/JS pairs every
 * bracket in the range and, for each declaration on it, hides the inside of one matched pair,
 * keeping everything before it and everything from its own closer on, or turns an arrow's
 * expression into a block; a type alias's union goes whole, as main cut it. Which pair is a
 * declaration's body depends on what it declares (`stubJsLikeRange`). Python
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
   * It sits in a conditional type's check (`T extends (x: infer I) => R ? A : B`): a depth-0
   * `extends` came after the last conditional `?` or `:`. Its return type ends at the next `?`,
   * which the arrow rule does not look for, so it is never cut.
   */
  inCheck: boolean;
  /**
   * Where its expression ends: a `,` or `;` beside it (outside a generic), or the closer of the
   * bracket around it, else the range's end. JSX text, whose commas and semicolons once ended an
   * arrow early, is read as text, so they never get here.
   */
  end: number | null;
}

interface JsScan {
  groups: Group[];
  /** template literals, from backtick to backtick, with the brackets around them as for a `Group` */
  templates: Array<{ open: number; close: number; depth: number; inParens: boolean; inAngle: boolean }>;
  arrows: Arrow[];
  /** the first `=` at depth 0 outside a generic's `<…>` — where a variable's or a type's value starts — or -1 */
  assignAt: number;
  /** the first conditional `?` at depth 0 (`T extends U ? A : B`), or -1 */
  conditionalAt: number;
  /** the first `;` at depth 0 after `assignAt`: where that statement ends, when more follow on its line — or -1 */
  statementEndAt: number;
  /** the first `,` at depth 0 after `assignAt`, outside a generic: where the first declarator ends — or -1 */
  declaratorEndAt: number;
  /** every `=` at depth 0 outside a generic (`assignAt` is the first), every such `,`, and every `;` at depth 0, in text order */
  assigns: number[];
  commas: number[];
  semis: number[];
}

/** One change to a range's text: `[from, to)` becomes `insert`. */
interface Edit {
  from: number;
  to: number;
  insert: string;
}

/** Where a `<` may open a JSX element: where an expression may start. */
const JSX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '>']);
const JSX_AFTER_WORD = new Set(['return', 'yield', 'default']);

/**
 * After one of these, a `/` starts a regex; after anything else it divides. More exceptions live
 * in the scan: a `!` straight after a value is TypeScript's non-null assertion (`sum[0]! / n`),
 * and `i++` or `i--` leaves a value, so the `/` after either divides; after an `if (…)`,
 * `while (…)` or `for (…)` head a `/` starts a regex. `<` is not one, and `/>` after a `}` is not
 * a regex: the JSX reader handles every tag it opens, so these two only matter after a misread.
 */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '>']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
/** After one of these words, a `{` or `[` is a type: `x as { … }`, `class A extends B<…>`, `v is { … }`. */
const TYPE_AFTER_WORD = new Set(['as', 'satisfies', 'extends', 'implements', 'is']);
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
 * Two readings are approximate: a `<` straight after a name, or after a `=`, opens a generic's
 * `<…>` (dropped again at a `;`, a conditional's `?`, a `&&` or `||`, or an outer closer, so a
 * comparison like `i<n` usually costs little; but inside one a `,` ends neither an arrow nor a
 * declarator, so `=> a<b, gt = …` is cut through to its `;`, as main cut it, and in
 * `var small = n<10, fmt = function () { … }` the declarators after the `<` are never seen), and a
 * quote that reaches the end of its line ends there (JavaScript has no multi-line quotes).
 *
 * With `jsx` (a `.tsx` or `.js` file), a `<` where an expression may start, followed by a tag
 * name, opens a JSX element. Its tag holds attributes (whose strings may span lines), its children
 * are text up to a `<` or a `{`, and every `{ … }` inside it is a container that is never a body.
 * So an apostrophe, a URL or a `1)` in what the page says is read as the text it is.
 */
function scanJs(text: string, jsx: boolean, checkpoints?: { at: number[]; inCode: Map<number, boolean> }): JsScan | null {
  const stack: Array<{
    ch: string; at: number; depth: number; inParens: boolean; inAngle: boolean; typeLiteral: boolean;
    inTag?: boolean; afterKeyword?: boolean;
  }> = [];
  let notParens = 0; // stack entries that are not a `(`
  const angles: number[] = []; // the stack depth at which each open generic `<` was seen
  const ternaries: number[] = [0]; // the conditional `?`s still waiting for their `:`, per bracket level
  const groups: Group[] = [];
  const templates: JsScan['templates'] = [];
  const openTemplates: Array<{ open: number; depth: number; inParens: boolean; inAngle: boolean }> = [];
  const arrows: Arrow[] = [];
  const openArrows = new Map<number, Arrow[]>(); // expression-bodied arrows still running, by depth
  let assignAt = -1;
  let statementEndAt = -1;
  let declaratorEndAt = -1;
  const assigns: number[] = [];
  const commas: number[] = [];
  const semis: number[] = [];
  let conditionalAt = -1;
  let inCheck = false; // a depth-0 `extends` came after the last conditional `?` or `:` (a conditional type's check)
  let singleTypeOp = false; // the last `|` or `&` was a type's union or intersection, not `||` or `&&`
  let afterArrow = false; // the last significant token was a `=>`
  let inTemplate = false;
  let prev = ''; // the last significant character; 'w' after a word or any other value
  let word = '';
  let typeColon = false; // the last `:` was an annotation's, not a conditional's

  const push = (ch: string, at: number): void => {
    const typeLiteral = (prev === ':' && typeColon) || (prev === 'w' && TYPE_AFTER_WORD.has(word))
      || ((prev === '|' || prev === '&') && singleTypeOp);
    const afterKeyword = ch === '(' && prev === 'w' && ['if', 'while', 'for', 'with'].includes(word);
    stack.push({ ch, at, depth: stack.length, inParens: notParens === 0, inAngle: angles.length > 0, typeLiteral, afterKeyword });
    if (ch !== '(') notParens++;
    ternaries.push(0);
  };
  const dropAngles = (above: number): void => {
    while (angles.length > 0 && angles[angles.length - 1]! >= above) angles.pop();
  };
  // Checkpoints (offsets of line starts) are answered as the scan reaches them: in plain code unless inside a
  // template or its `${ … }`. One a block comment jumps over is inside the comment.
  const cps = checkpoints?.at ?? [];
  let cp = 0;
  const markCheckpoints = (upTo: number, inCode: boolean): void => {
    while (cp < cps.length && cps[cp]! <= upTo) checkpoints!.inCode.set(cps[cp++]!, inCode);
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
  // A container's code starts fresh: its first token is judged as at the start of an expression.
  const openContainer = (at: number): void => {
    push('{jsx', at);
    prev = '{';
    word = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const top = stack[stack.length - 1];
    if (cp < cps.length && cps[cp]! <= i) markCheckpoints(i, !inTemplate && !stack.some((o) => o.ch === '${'));
    // `afterArrow` holds for exactly the first significant token after a `=>`.
    const arrowJustBefore = afterArrow;
    if (!/\s/.test(ch)) afterArrow = false;

    if (!inTemplate && top?.ch === '<jsx') {
      if (top.inTag) {
        if (ch === '/' && text[i + 1] === '>') { pop(i); i++; if (stack[stack.length - 1]?.ch !== '<jsx') afterElement(); }
        else if (ch === '/' && text[i + 1] === '/') { const eol = text.indexOf('\n', i); i = eol === -1 ? text.length : eol; } // a comment between attributes
        else if (ch === '/' && text[i + 1] === '*') {
          const close = text.indexOf('*/', i + 2);
          if (close === -1) return null;
          i = close + 1;
        } else if (ch === '>') top.inTag = false;
        else if (ch === '"' || ch === "'") {
          const close = text.indexOf(ch, i + 1); // a JSX attribute string has no escapes and may span lines
          if (close === -1) return null;
          i = close;
        } else if (ch === '{') openContainer(i);
        else if (ch === '<' && i > 0 && isWordChar(text[i - 1]!)) {
          // `<Select<Option> …/>`: type arguments straight after the tag's name
          const close = typeArgumentsEnd(text, i);
          if (close === -1) return null;
          i = close;
        } else if (ch === '<' && /[A-Za-z_$]/.test(text[i + 1] ?? '')) { push('<jsx', i); stack[stack.length - 1]!.inTag = true; }
      } else if (ch === '{') openContainer(i);
      else if (ch === '<' && text[i + 1] === '/') {
        const close = text.indexOf('>', i + 2);
        if (close === -1) return null;
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
      else if (ch === '`') {
        const t = openTemplates.pop();
        if (t) templates.push({ ...t, close: i });
        inTemplate = false;
        prev = 'w';
        word = '';
      }
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
      if (close === -1) {
        markCheckpoints(Infinity, false);
        return null;
      }
      markCheckpoints(close, false);
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

    if (ch === '`') {
      openTemplates.push({ open: i, depth: stack.length, inParens: notParens === 0, inAngle: angles.length > 0 });
      inTemplate = true;
      continue;
    }

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
      // `if (…) /re/`: after a statement head's `)`, a `/` starts a regex.
      prev = ch === ')' && open.afterKeyword ? '(' : ch;
      word = '';
      continue;
    }

    if (ch === '=' && text[i + 1] === '>') {
      let next = i + 2;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      const arrow: Arrow = {
        at: i, depth: stack.length, inParens: notParens === 0, inAngle: angles.length > 0,
        blockBody: text[next] === '{', inConsequent: ternaries[ternaries.length - 1]! > 0,
        inCheck: stack.length === 0 && inCheck, end: null,
      };
      arrows.push(arrow);
      if (!arrow.blockBody) {
        const open = openArrows.get(stack.length);
        if (open) open.push(arrow);
        else openArrows.set(stack.length, [arrow]);
      }
      i++;
      prev = '>';
      word = '';
      afterArrow = true;
      continue;
    }

    if (isWordChar(ch)) {
      let j = i;
      while (j + 1 < text.length && isWordChar(text[j + 1]!)) j++;
      word = text.slice(i, j + 1);
      if (word === 'extends' && stack.length === 0 && angles.length === 0 && assignAt !== -1) inCheck = true;
      prev = 'w';
      i = j;
      continue;
    }

    // A JSX element, where an expression may start. `<T,>(` and `<T extends U>(` are a generic arrow's type parameters,
    // and so are `<T = U>(` and `<const T …>(`. After a colon that answers no `?`, `<T>(` is a generic function type
    // (`render: <T>(x: T) => string`); anything else there is JSX, an object property's value (`label: <b>Hi</b>`).
    if (ch === '<' && jsx && (JSX_AFTER.has(prev) || (prev === 'w' && JSX_AFTER_WORD.has(word)))
      && !(prev === ':' && typeColon && /^<[A-Za-z_$][\w$]*>\s*\(/.test(text.slice(i, i + 64)))
      && /[A-Za-z_$>]/.test(text[i + 1] ?? '') && !/^<(?:const\s+)?[A-Za-z_$][\w$]*\s*(?:,|extends\b|=(?!>))/.test(text.slice(i, i + 64))) {
      push('<jsx', i);
      stack[stack.length - 1]!.inTag = true;
      continue;
    }

    // `i++` and `i--` after a value leave a value: a `/` after them divides.
    if ((ch === '+' || ch === '-') && text[i + 1] === ch && (prev === ')' || prev === ']' || (prev === 'w' && !REGEX_AFTER_WORD.has(word)))) {
      i++;
      continue;
    }
    // A `!` straight after a value is a non-null assertion, not a `not`: the value is still the last thing seen.
    if (ch === '!' && text[i + 1] !== '=' && (prev === ')' || prev === ']' || (prev === 'w' && !REGEX_AFTER_WORD.has(word)))) continue;
    // A `<` straight after a name, or after a `=` or `=>` where no JSX began (`type F = <T>(x: T) => T`,
    // `(s) => <T, C>(v: T) => R`), opens a generic's
    // `<…>`; its `>` closes it. A `;` or an outer closer ends a comparison taken for one.
    if (ch === '<' && ((i > 0 && isWordChar(text[i - 1]!)) || prev === '=' || arrowJustBefore)) angles.push(stack.length);
    if (ch === '>' && text[i + 1] !== '=' && angles.length > 0 && angles[angles.length - 1] === stack.length) angles.pop();
    if ((ch === '&' || ch === '|') && text[i + 1] === ch) dropAngles(stack.length); // `a<b && …` was a comparison
    if ((ch === '&' || ch === '|') && text[i + 1] !== ch) singleTypeOp = text[i - 1] !== ch;
    if (ch === ',' && angles.length === 0) {
      // A `,` beside an arrow ends its expression, and at depth 0 it ends a variable's first declarator.
      for (const a of openArrows.get(stack.length) ?? []) a.end = i;
      openArrows.delete(stack.length);
      if (stack.length === 0 && assignAt !== -1 && statementEndAt === -1 && declaratorEndAt === -1) declaratorEndAt = i;
      if (stack.length === 0) commas.push(i);
    }
    if (ch === ';') {
      // A `;` beside an arrow ends its expression, as a closer does. (JSX text is read as text, so its `;` never gets here.)
      for (const a of openArrows.get(stack.length) ?? []) a.end = i;
      openArrows.delete(stack.length);
      dropAngles(stack.length);
      if (stack.length === 0 && assignAt !== -1 && statementEndAt === -1) statementEndAt = i;
      if (stack.length === 0) semis.push(i);
    }
    // `?.` and `??` are not a conditional's `?`, and neither is an optional mark (`render?:`, `(x?)`, `[a?, b?]`);
    // every conditional `?` is answered by a `:` at its own level.
    if (ch === '?' && text[i + 1] !== '.' && text[i + 1] !== '?' && prev !== '?' && !/^\?\s*[:),]/.test(text.slice(i, i + 16))) {
      ternaries[ternaries.length - 1]!++;
      dropAngles(stack.length);
      if (stack.length === 0) {
        if (conditionalAt === -1) conditionalAt = i;
        inCheck = false;
      }
    }
    if (ch === ':') {
      typeColon = !(ternaries[ternaries.length - 1]! > 0);
      if (!typeColon) ternaries[ternaries.length - 1]!--;
      if (!typeColon && stack.length === 0) inCheck = false;
    }
    if (ch === '=' && stack.length === 0 && angles.length === 0 && text[i + 1] !== '=' && !'=!<>+-*/%&|^?'.includes(text[i - 1] ?? '')) {
      if (assignAt === -1) assignAt = i;
      assigns.push(i);
    }
    prev = ch;
    word = '';
  }

  if (inTemplate || stack.length > 0) return null;
  for (const a of arrows) if (a.end === null) a.end = text.length;
  return { groups, arrows, templates, assignAt, conditionalAt, statementEndAt, declaratorEndAt, assigns, commas, semis };
}

/**
 * The index of the `>` that closes the type arguments opening at `at`, or -1: `<Option>`, `<A<B>, C>`,
 * `<{ id: number }>`, `<'on' | 'off'>`, `<() => void>`, over several lines. Brackets inside pair up, quotes
 * are skipped, and a `;` outside every bracket or a backtick gives up.
 */
function typeArgumentsEnd(text: string, at: number): number {
  let angles = 0;
  const closers: string[] = [];
  const limit = Math.min(text.length, at + 4096);
  for (let i = at; i < limit; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < limit && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (text[j] !== c) return -1;
      i = j;
    } else if (c === '`' || (c === ';' && closers.length === 0)) return -1;
    else if (c === '(' || c === '[' || c === '{') closers.push(CLOSER_OF[c]!);
    else if (c === ')' || c === ']' || c === '}') { if (closers.pop() !== c) return -1; }
    else if (closers.length === 0 && c === '<') angles++;
    else if (closers.length === 0 && c === '>' && text[i - 1] !== '=' && --angles === 0) return i;
  }
  return -1;
}

/**
 * Which of `startLines` begin in plain code. A range is scanned on its own, so a range whose first
 * line begins inside a template or a block comment that opened earlier (a minified bundle puts a
 * declaration right after a template's closing backtick) would be read with code and template
 * swapped. So the file is scanned once, from line 1, and each range's first line is answered as
 * the scan reaches it. A line the scan never reaches (it misread something earlier) counts as
 * code, as it did before this check, and JSX never counts against a line. A misread that opens a
 * template or a block comment where there is none still hides the lines up to where it closes:
 * those ranges are left untouched, never cut.
 */
function linesInCode(lines: string[], startLines: number[], jsx: boolean): Map<number, boolean> {
  const offsetOf = new Map<number, number>();
  let offset = 0;
  for (let n = 1, k = 0; n <= lines.length && k < startLines.length; n++) {
    while (k < startLines.length && startLines[k] === n) offsetOf.set(startLines[k++]!, offset);
    offset += lines[n - 1]!.length + 1;
  }
  const inCode = new Map<number, boolean>();
  scanJs(lines.join('\n'), jsx, { at: [...new Set(offsetOf.values())].sort((a, b) => a - b), inCode });
  return new Map(startLines.map((n) => [n, inCode.get(offsetOf.get(n) ?? -1) ?? true]));
}

/**
 * The start of the line that holds offset `at`. A range can be one long line holding thousands of
 * declarations, each cut on it, so the text's line starts are found once and then searched.
 */
let lineIndex: { text: string; starts: number[] } = { text: '', starts: [0] };
function lineStartOf(text: string, at: number): number {
  if (lineIndex.text !== text) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    lineIndex = { text, starts };
  }
  const { starts } = lineIndex;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return starts[lo]!;
}

/** The leading whitespace of the line that holds offset `at`. */
function indentAt(text: string, at: number): string {
  return /^[ \t]*/.exec(text.slice(lineStartOf(text, at)))![0];
}

/** Hide the inside of one matched pair: everything through its opener, the TODO line, everything from its own closer on. */
function cutPair(text: string, g: { open: number; close: number }, todo: string): Edit {
  const closeLineStart = lineStartOf(text, g.close);
  const to = text.slice(closeLineStart, g.close).trim() === '' ? closeLineStart : g.close;
  return { from: g.open + 1, to, insert: `\n${indentAt(text, g.open)}  ${todo}\n` };
}

/** Turn an arrow's expression body into a block, keeping whatever followed the expression. */
function cutArrow(text: string, a: Arrow, todo: string): Edit {
  const indent = indentAt(text, a.at);
  return { from: a.at + 2, to: a.end!, insert: ` {\n${indent}  ${todo}\n${indent}}` };
}

/** Apply edits that do not overlap, in one pass. */
function applyEdits(text: string, edits: Edit[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.from - b.from)) {
    parts.push(text.slice(at, e.from), e.insert);
    at = e.to;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

/** `type X = …`, `export declare type X<T> = …`. */
const TYPE_ALIAS = /^\s*(?:export\s+)?(?:declare\s+)?type\s+[A-Za-z_$]/;
/** `interface X …`, `export declare interface X …`. */
const INTERFACE = /^\s*(?:export\s+)?(?:declare\s+)?interface\s/;
/** `const x = …`, `export let x: T = …`; not `const enum`. */
const VARIABLE = /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(?!enum\b)/;

/** `function f`, `export default class A`, `async function* g`, `interface I`, `enum E`, `namespace N`. */
const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\b|class\b|(?:interface|enum|namespace|module)\s+[A-Za-z_$'"])/;
/** A method's head, as in a class body written on one line: `name(`, `static async *name(`, `get name(`, `#name<T>(`. */
const METHOD = /^(?:(?:static|async|get|set|public|private|protected|override|readonly)\s+)*\*?\s*#?([A-Za-z_$][\w$]*)\s*[<(]/;
/** Words that start a statement, not a method, when a `(` follows them. */
const STATEMENT_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'throw', 'typeof',
  'await', 'yield', 'new', 'delete', 'void', 'do', 'else', 'super', 'import']);
/** After a block at depth 0, these words carry on its statement; any other word starts a new one. */
const CONTINUES = new Set(['else', 'catch', 'finally', 'while', 'as', 'satisfies', 'instanceof', 'in', 'of', 'from', 'extends', 'implements']);

/**
 * Replace one range of a TS/JS/TSX file. A range is the range of every declaration on it:
 * `extract()` gives each declarator of a statement, and each declaration on a line of statements,
 * the whole statement's or line's range, and main's cut (everything after the first `{`) hid them
 * all. So each declaration on the range hides its own body, and which pair that is depends on
 * what it declares. Only pairs inside nothing but parentheses are ever candidates (a `[ … ]`
 * element, a `{ … }` member and a template's `${ … }` are all part of something bigger):
 *
 *   - A function, class, interface, enum or method: the LAST top-level `{ … }` of its own
 *     statement that is not a type — never a type argument (`<…>`), a return-type literal (after
 *     `:` or `is`, or a return type's `() => { … }`), or a union member (`A | { … }`).
 *   - A variable: each declarator's own value, from its `=` to its `,` or its statement's `;`,
 *     never a type annotation, a type argument or a return-type literal. The shallowest candidate,
 *     the biggest on a tie: an arrow's expression body (on any line), or a block — the module
 *     pattern's function, a callback, an `extend({ … })` object. A list of records is hidden
 *     whole, and a template's text goes, each only when nothing else is there (`[1, 2].map((n) =>
 *     …)` hides the callback). When the range's first value holds nothing to hide, its annotation's
 *     type literal is the content (`let memo: { … } | null = null`).
 *   - A type alias: main's own cut from its first top-level `{` (every union member goes with
 *     it, and a range-final `;` stays) unless the type is conditional, where only that pair is
 *     cut; a function type's return type, but never an arrow inside a conditional type's check
 *     (`T extends (x: infer I) => R ? A : B`, at any link of a chain); or, inside a generic, the
 *     pair itself, so `Readonly<{ … }>` keeps its `}>;`. A type alias and an interface hold no JSX.
 *
 * A later statement on the range that declares nothing (`if (…) { … }`, a call, an assignment) is
 * left as it is; the range's first statement is cut by the rules above whatever it is. A statement
 * after a block is found only when a word follows the block (`}function g`), so in
 * `function a(){…}!function(){…}()` the two read as one statement and its last block, the
 * wrapper's, is the one cut. An arrow that is a conditional's first branch is never cut, and a
 * range the scan cannot read, or one whose first line starts inside a template or a block comment,
 * is left exactly as it was. Each cut is inside one matched pair and no two overlap, so the range
 * stays balanced. The TODO line sits two spaces inside the line it opens, and a closing line keeps
 * its own indentation, so a function inside a wrapper still reads as one.
 */
function stubJsLikeRange(lines: string[], start: number, end: number, language: string, questions: StubQuestion[], index: number): string[] {
  const untouched = lines.slice(start - 1, end);
  const text = untouched.join('\n');
  // A type alias or an interface holds types only, so a `<` there is never JSX.
  const scan = scanJs(text, language !== 'typescript' && !TYPE_ALIAS.test(text) && !INTERFACE.test(text));
  if (scan === null) return untouched;
  const todo = todoLine('//', questions, index);
  if (TYPE_ALIAS.test(text)) {
    const cut = stubTypeAlias(text, scan, todo);
    return cut === null ? untouched : applyEdits(text, [cut]).split('\n');
  }
  const starts = statementStarts(text, scan);
  const pool = poolOf(text, scan);
  const variable = VARIABLE.test(text);
  const first = variable ? stubValue(text, scan, pool, todo) : stubDeclarationBody(text, scan, todo, starts[0] ?? text.length);
  // The range's first value is `stubValue`'s, so the later declarations skip it.
  const later = laterDeclarations(text, scan, pool, todo, starts, variable ? scan.assignAt : -1)
    .filter((e) => !first || e.to <= first.from || e.from >= first.to);
  const edits = first ? [first, ...later] : later;
  return edits.length === 0 ? untouched : applyEdits(text, edits).split('\n');
}

/** The body of the declaration the range starts with: the last top-level block of its own statement, which ends at `end`. */
function stubDeclarationBody(text: string, scan: JsScan, todo: string, end: number): Edit | null {
  const tops = scan.groups.filter((g) => g.kind === '{' && g.depth === 0 && !g.inAngle && !g.typeLiteral && g.close < end);
  return tops.length > 0 ? cutPair(text, tops[tops.length - 1]!, todo) : null;
}

/** The value of the range's first declarator, or failing that its annotation's type literal. */
function stubValue(text: string, scan: JsScan, pool: Pool, todo: string): Edit | null {
  if (scan.assignAt === -1) return null;
  const end = Math.min(...[scan.statementEndAt, scan.declaratorEndAt].map((at) => (at === -1 ? Infinity : at)));
  const own = valueEdit(text, pool, todo, scan.assignAt, end);
  if (own) return own;
  // Nothing in the value to hide (`= null`, `= {}`, `= make()`): the content is the annotation's type literal.
  const annotation = scan.groups.find((g) => g.kind === '{' && g.depth === 0 && !g.inAngle && g.close < scan.assignAt && holdsSomething(text, g));
  return annotation ? cutPair(text, annotation, todo) : null;
}

/** An empty value (`{}`, `[]`) has nothing to hide, so it is never the body. */
function holdsSomething(text: string, g: Group): boolean {
  return text.slice(g.open + 1, g.close).trim() !== '';
}

/**
 * Every pair a value may hide, each list sorted by where it starts, so that each declarator's window
 * finds its own candidates with one search: only pairs inside nothing but parentheses, never inside a
 * generic, never a type.
 */
interface Pool {
  blocks: Group[];
  arrows: Arrow[];
  lists: Group[];
  templates: JsScan['templates'];
}

function poolOf(text: string, scan: JsScan): Pool {
  // An empty function body is still a body: its TODO marks where the learner writes the function.
  const functionBody = (g: Group): boolean => /[)>]\s*$/.test(text.slice(Math.max(0, g.open - 64), g.open));
  const candidate = (x: { inParens: boolean; inAngle: boolean }): boolean => x.inParens && !x.inAngle;
  const byOpen = <T extends { open: number }>(xs: T[]): T[] => xs.sort((a, b) => a.open - b.open);
  return {
    blocks: byOpen(scan.groups.filter((g) => g.kind === '{' && !g.typeLiteral && candidate(g) && (holdsSomething(text, g) || functionBody(g)))),
    arrows: scan.arrows.filter((a) => !a.blockBody && !a.inConsequent && candidate(a)),
    lists: byOpen(scan.groups.filter((g) => g.kind === '[' && !g.typeLiteral && candidate(g) && holdsSomething(text, g))),
    templates: byOpen(scan.templates.filter((t) => candidate(t) && text.slice(t.open + 1, t.close).trim() !== '')),
  };
}

/** The items of `xs`, sorted by `at`, whose `at` lies strictly between `after` and `before`. */
function between<T>(xs: T[], at: (x: T) => number, after: number, before: number): T[] {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(xs[mid]!) <= after) lo = mid + 1;
    else hi = mid;
  }
  const out: T[] = [];
  for (let i = lo; i < xs.length && at(xs[i]!) < before; i++) out.push(xs[i]!);
  return out;
}

/** The cut for the value that starts after the `=` at `assignAt` and ends before `end`. */
function valueEdit(text: string, pool: Pool, todo: string, assignAt: number, end: number): Edit | null {
  const pairs = (gs: Group[]) => gs.map((g) => ({ start: g.open, end: g.close, depth: g.depth, cut: () => cutPair(text, g, todo) }));
  const chosen = pick([
    ...pairs(between(pool.blocks, (g) => g.open, assignAt, end)),
    ...between(pool.arrows, (a) => a.at, assignAt, end).map((a) => ({ start: a.at, end: a.end!, depth: a.depth, cut: () => cutArrow(text, a, todo) })),
  ])
    ?? pick(pairs(between(pool.lists, (g) => g.open, assignAt, end)))
    // A template is a value's body too (`styled.div` `…` `, a query): its text goes, the backticks stay.
    ?? pick(between(pool.templates, (t) => t.open, assignAt, end)
      .map((t) => ({ start: t.open, end: t.close, depth: t.depth, cut: () => cutTemplate(text, t, todo) })));
  return chosen ? chosen.cut() : null;
}

/** Where each statement after the range's first begins: after a `;` at depth 0, or after a block at depth 0 that a new statement follows. */
function statementStarts(text: string, scan: JsScan): number[] {
  const starts = new Set(scan.semis.map((at) => at + 1));
  for (const g of scan.groups) {
    if (g.depth !== 0 || g.inAngle) continue;
    const at = codeAt(text, g.close + 1);
    const next = /^[A-Za-z_$#][\w$]*/.exec(text.slice(at, at + 64));
    if (next && !CONTINUES.has(next[0])) starts.add(g.close + 1);
  }
  return [...starts].filter((at) => at < text.length).sort((a, b) => a - b);
}

/** The first offset at or after `from` that is not a blank or a comment. */
function codeAt(text: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith('//', i)) {
      const eol = text.indexOf('\n', i);
      if (eol === -1) return text.length;
      i = eol + 1;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return text.length;
      i = close + 2;
    } else return i;
  }
}

/**
 * Every declaration on the range after its first: each later declarator of a variable statement,
 * and each later statement that declares a variable, a function, a class, an interface, an enum or
 * a method (a class body written on one line). Each hides its own body by the rules for the first.
 */
function laterDeclarations(text: string, scan: JsScan, pool: Pool, todo: string, starts: number[], firstValueAt: number): Edit[] {
  const edits: Edit[] = [];
  const bounds = [0, ...starts, text.length];
  const tops = scan.groups.filter((g) => g.kind === '{' && g.depth === 0 && !g.inAngle && !g.typeLiteral); // in text order
  let c = 0;
  let a = 0;
  let t = 0; // cursors into `scan.commas`, `scan.assigns` and `tops`, all in text order
  for (let k = 0; k + 1 < bounds.length; k++) {
    const from = bounds[k]!;
    const to = bounds[k + 1]!;
    const head = text.slice(codeAt(text, from), to);
    if (VARIABLE.test(head)) {
      // Each declarator runs from its statement's start or a `,` at depth 0 to the next; its value starts at its first `=`.
      while (c < scan.commas.length && scan.commas[c]! <= from) c++;
      let declStart = from;
      for (;;) {
        const declEnd = c < scan.commas.length && scan.commas[c]! < to ? scan.commas[c++]! : to;
        while (a < scan.assigns.length && scan.assigns[a]! <= declStart) a++;
        const at = a < scan.assigns.length && scan.assigns[a]! < declEnd ? scan.assigns[a]! : -1;
        if (at !== -1 && at !== firstValueAt) {
          const cut = valueEdit(text, pool, todo, at, declEnd);
          if (cut) edits.push(cut);
        }
        if (declEnd === to) break;
        declStart = declEnd;
      }
    } else if (k > 0) {
      const method = METHOD.exec(head);
      if (!DECLARATION.test(head) && !(method && !STATEMENT_WORDS.has(method[1]!))) continue;
      // its own statement's last top-level block
      while (t < tops.length && tops[t]!.open < from) t++;
      let body: Group | null = null;
      while (t < tops.length && tops[t]!.close < to) body = tops[t++]!;
      if (body) edits.push(cutPair(text, body, todo));
    }
  }
  return edits;
}

/** Hide a template's text, keeping its backticks. The TODO line is template text, so nothing in it may end the template. */
function cutTemplate(text: string, t: { open: number; close: number }, todo: string): Edit {
  return cutPair(text, t, todo.replace(/[`\\]/g, "'").replace(/\$\{/g, '$ {'));
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

function stubTypeAlias(text: string, scan: JsScan, todo: string): Edit | null {
  if (scan.assignAt === -1) return null;
  const blocks = scan.groups.filter((g) => g.kind === '{' && g.open > scan.assignAt && g.inParens);
  const top = blocks.find((g) => g.depth === 0 && !g.inAngle);
  if (top && scan.conditionalAt > scan.assignAt) return cutPair(text, top, todo); // a conditional type keeps its `? … : …`
  if (top) {
    // Main's cut, which hid a whole union: what follows this `{` at the top level is complete
    // groups (`| { … }`, `& Reason`, `[]`), so dropping it with the inside keeps the range balanced.
    const semicolon = text.trimEnd().endsWith(';') ? ';' : '';
    return { from: top.open + 1, to: text.length, insert: `\n${indentAt(text, top.open)}  ${todo}\n}${semicolon}` };
  }
  // A function type's arrow, but never one in a conditional type's check (`T extends (x: infer I) => R ? A : B`):
  // its return type ends at the next `?`, which the arrow rule does not look for.
  const fnType = scan.arrows.find((a) => a.at > scan.assignAt && a.depth === 0 && !a.inAngle && !a.blockBody && !a.inConsequent && !a.inCheck);
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
  const codeStarts = JS_LANGUAGES.has(language)
    ? linesInCode(lines, ranges.map((r) => r.startLine), language !== 'typescript')
    : null;

  for (const range of ranges) {
    if (range.startLine < cursor) continue; // an overlapping/out-of-order range — skip rather than corrupt output
    if (range.startLine > cursor) out.push(...lines.slice(cursor - 1, range.startLine - 1));

    if (JS_LANGUAGES.has(language)) {
      out.push(...(codeStarts!.get(range.startLine)
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
