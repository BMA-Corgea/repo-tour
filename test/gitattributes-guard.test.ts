/**
 * T-63 — a hostile `.gitattributes` (or `.repo-tour/` cache file) the toured repository controls
 * cannot make repo-tour read without end, hang, or die. `readGitAttributes` (and the digest's
 * incremental cache read) go through `readGuardedFile`, which opens nothing but a regular file within
 * a bound, never following a committed link out of the walk's rules.
 *
 * SAFETY. No test here lets an UNPATCHED read touch `/dev/zero` or a FIFO. The in-process tests use
 * only safe shapes (a link to a small regular file, an oversized REGULAR file, a stubbed `lstat`). The
 * two tests that make a real `/dev/zero` link and a real FIFO run the PATCHED code in a child process
 * under `timeout`, and each hostile node is created inside that test's own `mkdtemp` scratch and
 * removed with it. The red proof that main hangs/dies is driven separately, under a hard memory cap
 * and a timeout, and lives in the evidence folder — never in this suite.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory } from '../src/inventory.js';
import { readGuardedFile } from '../src/safefile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_INVENTORY = path.join(here, '..', 'dist', 'inventory.js');
const DIST_CLI = path.join(here, '..', 'dist', 'cli.js');

const scratches: string[] = [];
function repoFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-t63-'));
  scratches.push(dir);
  fs.mkdirSync(path.join(dir, '.git')); // maybeRepo only reads .gitattributes for a dir holding .git
  return dir;
}
afterEach(() => {
  while (scratches.length) {
    const d = scratches.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort, own temp only */ }
  }
});

function classOf(inv: ReturnType<typeof inventory>, rel: string): string | undefined {
  return inv.files.find((f) => f.path === rel)?.classification;
}

const GEN_RULE = '*.gen.ts linguist-generated\n';

describe('readGitAttributes reads only a small regular file (T-63)', () => {
  it('AC1: a .gitattributes that is a LINK to a small regular file is not followed — no rules', () => {
    // On main `readFileSync` follows the link and `x.gen.ts` classifies as generated. The guard sees a
    // link at `lstat` and reads nothing, so the rule never applies. Safe: the target is a small file.
    const dir = repoFixture();
    fs.writeFileSync(path.join(dir, 'rules.txt'), GEN_RULE);
    fs.symlinkSync('rules.txt', path.join(dir, '.gitattributes'));
    fs.writeFileSync(path.join(dir, 'x.gen.ts'), 'export const x = 1;\n');

    const inv = inventory(dir);
    expect(classOf(inv, 'x.gen.ts')).not.toBe('generated'); // link refused → ordinary source
    expect(classOf(inv, 'x.gen.ts')).toBe('source');
  });

  it('AC1: a nested repository\'s .gitattributes link is refused the same way', () => {
    const dir = repoFixture();
    const sub = path.join(dir, 'pkg');
    fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'rules.txt'), GEN_RULE);
    fs.symlinkSync('rules.txt', path.join(sub, '.gitattributes'));
    fs.writeFileSync(path.join(sub, 'y.gen.ts'), 'export const y = 1;\n');

    const inv = inventory(dir);
    expect(classOf(inv, 'pkg/y.gen.ts')).not.toBe('generated');
  });

  it('AC1/AC6: an ordinary small .gitattributes still classifies files (unchanged)', () => {
    const dir = repoFixture();
    fs.writeFileSync(path.join(dir, '.gitattributes'), `${GEN_RULE}vendor-blob.js linguist-vendored\n`);
    fs.writeFileSync(path.join(dir, 'x.gen.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'vendor-blob.js'), 'module.exports = 1;\n');

    const inv = inventory(dir);
    expect(classOf(inv, 'x.gen.ts')).toBe('generated');
    expect(classOf(inv, 'vendor-blob.js')).toBe('vendored');
  });

  it('AC2: a .gitattributes of EXACTLY 1 MiB is read; its rules still classify', () => {
    const dir = repoFixture();
    writeSized(path.join(dir, '.gitattributes'), 1024 * 1024);
    fs.writeFileSync(path.join(dir, 'x.gen.ts'), 'export const x = 1;\n');

    const inv = inventory(dir);
    expect(classOf(inv, 'x.gen.ts')).toBe('generated');
  });

  it('AC2: a REGULAR .gitattributes over 1 MiB is not read — no rules', () => {
    const dir = repoFixture();
    writeSized(path.join(dir, '.gitattributes'), 1024 * 1024 + 1);
    fs.writeFileSync(path.join(dir, 'x.gen.ts'), 'export const x = 1;\n');

    const inv = inventory(dir);
    expect(classOf(inv, 'x.gen.ts')).not.toBe('generated');
  });
});

