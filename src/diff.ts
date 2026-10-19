/**
 * Unified diffs, parsed into something a page can render.
 *
 * Deterministic and model-free: this is the "what literally changed" layer that T-9 exists
 * to put back on screen. The owner's words: *"We agreed that it's not about the diffs and we need
 * to go deeper, but we absolutely need the diffs so that we know what is happening."*
 *
 * Both halves of that sentence matter. The tour's ORDER and its narration are about meaning;
 * the thing under the reader's eyes still has to be the actual change, with the actual lines
 * marked. A tour that explains a change you cannot see is asking to be taken on faith.
 */

import { execFileSync } from 'node:child_process';

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  /** line number on the base side, null for an addition */
  oldNo: number | null;
  /** line number on the head side, null for a deletion */
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  /** the @@ header, kept because it names the enclosing function when git can find one */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** true when git gave us no text to show — a binary file, or a pure rename */
  empty: boolean;
}

/**
 * T-58: exactly one file, named to `git diff` from the repository's top.
 *
 * Git reads a plain pathspec from the folder it runs in, and the app tours a monorepo package from its folder, so a
 * path counted from the top named nothing there and every file showed "+0 −0". `top` counts it from the top wherever
 * git runs; `literal` keeps a `*`, `?` or `[` in a name from matching other files; and the exclusion keeps a path
 * that is a directory on one side of the change (a file that became a folder of the same name) from bringing in that
 * folder's files.
 */
export function exactly(file: string): string[] {
  return [`:(top,literal)${file}`, `:(top,literal,exclude)${file}/`];
}

/**
 * Git's own setting to count diff paths from the folder it runs in, turned off for every listing the PR flow reads,
 * so a reader's configuration cannot make one folder's paths stand for the repository's (T-58).
 */
export const FROM_THE_TOP = ['-c', 'diff.relative=false'];

/**
 * `-U6` rather than the default 3.
 *
 * A two-line change with three lines of context is legible to someone who already knows the
 * file and useless to someone meeting it for the first time, which is exactly who this
 * product is for.
 *
 * `renamedFrom`: a renamed file's old path. Named to git beside the new one, the two pair up as a rename and the diff
 * is what changed; the new path alone read as a new file, every line of it added (T-58).
 */
export function rawDiff(root: string, from: string, to: string, file: string, context = 6, renamedFrom?: string): string {
  try {
    return execFileSync('git', [
      '-C', root, ...FROM_THE_TOP, 'diff', `-U${context}`, '-M', `${from}..${to}`,
      '--', ...(renamedFrom !== undefined ? exactly(renamedFrom) : []), ...exactly(file),
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

export function unifiedDiff(root: string, from: string, to: string, file: string, context = 6, renamedFrom?: string): FileDiff {
  return parseUnified(file, rawDiff(root, from, to, file, context, renamedFrom));
}

export function parseUnified(file: string, raw: string): FileDiff {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;

  for (const line of raw.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (head) {
      oldNo = Number(head[1]);
      newNo = Number(head[2]);
      current = { header: (head[3] ?? '').trim(), oldStart: oldNo, newStart: newNo, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;                      // the ---/+++/index preamble
    if (line.startsWith('\\')) continue;         // "\ No newline at end of file"

    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', oldNo: null, newNo, text: line.slice(1) });
      newNo++; added++;
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', oldNo, newNo: null, text: line.slice(1) });
      oldNo++; removed++;
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'ctx', oldNo, newNo, text: line.slice(1) });
      oldNo++; newNo++;
    }
  }

  return { path: file, hunks, added, removed, empty: hunks.length === 0 };
}
