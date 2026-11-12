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
  /**
   * T-58: git's diff was more than the 32 MiB a page carries. There are no hunks; `added` and `removed` are git's own
   * counts, so the page can say how big it was rather than "+0 −0" and "no textual change".
   */
  tooBig?: true;
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
  return readDiff(root, from, to, file, context, renamedFrom).text;
}

/** A file's diff as git printed it, or word that it was too big to hold. */
export interface RawDiff {
  text: string;
  /** git printed more than the 32 MiB buffer: `text` is empty, and not because nothing changed (T-58) */
  tooBig: boolean;
}

/**
 * `rawDiff`, telling a diff too big to hold from an empty one. Past the buffer, git's output was swallowed as `''`,
 * and the page then said "a rename, a mode change, or a binary file" of a 33 MiB change (T-58).
 */
export function readDiff(root: string, from: string, to: string, file: string, context = 6, renamedFrom?: string): RawDiff {
  try {
    return {
      text: execFileSync('git', [
        '-C', root, ...FROM_THE_TOP, 'diff', `-U${context}`, '-M', `${from}..${to}`,
        '--', ...(renamedFrom !== undefined ? exactly(renamedFrom) : []), ...exactly(file),
      ], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
      }),
      tooBig: false,
    };
  } catch (err) {
    return { text: '', tooBig: (err as { code?: string }).code === 'ENOBUFS' };
  }
}

/** One file's lines added and removed, as git counts them: what a diff too big to show still has to say (T-58). */
export function diffCounts(root: string, from: string, to: string, file: string, renamedFrom?: string): { added: number; removed: number } {
  try {
    const out = execFileSync('git', [
      '-C', root, ...FROM_THE_TOP, 'diff', '--numstat', '-z', '-M', `${from}..${to}`,
      '--', ...(renamedFrom !== undefined ? exactly(renamedFrom) : []), ...exactly(file),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
    // "<added>\t<removed>\t<path>\0", or for a rename "<added>\t<removed>\t\0<old>\0<new>\0"; "-" for a binary file
    const [add = '', del = ''] = (out.split('\0')[0] ?? '').split('\t');
    return { added: add === '-' ? 0 : Number(add) || 0, removed: del === '-' ? 0 : Number(del) || 0 };
  } catch {
    return { added: 0, removed: 0 };
  }
}

/**
 * The line git's own diff opens with, `index <base blob>..<head blob>`, for a file whose text is left out. It names the
 * two contents, so what the model reads in the diff's place, and the verdict cached on it, belong to this change and
 * not to another of the same file with the same counts (T-58). Empty when git will not say.
 */
export function diffIndex(root: string, from: string, to: string, file: string, renamedFrom?: string): string {
  try {
    const out = execFileSync('git', [
      '-C', root, ...FROM_THE_TOP, 'diff', '--raw', '-z', '--no-abbrev', '-M', `${from}..${to}`,
      '--', ...(renamedFrom !== undefined ? exactly(renamedFrom) : []), ...exactly(file),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
    // ":<base mode> <head mode> <base blob> <head blob> <status>\0<path>\0…"
    const fields = (out.split('\0')[0] ?? '').split(' ');
    return fields.length >= 4 ? `index ${fields[2]}..${fields[3]}` : '';
  } catch {
    return '';
  }
}

export function unifiedDiff(root: string, from: string, to: string, file: string, context = 6, renamedFrom?: string): FileDiff {
  const read = readDiff(root, from, to, file, context, renamedFrom);
  if (read.tooBig) return { path: file, hunks: [], ...diffCounts(root, from, to, file, renamedFrom), empty: true, tooBig: true };
  return parseUnified(file, read.text);
}

export function parseUnified(file: string, raw: string): FileDiff {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;

  for (const line of raw.split('\n')) {
    // A new file section ends the hunk before it, so its own `---`/`+++` lines are preamble, not a line removed and
    // a line added. Git prints a type change (a file that became a symbolic link) as two sections (T-58).
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
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
