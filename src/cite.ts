/**
 * Finding the file references in an answer, and deciding whether to trust each one.
 *
 * The persona has always told the assistant to ground its claims and name the file it would
 * need. Nothing ever rendered those names as anything but text and nothing ever checked them,
 * so a path it invented and a path it was handed looked identical on the page. T-18 Q7: make
 * them links, and mark one it was never shown.
 *
 * Three verdicts, because there are three different situations and flattening them would lose
 * the useful one:
 *
 *   supplied — it was given this file. The citation is as good as the text it came with.
 *   unshown  — the file is real, but nobody put it in front of the model. It is talking about
 *              a file it has not read. That is where a confident wrong answer lives.
 *   unknown  — no such file. Either a hallucinated path or a stale one.
 *
 * ── The deliberate blind spot ────────────────────────────────────────────────────────────
 * A bare word like `Node.js` is shaped exactly like a bare filename, and prose is full of
 * them. So a token with NO slash is only ever reported when it can be matched to something
 * real — a supplied file's basename, or a file at the repository root. An unmatched bare word
 * is left alone rather than accused of being a hallucinated path. Under-flagging prose is a
 * much cheaper mistake than telling a reader their assistant invented "Node.js".
 */

export type CitationVerdict = 'supplied' | 'unshown' | 'unknown';

export interface Citation {
  /** index into the answer text where the reference starts */
  start: number;
  /** index just past the end of the reference, line number included */
  end: number;
  /** exactly the text that was matched, e.g. 'src/rank.ts:24' */
  text: string;
  /** the path part, repo-relative when it had one */
  path: string;
  /** the line the answer pointed at, when it gave one */
  line: number | null;
  verdict: CitationVerdict;
}

/**
 * A path-shaped token, optionally followed by :line or :line-line.
 *
 * The extension must START with a letter, which is what keeps `3.14` and `1.2.3` out. The
 * lookbehind stops a match beginning in the middle of a longer path.
 */
const TOKEN = /(?<![\w/.-])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z_][A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?::(\d+)(?:-\d+)?)?/g;

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Every file reference in an answer, with a verdict for each.
 *
 * `supplied` is every path the model was actually given this exchange — the file on screen
 * plus anything it fetched. `exists` answers whether a repo-relative path is a real file in
 * the repository under tour; it is injected rather than reaching for `fs` so this stays a pure
 * function with tests that do not need a repository on disk.
 */
export function findCitations(
  text: string,
  supplied: Iterable<string>,
  exists: (repoRelativePath: string) => boolean,
): Citation[] {
  const suppliedSet = new Set<string>();
  const suppliedByBase = new Map<string, string>();
  for (const p of supplied) {
    if (!p) continue;
    const norm = p.replace(/^\.\//, '');
    suppliedSet.add(norm);
    const b = basename(norm);
    // A basename claimed by two different supplied files is ambiguous, so it claims neither.
    suppliedByBase.set(b, suppliedByBase.has(b) && suppliedByBase.get(b) !== norm ? '' : norm);
  }

  const out: Citation[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m !== null; m = TOKEN.exec(text)) {
    const raw = m[1]!;
    const path = raw.replace(/^\.\//, '');
    const line = m[2] ? Number(m[2]) : null;
    const hasSlash = path.includes('/');

    let verdict: CitationVerdict;
    let resolved = path;
    if (suppliedSet.has(path)) {
      verdict = 'supplied';
    } else if (!hasSlash && suppliedByBase.get(path)) {
      verdict = 'supplied';
      resolved = suppliedByBase.get(path)!;
    } else if (exists(path)) {
      verdict = 'unshown';
    } else if (path.startsWith('../') || path.includes('/../')) {
      // A path that climbs out of the repository is not a claim about a file in it, so
      // "there is no such file" would be the wrong mark to put on it. Leave it as text.
      continue;
    } else if (hasSlash) {
      verdict = 'unknown';
    } else {
      // A bare word that matches nothing real. Prose, not a citation — see the header.
      continue;
    }

    out.push({ start: m.index, end: m.index + m[0]!.length, text: m[0]!, path: resolved, line, verdict });
  }
  return out;
}
