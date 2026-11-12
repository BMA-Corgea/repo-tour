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
