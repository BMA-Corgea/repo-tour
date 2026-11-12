/**
 * T-59 — a repository's names reach the terminal as text.
 *
 * The CLI printed strings a repository (or a PR's author) chose exactly as they were: a file named with an escape
 * sequence ran it in the reader's terminal, and a newline in a name forged a line of output. T-58 made `pr`'s paths
 * inert; these are the rest: `digest` (its ranked list, its not-read list, its nested repositories), `tour` (its parts
 * and itinerary), and `pr`'s branch names and the error that names one. Git refuses control characters in a ref name,
 * not the characters that reorder text.
 *
 * POSITIVES fail on main, each with its own message. The GUARD passes on main: a normal name prints as before.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const MARKER = 'T-59: this file makes the parser fail';

let scratch: string;
beforeAll(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-t59-')); });
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });
const fresh = (name: string): string => fs.mkdtempSync(path.join(scratch, `${name}-`));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

/** Run the CLI from src through tsx, as GONS runs dist: from an empty folder, and capture every byte it prints. */
async function cli(args: string[], env: Record<string, string> = {}, preload?: string): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [
    '--import', TSX, ...(preload ? ['--import', pathToFileURL(preload).href] : []), path.join(REPO_ROOT, 'src', 'cli.ts'), ...args,
  ], { cwd: fresh('cwd'), env: { ...process.env, TMPDIR: fresh('tmp'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  return { code, out };
}

/** In the CLI's own process, make the parser throw on a source holding MARKER, as T-37's CLI check does. */
function failParsesPreload(): string {
  const preload = path.join(fresh('preload'), 'fail-parses.mjs');
  fs.writeFileSync(preload, `import { createRequire } from 'node:module';
const { Parser } = createRequire(${JSON.stringify(path.join(REPO_ROOT, 'src', 'extract.ts'))})('web-tree-sitter');
const real = Parser.prototype.parse;
Parser.prototype.parse = function (...args) {
  if (typeof args[0] === 'string' && args[0].includes(${JSON.stringify(MARKER)})) throw new TypeError('injected by test/terminal-names.test.ts');
  return real.apply(this, args);
};
`);
  return preload;
}

const ESC_NAME = 'src/esc\x1b[31mred\x1b[0m.ts';
/** a newline, then what would read as a ranked row of its own */
const FORGED_NAME = 'src/x\n  1   0.999       9    9      99  source      src/FORGED.ts';
/** an OSC 8 link, without the slashes of a URL (a file name cannot hold them) */
const LINK_NAME = 'src/fails\x1b]8;;https:evil.example\x07link\x1b]8;;\x07.ts';
const NESTED = 'vendor/sub\x1b[2Jrepo';

let repo: string;
beforeAll(() => {
  repo = fresh('repo');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'repo-tour test');
  write(repo, '.gitignore', '.repo-tour/\n');
  write(repo, ESC_NAME, 'export function red(): number { return 1; }\n');
  write(repo, FORGED_NAME, 'export function forged(): number { return 2; }\n');
  write(repo, LINK_NAME, `// ${MARKER}\nexport const link = 3;\n`);
  write(repo, 'src/normal.ts', 'export function normal(): number { return 4; }\n');
  write(repo, `${NESTED}/lib.ts`, 'export const nested = 5;\n');
  const nested = path.join(repo, NESTED);
  git(nested, 'init', '-q');
  git(nested, 'config', 'user.email', 'test@example.com');
  git(nested, 'config', 'user.name', 'repo-tour test');
  git(nested, 'add', '-A');
  git(nested, 'commit', '-q', '-m', 'nested');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'names chosen to break a terminal');
}, 60_000);

const inertOf = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

describe('T-59 AC1: `repo-tour digest` prints a repository\'s names as text', () => {
  let run: { code: number | null; out: string };
  beforeAll(async () => { run = await cli(['digest', repo, '--no-write'], {}, failParsesPreload()); }, 120_000);

  it('no escape sequence from a name reaches the terminal', () => {
    expect(run.code, run.out).toBe(0);
    expect(run.out.includes('\x1b'), 'an escape sequence from a file or folder name reached the terminal').toBe(false);
    expect(run.out.includes('\x07'), 'a BEL from a file name reached the terminal').toBe(false);
  });

  it('a newline in a name forges no ranked row', () => {
    expect(run.out, 'a newline in a file name forged a row of the ranked list').not.toMatch(/^ {2}1 {3}0\.999 .*src\/FORGED\.ts$/m);
  });

  it('each name is shown, as visible escapes: the ranked list, the not-read list, the nested repository', () => {
    expect(run.out, 'the ranked list does not show the name').toContain(inertOf(ESC_NAME));
    expect(run.out, 'the ranked list does not show the name').toContain(inertOf(FORGED_NAME));
    expect(run.out, 'the not-read list does not show the name').toContain(`${inertOf(LINK_NAME)}: TypeError: injected`);
    expect(run.out, 'the nested repository is not shown').toContain(inertOf(NESTED));
  });

  it('a normal name prints as it always has (guard)', () => {
    expect(run.out).toMatch(/source {6}src\/normal\.ts$/m);
  });
});