describe('readGuardedFile closes the swap-after-lstat window (T-63 AC3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a link swapped in after the lstat fails to open (O_NOFOLLOW)', () => {
    // lstat is faked to report a regular file, while the path is really a link to a small regular file.
    // O_NOFOLLOW makes the open fail with ELOOP, so nothing is read. Safe: the target is a small file.
    const dir = repoFixture();
    fs.writeFileSync(path.join(dir, 'real.txt'), 'secret\n');
    const link = path.join(dir, '.gitattributes');
    fs.symlinkSync('real.txt', link);
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ isFile: () => true, size: 7 } as fs.Stats);

    expect(readGuardedFile(link, 1024 * 1024)).toBeNull();
  });

  it('a file grown past the bound after the lstat is refused by the fstat size check', () => {
    // lstat is faked to report a tiny size, while the real regular file is 2 MiB. The fstat on the open
    // fd sees the true size and refuses. Safe: an ordinary regular file, never read.
    const dir = repoFixture();
    const big = path.join(dir, 'grown');
    writeSized(big, 2 * 1024 * 1024);
    vi.spyOn(fs, 'lstatSync').mockReturnValue({ isFile: () => true, size: 10 } as fs.Stats);

    expect(readGuardedFile(big, 1024 * 1024)).toBeNull();
  });
});

describe('a real /dev/zero link and a real FIFO cannot hang the patched digest (T-63 AC1)', () => {
  // Each runs the PATCHED, built inventory in a CHILD process under `timeout`. If the guard ever failed
  // these would be killed at 30 s (and a /dev/zero read is bounded by the child, never this worker).
  it('a .gitattributes that is a LINK to /dev/zero finishes promptly with no rules', () => {
    const dir = repoFixture();
    fs.symlinkSync('/dev/zero', path.join(dir, '.gitattributes'));
    fs.writeFileSync(path.join(dir, 'x.gen.ts'), 'export const x = 1;\n');
    const out = runInventoryChild(dir);
    expect(out.done).toBe(true);
    expect(out.generated).toBe(false);
  });

  it('a .gitattributes that IS a FIFO is not waited on', () => {
    const dir = repoFixture();
    execFileSync('mkfifo', [path.join(dir, '.gitattributes')]);
    fs.writeFileSync(path.join(dir, 'x.gen.ts'), 'export const x = 1;\n');
    const out = runInventoryChild(dir);
    expect(out.done).toBe(true);
    expect(out.generated).toBe(false);
  });
});

