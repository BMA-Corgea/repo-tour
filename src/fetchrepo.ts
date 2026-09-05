/**
 * Serving a tutor's `FETCH:` request out of the repository under tour.
 *
 * This is the one genuinely security-shaped surface in T-18, so it lives in its own module
 * with its own tests rather than inside a route handler. A repo-tour server sits in front of
 * somebody's private repositories; the existing `/img/` route already refuses to hand out
 * arbitrary paths from disk because a URL asked nicely, and this holds the same line for a
 * request that came from a language model instead of a browser.
 *
 * The rule is simple and total: a path is served only if its REAL path — symlinks resolved —
 * is inside the real root. Everything else is refused with a reason the reader can read, and
 * the reason is shown on the page, because a refusal the tutor quietly works around would be
 * worse than no fetching at all.
 *
 * Nothing here writes, executes, or follows anything off disk. The model never touches any of
 * it: it emits a line of text, this decides what that line is allowed to mean.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FetchRequest } from './ask.js';

/** What a fetch produced: material to hand back, or a refusal to show the reader. */
export type FetchOutcome =
  | { ok: true; what: string; body: string }
  | { ok: false; what: string; reason: string };

/** Directories never worth searching and never worth serving out of. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', '.repo-tour', '.venv', 'venv', '__pycache__', 'vendor', 'target',
]);

/** One file's worth of text to hand over before the caller's budget even applies. */
const MAX_FILE_CHARS = 60_000;

/** Matches to report from a search, and files to look in. Enough to answer, not to dump. */
const MAX_MATCHES = 40;
const MAX_FILES_SCANNED = 4000;

/**
 * Is any segment of this path one we never hand over?
 *
 * `searchRepo` has always skipped `SKIP_DIRS` and dot-entries while walking; `fetchFile`
 * did not, so the same module served `.env` and `.git/config` by name while refusing to
 * find the very same strings by search. That asymmetry made the tutor the one component in
 * repo-tour that would read a private repository's secrets into a prompt — and the reader is
 * only shown the fetch AFTER the material has gone to the provider on the next hop.
 *
 * `src/inventory.ts` already sets the product-wide policy (`.git` "is never content"); this
 * holds the same line on the path a language model can name.
 */
export function isScreenedPath(rel: string): boolean {
  return rel.split('/').some((seg, i, all) => {
    if (!seg || seg === '.') return false;
    if (SKIP_DIRS.has(seg)) return true;
    // Dot-entries are hidden for a reason. `.github` is the one people legitimately tour,
    // and only as a directory on the way to something, never as a leaf secret.
    if (seg.startsWith('.') && seg !== '..' && !(seg === '.github' && i < all.length - 1)) return true;
    return false;
  });
}

/**
 * Resolve a repo-relative path inside a root, or null if it does not belong there.
 *
 * Uses realpath on both sides, so a symlink inside the repository that points at /etc is
 * refused just like `../../etc` is — the check is on where the file actually IS, not on how
 * the path was spelled. A path that does not exist is resolved through its nearest existing
 * ancestor so a missing file is still refused when it would have been outside.
 */
export function resolveInRepo(root: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  // An absolute path is never a repo-relative path, whatever it points at.
  if (path.isAbsolute(rel)) return null;

  let realRoot: string;
  try { realRoot = fs.realpathSync(path.resolve(root)); }
  catch { return null; }

  const target = path.resolve(realRoot, rel);
  const real = realpathOfNearest(target);
  if (!real) return null;

  // path.relative rather than startsWith: '/repo-evil' must not pass a '/repo' prefix test.
  const inside = path.relative(realRoot, real);
  if (inside === '') return realRoot;
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  // The REAL path, not the spelled one: returning `target` would make the caller re-resolve
  // the symlink after the check, leaving a window in which it could be repointed. Costs
  // nothing to close.
  return real;
}

/** realpath of a path, or of the deepest ancestor that exists, so missing files still check. */
function realpathOfNearest(target: string): string | null {
  let probe = target;
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(probe), ...suffix.reverse()); }
    catch { /* keep walking up */ }
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    suffix.push(path.basename(probe));
    probe = parent;
  }
}

/** Hand over one file, whole, clipped only if it is enormous. */
export function fetchFile(root: string, rel: string): FetchOutcome {
  const what = `file ${rel}`;
  if (isScreenedPath(rel)) {
    return { ok: false, what, reason: `refused: ${rel} is not content — hidden files, build output and dependency folders are never served` };
  }
  const abs = resolveInRepo(root, rel);
  if (!abs) {
    return { ok: false, what, reason: `refused: ${rel} is outside the repository being toured` };
  }
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); }
  catch { return { ok: false, what, reason: `there is no ${rel} in this repository` }; }
  if (stat.isDirectory()) {
    // A directory is a real answer to a real question ("what is in src/build?"), so give the
    // listing rather than a refusal that teaches the model nothing.
    let names: string[];
    try { names = fs.readdirSync(abs).sort(); }
    catch { return { ok: false, what, reason: `${rel} could not be listed` }; }
    // Screened here too: a listing that names `.env` is a map to it, and the point of the
    // screen is that the tutor never learns a private repository's secrets exist.
    const shown = names.filter((n) => !isScreenedPath(n));
    return { ok: true, what, body: `${rel} is a directory containing:\n${shown.map((n) => `  ${n}`).join('\n')}` };
  }

  let text: string;
  try { text = fs.readFileSync(abs, 'utf8'); }
  catch { return { ok: false, what, reason: `${rel} could not be read as text` }; }
  if (text.includes('\0')) return { ok: false, what, reason: `${rel} is binary, not text` };

  const clipped = text.length > MAX_FILE_CHARS;
  const body = clipped
    ? `${text.slice(0, MAX_FILE_CHARS)}\n… (${rel} is ${text.length.toLocaleString()} characters; this is the first ${MAX_FILE_CHARS.toLocaleString()})`
    : text;
  return { ok: true, what, body: `${rel}:\n${body}` };
}

/** Where a piece of text appears across the repository, as file:line lines. */
export function searchRepo(root: string, query: string): FetchOutcome {
  const what = `search ${query}`;
  if (query.trim().length < 2) {
    return { ok: false, what, reason: 'that search is too short to be useful — give at least two characters' };
  }
  let realRoot: string;
  try { realRoot = fs.realpathSync(path.resolve(root)); }
  catch { return { ok: false, what, reason: 'the repository could not be read' }; }

  const needle = query.toLowerCase();
  const hits: string[] = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (hits.length >= MAX_MATCHES || scanned >= MAX_FILES_SCANNED) { truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (hits.length >= MAX_MATCHES || scanned >= MAX_FILES_SCANNED) { truncated = true; return; }
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue; // never follow a symlink out of the tree
      scanned++;
      let text: string;
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_CHARS * 2) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      if (text.includes('\0')) continue;
      if (!text.toLowerCase().includes(needle)) continue;
      const rel = path.relative(realRoot, full);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
        }
      }
    }
  };
  walk(realRoot);

  if (!hits.length) return { ok: true, what, body: `No occurrence of "${query}" anywhere in the repository.` };
  return {
    ok: true,
    what,
    body:
      `${hits.length}${truncated ? '+' : ''} occurrence${hits.length === 1 ? '' : 's'} of "${query}":\n` +
      hits.join('\n') +
      (truncated ? '\n… (more matches exist; narrow the search to see them)' : ''),
  };
}

/** Serve one parsed request. The only entry point a caller needs. */
export function serveFetch(root: string, req: FetchRequest): FetchOutcome {
  return req.kind === 'file' ? fetchFile(root, req.arg) : searchRepo(root, req.arg);
}