describe('T-59 AC2: `repo-tour tour` prints its parts and itinerary as text', () => {
  it('no escape sequence, no forged line, the names shown', async () => {
    const run = await cli(['tour', repo, '--no-interpret', '--no-write', '--view', path.join(fresh('view'), 'tour.html')]);
    expect(run.code, run.out).toBe(0);
    expect(run.out.includes('\x1b'), 'an escape sequence from a name reached the terminal').toBe(false);
    expect(run.out, 'the itinerary does not show the name').toContain(inertOf(ESC_NAME));
    expect(run.out, 'a newline in a name forged a line of the itinerary').not.toMatch(/^ {2}1 {3}0\.999 .*src\/FORGED\.ts$/m);
  }, 120_000);
});

describe('T-59 AC3: `repo-tour pr --pr N` prints a branch\'s name as text', () => {
  /** a GitHub repository whose PR #1 the stand-in `gh` describes with the given branch names */
  async function prRepo(head: string, base: string): Promise<{ root: string; env: Record<string, string> }> {
    const root = fresh('pr');
    git(root, 'init', '-q');
    git(root, 'checkout', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'repo-tour test');
    git(root, 'remote', 'add', 'origin', 'https://github.com/t59-test/names.git');
    write(root, '.gitignore', '.repo-tour/\n');
    write(root, 'src/a.ts', 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const { digest } = await import('../src/digest.js');
    await digest(root, { write: true });
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'src/a.ts', 'export const a = 2;\n');
    git(root, 'commit', '-q', '-am', 'the change');
    const sha = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', 'main');
    const bin = fresh('bin');
    fs.writeFileSync(path.join(bin, 'view.json'), JSON.stringify({ headRefOid: sha, headRefName: head, baseRefName: base, title: 'a change', body: '', commits: [] }));
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\n[ "$3 $4" = "pr view" ] && exec cat "$(dirname "$0")/view.json"\nexit 1\n`);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    return { root, env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } };
  }

  it('the head and base labels show a text-reordering character as an escape', async () => {
    const head = 'feature\u202Etxt.exe';
    const { root, env } = await prRepo(head, 'main');
    const run = await cli(['pr', root, '--pr', '1', '--no-interpret', '--view', path.join(fresh('view'), 'pr.html')], env);
    expect(run.code, run.out).toBe(0);
    expect(run.out.includes('\u202E'), 'a right-to-left override from a branch name reached the terminal').toBe(false);
    expect(run.out).toContain('feature\\u202etxt.exe');
  }, 120_000);

  it('the checkpoint\'s commit and time, read from a digest a repository can ship, print as text (review B1)', async () => {
    const { root, env } = await prRepo('feature', 'main');
    // the digest on disk is the repository's own file: plant hostile values where pr reads its commit and its time
    const manifest = path.join(root, '.repo-tour', 'digest.json');
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { generatedAt: string; repos: Array<{ root: string; head: string | null }> };
    m.repos = m.repos.map((r) => (r.root === '' ? { ...r, head: '\x1b[2J\x1b[3J\x1b[H' } : r));
    m.generatedAt = '\x1b]0;PWNED\x07\n FORGED';
    fs.writeFileSync(manifest, JSON.stringify(m));
    const run = await cli(['pr', root, '--pr', '1', '--no-interpret', '--view', path.join(fresh('view'), 'pr.html')], env);
    expect(run.out.includes('\x1b'), 'an escape sequence from the digest on disk reached the terminal').toBe(false);
    expect(run.out, 'a newline from the digest on disk forged a line').not.toMatch(/^ FORGED/m);
  }, 120_000);

  it('an error that names the branch shows it as an escape too', async () => {
    const { root, env } = await prRepo('feature', 'gone\u202Ebranch');
    const run = await cli(['pr', root, '--pr', '1', '--no-interpret'], env);
    expect(run.code).toBe(2);
    expect(run.out.includes('\u202E'), 'a right-to-left override from a branch name reached the terminal in an error').toBe(false);
    expect(run.out).toContain('gone\\u202ebranch');
  }, 120_000);
});