describe('the server reads its .repo-tour/ cache through the same guard (T-63 AC5)', () => {
  // A hostile repository can ship `.repo-tour/rendered/<name>.json` as a committed link; the server's
  // listing enumerates that folder and reads each `.json`. On main the link is followed and parsed
  // (the repo shows a build); the guard refuses it, so the listing reports no build and never reads
  // out of the walk's link rules. Safe shape in-process: a link to a small regular JSON file.
  it('a .repo-tour/rendered/*.json LINK is not read as a build', async () => {
    const dir = repoFixture();
    const rdir = path.join(dir, '.repo-tour', 'rendered');
    fs.mkdirSync(rdir, { recursive: true });
    const meta = { fingerprint: 'deadbeef', presentation: 'x', builtAt: '2026-01-01T00:00:00.000Z', stops: 1, files: [], head: null };
    fs.writeFileSync(path.join(dir, 'real-meta.json'), JSON.stringify(meta));
    fs.symlinkSync(path.join(dir, 'real-meta.json'), path.join(rdir, 'evil.json'));

    const state = path.join(dir, 'loaded.json');
    fs.writeFileSync(state, JSON.stringify([{ path: dir, name: 'victim', addedAt: new Date().toISOString() }]));
    const { RepoTourServer } = await import('../src/server.js');
    const server = new RepoTourServer({ statePath: state, interpret: false });

    const listed = server.listRepos();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.built).toBeNull(); // link refused → the repo shows no build, and nothing hung
  });
});

describe('the PR checkpoint read is guarded (T-63 AC5 — checkpoint.ts)', () => {
  // `repo-tour pr` reads `.repo-tour/digest.json` first, through `loadCheckpoint` -> `readJson`. On main a
  // committed link there is followed by a plain `readFileSync` and the read never ends; the guard refuses
  // it and `pr` fails at once with a clear message. PATCHED CLI, CHILD process, under `timeout`.
  it('a bare `repo-tour pr` on a tree whose .repo-tour/digest.json is a LINK to /dev/zero refuses, does not hang', () => {
    const dir = repoFixture();
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
    execFileSync('git', ['init', '-q', dir]);
    git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').toString().trim();
    fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    git('add', '-A'); git('commit', '-qm', 'head');
    const head = git('rev-parse', 'HEAD').toString().trim();
    fs.mkdirSync(path.join(dir, '.repo-tour'));
    fs.symlinkSync('/dev/zero', path.join(dir, '.repo-tour', 'digest.json'));

    let code = -1;
    let stderr = '';
    try {
      execFileSync('timeout', ['-k', '5', '30', process.execPath, DIST_CLI, 'pr', dir, '--base', base, '--head', head],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      code = 0;
    } catch (e) {
      const err = e as { status?: number | null; stderr?: string };
      code = err.status ?? -1;
      stderr = err.stderr ?? '';
    }
    expect(code).not.toBe(124); // 124 = `timeout` fired: it hung. It must refuse, not hang.
    expect(code).not.toBe(137); // 137 = OOM.
    expect(code).toBe(1); // a clean refusal
    expect(stderr).toMatch(/refused to read a non-regular or oversized cache file/);
  });
});

/** Write a regular file of exactly `size` bytes whose FIRST line is the linguist-generated rule. */
function writeSized(file: string, size: number): void {
  const head = Buffer.from(GEN_RULE, 'utf8');
  const pad = Buffer.alloc(size - head.length, 0x23 /* '#' */);
  // keep the pad as comment bytes on their own lines so a read parses cleanly; a trailing byte is '#'
  fs.writeFileSync(file, Buffer.concat([head, pad]).subarray(0, size));
}

/**
 * Run the built (patched) inventory on `dir` in a child process under a hard timeout, and report
 * whether it finished and whether `x.gen.ts` came out generated. A hang would be killed at 30 s.
 */
function runInventoryChild(dir: string): { done: boolean; generated: boolean } {
  const script =
    `import('${DIST_INVENTORY.replace(/\\/g, '\\\\')}').then(m => {` +
    `const inv = m.inventory(${JSON.stringify(dir)});` +
    `const f = inv.files.find(x => x.path === 'x.gen.ts');` +
    `process.stdout.write('RESULT:' + JSON.stringify({ done: true, generated: f && f.classification === 'generated' }));` +
    `});`;
  const stdout = execFileSync('timeout', ['-k', '5', '30', process.execPath, '--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = /RESULT:(\{.*\})/.exec(stdout);
  if (!m) return { done: false, generated: false };
  const parsed = JSON.parse(m[1]) as { done: boolean; generated: boolean };
  return { done: parsed.done === true, generated: parsed.generated === true };
}
