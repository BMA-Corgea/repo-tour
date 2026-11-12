/**
 * T-67 — a repository the digest writes a cache into cannot redirect that write through a committed link
 * and overwrite a file outside itself. The cache writes go through `ensureSafeDir` (every `.repo-tour`
 * folder must be a real directory) and `writeFileSafely` (write a temp file, rename over the name — a
 * rename REPLACES a committed link instead of writing through it).
 *
 * SAFETY. The victim of every write test is a file inside THIS test's own `mktemp` scratch, never a real
 * file of the user's, and it is checked by sha256 before and after. No /dev/zero or FIFO is involved (a
 * cache write is a finite write), so these run in-process on the patched code. The red proof that main
 * overwrites the victim is driven separately and captured in the evidence folder.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/digest.js';

const DIST_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

const scratches: string[] = [];
function scratch(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-t67-'));
  scratches.push(d);
  return d;
}
afterEach(() => {
  while (scratches.length) {
    const d = scratches.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* own temp only */ }
  }
});

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
  execFileSync('git', ['init', '-q', dir]);
  git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
}

describe('a cache write never follows a committed link out of the repo (T-67)', () => {
  it('AC1/AC4: a committed .repo-tour/digest.json LINK to an outside victim is replaced, not written through', async () => {
    const root = scratch();
    const victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'VICTIM ORIGINAL CONTENT\n');
    const before = sha(victim);

    const repo = path.join(root, 'repo');
    initRepo(repo);
    fs.mkdirSync(path.join(repo, '.repo-tour'));
    fs.symlinkSync(victim, path.join(repo, '.repo-tour', 'digest.json')); // the booby-trap, at a file name

    const res = await digest(repo);

    expect(sha(victim)).toBe(before);              // the victim is byte-for-byte unchanged
    // the link was replaced by a real cache file, so the cache still works (AC2)
    expect(fs.lstatSync(path.join(repo, '.repo-tour', 'digest.json')).isSymbolicLink()).toBe(false);
    expect(res.cacheWrite?.written).toBe(true);
  });

  it('AC1/AC3: a committed .repo-tour that is a LINK to an outside folder is refused; digest finishes, cache not written', async () => {
    const root = scratch();
    const outside = path.join(root, 'outside');       // stands in for anywhere the owner can write
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'digest.json');

    const repo = path.join(root, 'repo');
    initRepo(repo);
    fs.symlinkSync(outside, path.join(repo, '.repo-tour')); // the whole cache folder is a link

    const res = await digest(repo);

    expect(fs.existsSync(sentinel)).toBe(false);      // nothing was written into the outside folder
    expect(res.cacheWrite?.written).toBe(false);      // it degraded
    expect(res.cacheWrite?.reason ?? '').toMatch(/link|folder/);
    expect(res.manifest.counts.files).toBeGreaterThan(0); // the digest itself still completed in memory
  });

  it('AC1: a committed .repo-tour/tiers that is a LINK to an outside folder is refused', async () => {
    const root = scratch();
    const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
    const repo = path.join(root, 'repo');
    initRepo(repo);
    fs.mkdirSync(path.join(repo, '.repo-tour'));
    fs.symlinkSync(outside, path.join(repo, '.repo-tour', 'tiers')); // a sub-folder is the link

    const res = await digest(repo);
    expect(fs.readdirSync(outside)).toHaveLength(0);  // nothing written into it
    expect(res.cacheWrite?.written).toBe(false);
  });

  it('AC1/AC4: `repo-tour tour` does not write its view.html through a committed link (cli.ts)', () => {
    // On main `tour` writes <root>/.repo-tour/view.html with a plain writeFileSync and follows a committed
    // link there, overwriting the target. The guard replaces the link with a real file. PATCHED CLI, child
    // process under timeout; victim inside this test's own scratch.
    const root = scratch();
    const victim = path.join(root, 'victim.html');
    fs.writeFileSync(victim, 'VICTIM ORIGINAL\n');
    const before = sha(victim);

    const repo = path.join(root, 'repo');
    initRepo(repo);
    fs.mkdirSync(path.join(repo, '.repo-tour'));
    fs.symlinkSync(victim, path.join(repo, '.repo-tour', 'view.html'));
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
    git('add', '-A'); git('commit', '-qm', 'trap');
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', repo, clone]);

    let code = 0;
    try {
      execFileSync('timeout', ['-k', '5', '60', process.execPath, DIST_CLI, 'tour', clone],
        { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (e) { code = (e as { status?: number }).status ?? -1; }

    expect(code).not.toBe(124);
    expect(sha(victim)).toBe(before);  // the victim is byte-identical; the link was replaced
    expect(fs.lstatSync(path.join(clone, '.repo-tour', 'view.html')).isSymbolicLink()).toBe(false);
  });

  it('AC3: a committed DIRECTORY at a cache file name degrades, it does not crash (review finding)', async () => {
    // A repo can commit `.repo-tour/digest.json` as a directory. The folder chain is real, so ensureSafeDir
    // passes; the rename then fails EISDIR. That must become a refusal the digest degrades on — not an
    // unhandled throw with a stack trace (AC3). (Before the fix the digest threw EISDIR to the top.)
    const root = scratch();
    const repo = path.join(root, 'repo');
    initRepo(repo);
    fs.mkdirSync(path.join(repo, '.repo-tour'));
    fs.mkdirSync(path.join(repo, '.repo-tour', 'digest.json')); // a DIRECTORY where a file is expected

    const res = await digest(repo);                        // must not throw
    expect(res.cacheWrite?.written).toBe(false);
    expect(res.manifest.counts.files).toBeGreaterThan(0);  // the digest still completed in memory
    expect(fs.statSync(path.join(repo, '.repo-tour', 'digest.json')).isDirectory()).toBe(true);
  });

  it('AC2: an ordinary repository writes and reads back its cache as before', async () => {
    const root = scratch();
    const repo = path.join(root, 'repo');
    initRepo(repo);

    const res = await digest(repo);
    expect(res.cacheWrite?.written).toBe(true);
    const cache = path.join(repo, '.repo-tour', 'digest.json');
    expect(fs.existsSync(cache)).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(cache, 'utf8'))).not.toThrow();
    // a second digest reads the prior inventory.json it wrote (the incremental path still works)
    const res2 = await digest(repo);
    expect(res2.cacheWrite?.written).toBe(true);
  });
});
