/**
 * Read a file the TOURED REPOSITORY controls, safely.
 *
 * repo-tour opens a handful of files by a fixed name that the repository being digested chooses the
 * contents of — `.gitattributes`, and its own `.repo-tour/` cache if a hostile repository ships one.
 * The tree walk skips links (it reads a `readdir` entry's type, which never follows one), but a read
 * by name does follow a committed link, and `git clone` recreates one. A `.gitattributes` committed
 * as a link to `/dev/zero` was read by a plain `readFileSync` in a native loop that neither V8's heap
 * limit nor `worker.terminate()` stops, until the process died (Build Tutorials T-72); a link to a
 * FIFO would block that read for ever; a link to any file on the machine would be read; a huge regular
 * file would be read whole.
 *
 * So every such read goes through here instead of `fs.readFileSync`:
 * - `lstat` first, and open nothing but a regular file within `maxBytes`;
 * - open with `O_NOFOLLOW`, so a link swapped in after the `lstat` fails to open (ELOOP), and with
 *   `O_NONBLOCK`, so a FIFO swapped in opens at once instead of waiting for a writer;
 * - `fstat` what was actually opened, and read it only if it is a regular file within `maxBytes`:
 *   that is what the read sees, whatever the path names by then;
 * - read at most that many bytes, in a loop, since one `readSync` can return less;
 * - close in `finally`.
 *
 * Node does not define `O_NOFOLLOW` or `O_NONBLOCK` on Windows, so there they count as 0; the `lstat`
 * before and the `fstat` after still refuse a link and anything but a regular file.
 *
 * Returns the bytes, or `null` for anything refused — a link, a FIFO, a device, a directory, a file
 * over the bound, or a missing file. A refusal reads as "not there", the same as a missing file, so
 * every caller already has the right fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function readGuardedFile(file: string, maxBytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    fd = fs.openSync(file, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const buf = Buffer.alloc(opened.size);
    let n = 0;
    while (n < buf.length) {
      const got = fs.readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    return n === buf.length ? buf : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }
}

/** The same read, decoded as UTF-8, or `null` when refused. */
export function readGuardedText(file: string, maxBytes: number): string | null {
  const buf = readGuardedFile(file, maxBytes);
  return buf === null ? null : buf.toString('utf8');
}

/**
 * The WRITE side (T-67). repo-tour writes its cache INTO `<repo>/.repo-tour/…`, a folder the toured
 * repository controls and can commit. A plain `fs.writeFileSync` follows a committed link at a cache
 * file's name, and `fs.mkdirSync` follows a committed link at `.repo-tour` or a folder under it, so a
 * repository could redirect repo-tour's own writes and overwrite a file outside itself (Build
 * Tutorials / the foreman's probe: the digest was written THROUGH a committed `.repo-tour/digest.json`
 * link). A refusal is thrown as `CacheWriteRefused` so the caller degrades (completes in memory, says
 * one plain line) instead of writing through the link.
 */
export class CacheWriteRefused extends Error {}

/**
 * Ensure `dir` — the cache root `<repo>/.repo-tour` (`cacheRoot`), or a folder under it — and every
 * folder from `cacheRoot` down to it is a REAL directory, creating a missing one; refuse a symlink or
 * a non-directory, so a committed link cannot send the writes elsewhere. `cacheRoot`'s parent (the
 * repository root the user pointed at) is not the toured repository's to choose, so the check starts at
 * `cacheRoot`. One level at a time, because `mkdirSync(recursive)` follows an existing link.
 */
export function ensureSafeDir(cacheRoot: string, dir: string): void {
  const rel = path.relative(cacheRoot, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new CacheWriteRefused(`${dir} is not inside the cache root ${cacheRoot}; cache not written`);
  }
  let cur = cacheRoot;
  ensureOneRealDir(cur);
  for (const part of rel === '' ? [] : rel.split(path.sep)) {
    cur = path.join(cur, part);
    ensureOneRealDir(cur);
  }
}

function ensureOneRealDir(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    // Absent: create a real directory. The parent was ensured just before, so this is non-recursive and
    // cannot be redirected by a link at the parent.
    fs.mkdirSync(p);
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new CacheWriteRefused(`${p} is a link or not a folder; cache not written`);
  }
}

/**
 * Write `data` to `dir/name` without following a committed link at that name: write a fresh temp file in
 * the SAME (already-`ensureSafeDir`-verified) folder, then rename it over the final name. A rename
 * REPLACES whatever directory entry is at `name` — a committed link included — instead of writing
 * through it. The temp file is opened `O_EXCL | O_NOFOLLOW` so it, too, is never an existing link.
 * `dir` must have been verified with `ensureSafeDir` first.
 */
export function writeFileSafely(dir: string, name: string, data: string | Buffer): void {
  const tmp = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW ?? 0), 0o600);
  try {
    let n = 0;
    while (n < buf.length) n += fs.writeSync(fd, buf, n, buf.length - n, null);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, path.join(dir, name));
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort on our own temp */ }
    throw err;
  }
}
