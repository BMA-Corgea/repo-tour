/**
 * T-37 — a file not read on one side of a pull request is not scored, and the PR tour says so.
 *
 * Since T-31 a file that cannot be parsed is listed in `extract()`'s `unparsed` and gets no extract.
 * A PR side kept only the extracts, and `surfaceChange` read a missing extract as an empty surface,
 * so a modified file not read on the head side read as its whole public surface removed (and the
 * mirror, added), scored "moved", and sent the files that import it down the ripple. The PR page
 * said nothing. A file over the side's 64 MiB `git show` buffer was dropped the same way.
 *
 * The rulings (the foreman, 2026-10-19): a modified or renamed file with a side not read is not
 * scored; an added or deleted file keeps main's status score ("new" and "gone" need no reading)
 * and gains the notice; a file present on both sides with an extract on only one, whatever the
 * cause, is the same case; a file skipped for its class on both sides is shown as on main.
 *
 * Parse failures are injected as `test/iterative-walks.test.ts` does. POSITIVES fail on main,
 * each with its own message. GUARDS pass on main by design: they pin what must not move.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as treeSitter from 'web-tree-sitter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { digest } from '../src/digest.js';
import { sideAt } from '../src/checkpoint.js';
import { runPrFlow, type PrFlowResult } from '../src/prflow.js';
import * as delta from '../src/delta.js';
import { fileDelta, orderByMeaning, type FileDelta } from '../src/delta.js';
import { buildPrTour, band } from '../src/prtour.js';
import { renderPrView } from '../src/prview.js';
import { hunks, type Hunk } from '../src/pr.js';
import { parseUnified } from '../src/diff.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

const MARKER = 'T-37: this file makes the parser fail';
const INJECTED = 'TypeError: injected by test/unread-pr-sides.test.ts';
const NO_SURFACE = { added: [], removed: [], changed: [] };

let scratch: string;
beforeAll(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-t37-')); });
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

const fresh = (name: string): string => fs.mkdtempSync(path.join(scratch, `${name}-`));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

const requireHere = createRequire(import.meta.url);

/**
 * Make `parse` throw for any source holding MARKER, on both copies of the parser `extract()` could
 * use (the CommonJS copy it loads shares `require.cache` with this file's, T-31 O5). Returns the undo.
 */
function failParses(): () => void {
  const copies = new Set<typeof treeSitter.Parser>([treeSitter.Parser, requireHere('web-tree-sitter').Parser]);
  const undo: Array<() => void> = [];
  for (const ParserClass of copies) {
    const real = ParserClass.prototype.parse;
    ParserClass.prototype.parse = function (this: treeSitter.Parser, ...args: Parameters<typeof real>) {
      if (typeof args[0] === 'string' && args[0].includes(MARKER)) throw new TypeError('injected by test/unread-pr-sides.test.ts');
      return real.apply(this, args);
    } as typeof real;
    undo.push(() => { ParserClass.prototype.parse = real; });
  }
  return () => { for (const u of undo) u(); };
}

interface Repo { root: string; base: string; head: string }

/**
 * A repository with one commit of change on top of a base, and a checkpoint digested at base (as a
 * reader's repo-tour has it) or at head (as GONS digests the tree it checked out).
 */
async function prRepo(
  atBase: Record<string, string>, atHead: Record<string, string>, checkpointAt: 'base' | 'head' = 'base',
): Promise<Repo> {
  const root = fresh('repo');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'repo-tour test');
  write(root, '.gitignore', '.repo-tour/\n');
  for (const [rel, body] of Object.entries(atBase)) write(root, rel, body);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  if (checkpointAt === 'base') await digest(root, { write: true });
  for (const [rel, body] of Object.entries(atHead)) write(root, rel, body);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'the change');
  const head = git(root, 'rev-parse', 'HEAD');
  if (checkpointAt === 'head') await digest(root, { write: true });
  return { root, base, head };
}

/** `top`, then `row` over and over to just past `mib` MiB, written in pieces. */
function writeBig(root: string, rel: string, top: string, row: string, mib = 65): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  const fd = fs.openSync(path.join(root, rel), 'w');
  fs.writeSync(fd, top);
  const piece = row.repeat(Math.ceil((1024 * 1024) / row.length));
  for (let i = 0; i < mib; i++) fs.writeSync(fd, piece);
  fs.closeSync(fd);
}

/** Lines added plus removed for one file, as git counts them. */
function linesOf(repo: Repo, rel: string): number {
  const row = git(repo.root, 'diff', '--numstat', `${repo.base}..${repo.head}`, '--', rel);
  const [add, del] = row.split('\t');
  return Number(add) + Number(del);
}

function hunksOf(repo: Repo, rels: string[]): Map<string, Hunk[]> {
  return new Map(rels.map((p) => [p, hunks(repo.root, repo.base, repo.head, p)] as const));
}

// ---- the fixture every PR below is made of
//
// `src/catalog.ts` exports alpha, beta and gamma, and the PR adds delta, epsilon and zeta (three lines, more
// than util's two, so main ranks it first even where it scores no higher). `src/app.ts` imports it, so a
// catalog that moved would send app.ts down the ripple. `src/util.ts` changes too, and is read on both
// sides: it is the control.

const CATALOG = 'export function alpha(): number { return 1; }\n'
  + 'export function beta(): number { return 2; }\n'
  + 'export const gamma = 3;\n';
const PR_ADDS = 'export const delta = 4;\nexport const epsilon = 5;\nexport const zeta = 6;\n';
const FAILS = `// ${MARKER}\n`;
const GENERATED = '// @generated by the schema tool\n';
const TS_ROW = 'export const t = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];\n';
const SHARED = {
  'src/app.ts': "import { alpha } from './catalog';\nexport function start(): number { return alpha(); }\n",
  'src/util.ts': 'export function helper(): number { return 1; }\n',
};
const UTIL_AFTER = 'export function helper(): number { return 2; }\n';

/** src/util.ts's delta on main, with no model: read on both sides, so it must not move by a character. */
const UTIL_ON_MAIN: FileDelta = {
  path: 'src/util.ts', status: 'M', linesChanged: 2, meaningDelta: 0.25, surface: NO_SURFACE,
  interpreted: false, reason: 'not interpreted on both sides — scored on structure alone', basis: 'structure',
};

async function flow(repo: Repo): Promise<PrFlowResult> {
  return runPrFlow(repo.root, { base: repo.base, head: repo.head, interpret: false });
}

const SIDE_WORDS = { head: 'on the head side', base: 'on the base side', both: 'on both sides' } as const;

// ------------------------------------------------------------- AC1: a side says what it could not read

describe('T-37 AC1: a PR side says what it could not read', () => {
  it('a file the parser fails on is listed with why, and has no extract', async () => {
    const undo = failParses();
    let side: Awaited<ReturnType<typeof sideAt>> | undefined;
    try {
      const repo = await prRepo({ ...SHARED, 'src/catalog.ts': CATALOG }, { 'src/catalog.ts': FAILS + CATALOG + PR_ADDS });
      side = await sideAt(repo.root, repo.head, ['src/catalog.ts']);
      expect(side.extracts.map((e) => e.path)).toEqual([]);
      expect((side as { unparsed?: unknown }).unparsed, 'a PR side dropped what extract() said it could not read')
        .toEqual([{ path: 'src/catalog.ts', reason: INJECTED }]);
    } finally {
      side?.dispose();
      undo();
    }
  }, 60_000);

  it('files git will not hand over in one piece (real, 65 MiB each): listed when this side would parse them, kept by their class when it would not', async () => {
    const repo = await prRepo({ 'src/big.ts': CATALOG }, {});
    // Committed at head without being digested: what a side has to fetch from git.
    writeBig(repo.root, 'src/big.ts', CATALOG, TS_ROW);
    writeBig(repo.root, 'data/big.csv', 'a,b\n', '1,2,3,4,5,6,7,8,9,10\n');
    writeBig(repo.root, 'package-lock.json', '{\n', '  "x": 1,\n');
    writeBig(repo.root, 'src/gen.js', GENERATED, TS_ROW);
    writeBig(repo.root, 'node_modules/pkg/huge.js', '', TS_ROW);
    git(repo.root, 'add', '-A');
    git(repo.root, 'commit', '-q', '-m', 'five files grow past 64 MiB');
    const head = git(repo.root, 'rev-parse', 'HEAD');

    const side = await sideAt(repo.root, head, ['src/big.ts', 'data/big.csv', 'package-lock.json', 'src/gen.js', 'node_modules/pkg/huge.js']);
    // A rename's side is read at the old path and reported at the new one.
    const renamed = await sideAt(repo.root, head, ['src/renamed.ts'], new Map([['src/renamed.ts', 'src/big.ts']]));
    try {
      const unparsed = (side as { unparsed?: Array<{ path: string; reason: string }> }).unparsed;
      expect(unparsed?.map((u) => u.path), 'a big file was dropped as though the PR had deleted it, or one repo-tour never parses was called unread')
        .toEqual(['src/big.ts']);
      expect(unparsed?.[0]?.reason, 'the reason does not say the file was too big to read from git').toMatch(/65\.\d MiB.*64 MiB/);
      expect(side.files.map((f) => f.path), 'a file git did not hand over was written into the side').toEqual([]);
      const unfetched = (side as { unfetched?: Array<{ path: string; classification: string }> }).unfetched;
      expect(unfetched?.map((f) => `${f.path} ${f.classification}`), 'a big file this side would skip for its class was not kept as such')
        .toEqual(['data/big.csv data', 'package-lock.json lockfile', 'src/gen.js generated']);
      expect((renamed as { unparsed?: Array<{ path: string }> }).unparsed?.map((u) => u.path),
        'a renamed file git would not hand over is reported under its old path').toEqual(['src/renamed.ts']);
    } finally {
      side.dispose();
      renamed.dispose();
    }
  }, 180_000);

  it('a file this side has but git cannot produce (an offline partial clone) is listed, not dropped as absent', async () => {
    const origin = await prRepo({ ...SHARED, 'src/catalog.ts': CATALOG }, { 'src/catalog.ts': CATALOG + PR_ADDS });
    git(origin.root, 'config', 'uploadpack.allowFilter', 'true');
    const clone = path.join(fresh('partial'), 'clone');
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', pathToFileURL(origin.root).href, clone], { stdio: 'ignore' });
    git(clone, 'checkout', '-q', '--detach', origin.head); // fetches head's blobs; the base's catalog stays unfetched
    git(clone, 'remote', 'set-url', 'origin', pathToFileURL(path.join(origin.root, 'gone')).href); // offline from here
    const side = await sideAt(clone, origin.base, ['src/catalog.ts']);
    try {
      expect(side.files).toEqual([]);
      const unparsed = (side as { unparsed?: Array<{ path: string; reason: string }> }).unparsed;
      expect(unparsed?.map((u) => u.path), 'a file the base side has, that git could not fetch, was dropped as though the PR had added it')
        .toEqual(['src/catalog.ts']);
      expect(unparsed?.[0]?.reason).toMatch(/^git could not show it/);
    } finally {
      side.dispose();
    }
  }, 60_000);

  it('a file the side does not have (added in the PR) is not listed: absent is not unread (guard)', async () => {
    const repo = await prRepo({ ...SHARED }, { 'src/new.ts': CATALOG });
    const side = await sideAt(repo.root, repo.base, ['src/new.ts']);
    try {
      expect(side.files).toEqual([]);
      expect((side as { unparsed?: unknown }).unparsed ?? [], 'a file added in the PR was called unread on the base side').toEqual([]);
    } finally {
      side.dispose();
    }
  }, 60_000);
});

// ------------------------------------------------- AC2-AC5: a modified file not read on one side, end to end

for (const which of ['head', 'base', 'both'] as const) {
  describe(`T-37 AC2-AC5: a modified file not read ${SIDE_WORDS[which]}`, () => {
    let repo: Repo;
    let r: PrFlowResult;
    const expectUnread = which === 'head' ? { head: INJECTED } : which === 'base' ? { base: INJECTED } : { base: INJECTED, head: INJECTED };

    beforeAll(async () => {
      const undo = failParses();
      try {
        repo = await prRepo(
          { ...SHARED, 'src/catalog.ts': (which === 'head' ? '' : FAILS) + CATALOG },
          { 'src/catalog.ts': (which === 'base' ? '' : FAILS) + CATALOG + PR_ADDS, 'src/util.ts': UTIL_AFTER },
        );
        r = await flow(repo);
      } finally {
        undo();
      }
    }, 120_000);

    const catalog = (): FileDelta => r.deltas.find((d) => d.path === 'src/catalog.ts')!;

    it('its delta says it was not read, on which side and why', () => {
      expect((catalog() as { unread?: unknown }).unread, `the delta does not say the file was not read ${SIDE_WORDS[which]}`)
        .toEqual(expectUnread);
      expect(catalog().reason, 'the reason does not say the file was not read, or where').toContain(`not read ${SIDE_WORDS[which]}`);
    });

    it('it claims no public surface, and is not scored', () => {
      expect(catalog().surface, `a file not read ${SIDE_WORDS[which]} was scored as its whole public surface ${which === 'base' ? 'added' : 'removed'}`)
        .toEqual(NO_SURFACE);
      expect(catalog().basis, 'the file was scored on a basis it could not have').toBe('unread');
      expect(band(catalog().meaningDelta), 'a file that was not read counts as moved').not.toBe('moved');
    });

    it('its status and line count still show', () => {
      expect(catalog().status).toBe('M');
      expect(catalog().linesChanged).toBe(linesOf(repo, 'src/catalog.ts'));
    });

    it('the file that imports it is not sent down the ripple', () => {
      expect(r.ripple.reinterpret, 'src/app.ts was listed as reached by a change nobody read').not.toContain('src/app.ts');
      expect(r.ripple.structuralOnly).not.toContain('src/app.ts');
    });

    it('it comes after every file that was scored', () => {
      expect(r.deltas.map((d) => d.path), 'a file that was not scored was ranked among the scored ones')
        .toEqual(['src/util.ts', 'src/catalog.ts']);
    });

    it('a file read on both sides scores exactly as on main (guard)', () => {
      expect(r.deltas.find((d) => d.path === 'src/util.ts')).toStrictEqual(UTIL_ON_MAIN);
    });

    it('the page ranks the files that were read among themselves', () => {
      const detail = /<div class="stop" data-file="src\/util\.ts">[\s\S]*?<div class="detail">([\s\S]*?)<\/div>/.exec(r.html)?.[1] ?? '';
      expect(detail, 'a file that was not scored is counted in the rank of those that were')
        .toContain('Ranked 1 of 1 by how far the meaning moved (0.25).');
    });

    it('the tour: one stop says it was not read, where and why, and no file chapter holds it', () => {
      const plan = buildPrTour({
        refs: r.refs, deltas: r.deltas, ripple: r.ripple, staleness: r.staleness,
        hunksByFile: hunksOf(repo, ['src/catalog.ts', 'src/util.ts']),
      });
      const stop = plan.steps.find((s) => /could not read/i.test(s.title));
      expect(stop, 'the tour has no stop that says a file was not read').toBeDefined();
      expect(stop!.text).toContain('src/catalog.ts');
      expect(stop!.text).toContain(`not read ${SIDE_WORDS[which]}: ${INJECTED}`);
      expect(stop!.file).toBe('src/catalog.ts');

      const inChapters = plan.steps.filter((s) => s.chapter?.key === 'pr-moved' || s.chapter?.key === 'pr-quiet').map((s) => s.file);
      expect(inChapters, 'a file nobody read sits in a chapter about how far its meaning moved').not.toContain('src/catalog.ts');
      expect(plan.steps[0]!.summary, 'the opening does not count the files as they were scored')
        .toMatch(/^2 files changed\. 1 moved in meaning, 0 did not, and 1 could not be read, so it is not scored\. /);
      const said = plan.steps.map((s) => `${s.summary ?? ''}\n${s.text}`).join('\n');
      expect(said, 'the tour still claims the surface moved').not.toMatch(/public surface moved/);
      expect(said, 'the tour still lists the symbols of a file it did not read').not.toMatch(/[+−]alpha/);
    });

    it('the page: a notice under the top bar names the file, the side and why', () => {
      const bar = /<div class="bar unread">([\s\S]*?)<\/div>/.exec(r.html)?.[1];
      expect(bar, 'the PR page has no "not read" notice').toBeDefined();
      expect(bar).toContain('1 file was not read');
      expect(bar).toContain('<code>src/catalog.ts</code>');
      expect(bar).toContain(`${SIDE_WORDS[which]}: ${INJECTED}`);
      expect(r.html.indexOf('class="bar unread"'), 'the notice is not between the top bar and the panels')
        .toBeGreaterThan(r.html.indexOf('<div class="topbar">'));
      expect(r.html.indexOf('class="bar unread"')).toBeLessThan(r.html.indexOf('<div class="layout">'));
    });

    it('the page: its row in Files is tagged "not read", and only its row', () => {
      const rows = new Map([...r.html.matchAll(/<button class="prfile" data-file="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)]
        .map((m) => [m[1]!, m[2]!] as const));
      expect(rows.get('src/catalog.ts'), 'the file\'s row does not say it was not read')
        .toMatch(new RegExp(`<span class="nr" title="not read ${SIDE_WORDS[which]}: ${INJECTED}">not read</span>`));
      expect(rows.get('src/util.ts'), 'a file that was read is tagged "not read"').not.toContain('class="nr"');
    });

    it('the page: its stop says "not read" where the score was, and claims no surface', () => {
      const stop = /<div class="stop" data-file="src\/catalog\.ts">([\s\S]*?)<div class="detail">([\s\S]*?)<\/div>/.exec(r.html);
      expect(stop, 'the page has no stop for the file').not.toBeNull();
      const [, head, detail] = stop!;
      expect(/<span class="chip">([^<]*)<\/span>/.exec(head!)?.[1], 'the stop shows a meaning band for a file nobody read')
        .toBe('not read');
      const body = /<div class="body">([^<]*)<\/div>/.exec(head!)?.[1] ?? '';
      expect(body, 'the stop does not open by saying the file was not read').toMatch(new RegExp(`^Not read ${SIDE_WORDS[which]}: `));
      expect(detail, 'the stop\'s detail does not say the surface was not compared').toContain('Public surface not compared');
      expect(detail).not.toMatch(/Public surface unchanged|Public surface: [+−]/);
      expect(detail, 'the stop is ranked by a meaning nobody read').not.toMatch(/Ranked \d+ of/);
      expect(r.html, 'the page still says the surface moved').not.toMatch(/public surface moved/);
    });

    it('the page: the Ask panel is told the file was not read', () => {
      const meta = JSON.parse(/var META = (\{.*?\});\n/s.exec(r.html)![1]!) as { files: Record<string, { narrative: string }> };
      expect(meta.files['src/catalog.ts']!.narrative, 'the Ask panel is told something other than that the file was not read')
        .toMatch(new RegExp(`^Not read ${SIDE_WORDS[which]}: `));
    });

    it('the page: every script on it parses (guard)', () => {
      const scripts = [...r.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(scripts.length).toBeGreaterThan(2);
      for (const code of scripts) expect(() => new Function(code)).not.toThrow();
    });
  });
}

// ------------------------------------------------------------- D7: a class that differs between the sides

describe('T-37 D7: a file whose class differs between the sides', () => {
  it('a modified file that gains a generated-file header at head is not scored, and says why', async () => {
    const repo = await prRepo(
      { ...SHARED, 'src/catalog.ts': CATALOG },
      { 'src/catalog.ts': GENERATED + CATALOG + PR_ADDS, 'src/util.ts': UTIL_AFTER },
    );
    const r = await flow(repo);
    const d = r.deltas.find((x) => x.path === 'src/catalog.ts')!;
    expect(d.surface, 'a file read only on the base side was scored as its whole public surface removed').toEqual(NO_SURFACE);
    expect((d as { unread?: { head?: string } }).unread?.head, 'the delta does not say the head side was treated as generated')
      .toMatch(/^treated as generated/);
    expect(d.basis).toBe('unread');
    expect(r.ripple.reinterpret).not.toContain('src/app.ts');
    expect(r.html).toContain('class="bar unread"');
  }, 120_000);

  it('a file treated as generated on both sides shows as on main: no notice, no tag (guard)', async () => {
    const repo = await prRepo(
      { ...SHARED, 'src/catalog.ts': GENERATED + CATALOG },
      { 'src/catalog.ts': GENERATED + CATALOG + PR_ADDS, 'src/util.ts': UTIL_AFTER },
    );
    const r = await flow(repo);
    expect(r.deltas.find((x) => x.path === 'src/catalog.ts')).toStrictEqual({
      path: 'src/catalog.ts', status: 'M', linesChanged: 3, meaningDelta: 0.25, surface: NO_SURFACE,
      interpreted: false, reason: 'not interpreted on both sides — scored on structure alone', basis: 'structure',
    });
    expect(r.html, 'a notice for a file skipped on both sides, as every lock file would be').not.toContain('class="bar unread"');
    expect(r.html).not.toContain('<span class="nr"');
  }, 120_000);

  it('a PR where every file was read shows as on main: no notice, no tag (guard)', async () => {
    const repo = await prRepo(
      { ...SHARED, 'src/catalog.ts': CATALOG },
      { 'src/catalog.ts': CATALOG + PR_ADDS, 'src/util.ts': UTIL_AFTER },
    );
    const r = await flow(repo);
    expect(r.deltas).toStrictEqual([
      {
        path: 'src/catalog.ts', status: 'M', linesChanged: 3, meaningDelta: 0.7,
        surface: { added: ['delta', 'epsilon', 'zeta'], removed: [], changed: [] }, interpreted: false,
        reason: 'the public surface moved (3 added) — other code can feel this', basis: 'structure',
      },
      UTIL_ON_MAIN,
    ]);
    expect(r.ripple.reinterpret).toEqual(['src/app.ts']);
    expect(r.html).not.toContain('class="bar unread"');
    expect(r.html).not.toContain('<span class="nr"');
  }, 120_000);
});

// ---------------------------------------------------- B1: big files repo-tour would never parse stay as main shows them

describe('T-37 review B1: a file too big to fetch is judged by its class, as a fetched one is', () => {
  it('a big data file shows as on main; a file read at base that is big and generated at head is not scored, and says why', async () => {
    const repo = await prRepo(
      { ...SHARED, 'src/gen.js': 'export const t = [1, 2, 3];\n', 'data/big.csv': 'a,b\n1,2\n' },
      { 'src/util.ts': UTIL_AFTER },
    );
    writeBig(repo.root, 'src/gen.js', GENERATED, TS_ROW);
    writeBig(repo.root, 'data/big.csv', 'a,b\n', '1,2,3,4,5,6,7,8,9,10\n');
    git(repo.root, 'add', '-A');
    git(repo.root, 'commit', '-q', '-m', 'two files grow past 64 MiB');
    const pr = { ...repo, head: git(repo.root, 'rev-parse', 'HEAD') };
    const r = await flow(pr);

    const gen = r.deltas.find((d) => d.path === 'src/gen.js')! as FileDelta & { unread?: unknown };
    expect(gen.unread, 'a file read at base and generated at head does not say why its head side was not read')
      .toEqual({ head: 'treated as generated (a generated-file header in its first lines)' });
    expect(gen.basis).toBe('unread');
    expect(gen.surface, 'a file read only at base read as its whole surface removed').toEqual(NO_SURFACE);

    expect(r.deltas.find((d) => d.path === 'data/big.csv'), 'a big data file repo-tour never parses was flagged, or scored otherwise than on main')
      .toStrictEqual({
        path: 'data/big.csv', status: 'M', linesChanged: linesOf(pr, 'data/big.csv'), meaningDelta: 0.25, surface: NO_SURFACE,
        interpreted: false, reason: 'not interpreted on both sides — scored on structure alone', basis: 'structure',
      });
    const bar = /<div class="bar unread">([\s\S]*?)<\/div>/.exec(r.html)?.[1] ?? '';
    expect(bar).toContain('src/gen.js');
    expect(bar, 'the notice names a big data file repo-tour never parses').not.toContain('data/big.csv');
  }, 180_000);
});

// ----------------------------------------------------------- added and deleted files keep their status score

describe('T-37: an added file not read at head keeps main\'s score, and gains the notice', () => {
  let r: PrFlowResult;

  beforeAll(async () => {
    const undo = failParses();
    try {
      // The checkpoint is digested at head, as GONS digests the tree it checked out, so the file that
      // imports the new one is in its graph and main's ripple reaches it.
      const repo = await prRepo(
        { ...SHARED, 'src/uses.ts': "import { alpha } from './added';\nexport const uses = alpha;\n" },
        { 'src/added.ts': FAILS + CATALOG },
        'head',
      );
      r = await flow(repo);
    } finally {
      undo();
    }
  }, 120_000);

  it('its score, band and ripple are main\'s (guard)', () => {
    const d = r.deltas.find((x) => x.path === 'src/added.ts')!;
    expect(d.meaningDelta).toBe(1);
    expect(d.basis).toBe('status');
    expect(d.reason).toBe('new file — all of it is new meaning');
    expect(d.surface).toEqual(NO_SURFACE);
    expect(r.ripple.reinterpret).toEqual(['src/uses.ts']);
  });

  it('its delta, row and the page say it was not read at head', () => {
    const d = r.deltas.find((x) => x.path === 'src/added.ts')! as FileDelta & { unread?: unknown };
    expect(d.unread, 'an added file that was not read does not say so').toEqual({ head: INJECTED });
    expect(r.html, 'the page has no notice for the added file it did not read').toMatch(/<div class="bar unread">[\s\S]*src\/added\.ts/);
    const row = /<button class="prfile" data-file="src\/added\.ts"[^>]*>([\s\S]*?)<\/button>/.exec(r.html)?.[1] ?? '';
    expect(row, 'the added file\'s row is not tagged "not read"').toContain('<span class="nr"');
    const stop = /<div class="stop" data-file="src\/added\.ts">([\s\S]*?)<div class="detail">([\s\S]*?)<\/div>/.exec(r.html)!;
    expect(/<span class="chip">([^<]*)<\/span>/.exec(stop[1]!)?.[1], 'an added file lost its band').toBe('moved');
    expect(stop[2], 'the added file\'s detail says its surface is unchanged when nobody read it').not.toContain('Public surface unchanged');
    expect(stop[2], 'an added file has nothing to compare its surface with: it is not listed').toContain('Public surface not listed');
    expect(/<div class="body">([^<]*)<\/div>/.exec(stop[1]!)?.[1], 'the added file\'s stop does not open by saying it was not read')
      .toBe(`Not read on the head side: ${INJECTED}. New file — all of it is new meaning. Its public surface is not listed.`);
  });
});

// ----------------------------------------------------------------------------------- units: the rule

type SideState = { kind: 'read' } | { kind: 'failed'; reason: string } | { kind: 'skipped'; reason: string } | { kind: 'absent' };

describe('T-37 D7: which sides count as not read', () => {
  const read: SideState = { kind: 'read' };
  const absent: SideState = { kind: 'absent' };
  const failed = (reason: string): SideState => ({ kind: 'failed', reason });
  const skipped = (reason: string): SideState => ({ kind: 'skipped', reason });

  it('a side that failed always counts; a side skipped for its class counts opposite a side that was read or failed', () => {
    const unreadOf = (delta as Record<string, unknown>)['unreadOf'] as ((b: SideState, a: SideState) => unknown) | undefined;
    expect(typeof unreadOf, 'src/delta.ts has no unreadOf: the rule for which sides of a change were not read').toBe('function');
    const cases: Array<[SideState, SideState, unknown]> = [
      [read, read, undefined],
      [read, failed('x'), { head: 'x' }],
      [failed('x'), read, { base: 'x' }],
      [failed('x'), failed('y'), { base: 'x', head: 'y' }],
      [read, skipped('g'), { head: 'g' }],
      [skipped('g'), read, { base: 'g' }],
      [skipped('g'), skipped('g'), undefined],
      [absent, skipped('g'), undefined],
      [skipped('g'), absent, undefined],
      [absent, failed('x'), { head: 'x' }],
      [failed('x'), absent, { base: 'x' }],
      // review N2: naming only the failed side read as though the other side was read
      [skipped('g'), failed('x'), { base: 'g', head: 'x' }],
      [failed('x'), skipped('g'), { base: 'x', head: 'g' }],
      [absent, read, undefined],
      [read, absent, undefined],
    ];
    for (const [before, after, want] of cases) {
      expect(unreadOf!(before, after), `${before.kind} → ${after.kind}`).toEqual(want);
    }
  });
});

// ------------------------------------------------------------------------- units: the score and the order

describe('T-37: the score of a file with a side not read', () => {
  const meaning = { what: 'Exports the catalog.', why: 'Entry point.', summary: 's', alternatives: [] };
  const ex = (p: string) => ({
    path: p, language: 'typescript', parseErrors: 0, imports: [],
    symbols: ['alpha', 'beta'].map((name) => ({ name, kind: 'function' as const, line: 1, endLine: 1, exported: true })),
  });
  const verdict = { magnitude: 0.9, headline: 'Rewrites the catalog.', kind: 'surface', source: 'model' };

  it('a model verdict does not score a modified file that was not read', () => {
    const d = fileDelta({
      path: 'src/catalog.ts', status: 'M', linesChanged: 3, before: [meaning], after: [meaning],
      beforeExtract: ex('src/catalog.ts') as never, afterExtract: undefined, adjudication: verdict,
      unread: { head: 'r' },
    } as Parameters<typeof fileDelta>[0]);
    expect(d.basis, 'a model verdict scored a file that was not read').toBe('unread');
    expect(d.meaningDelta).toBe(0);
    expect(d.surface).toEqual(NO_SURFACE);
  });

  it('a renamed file not read on its base side is not scored either', () => {
    const d = fileDelta({
      path: 'src/new-name.ts', status: 'R', linesChanged: 0, before: [], after: [],
      beforeExtract: undefined, afterExtract: ex('src/new-name.ts') as never, unread: { base: 'r' },
    } as Parameters<typeof fileDelta>[0]);
    expect(d.surface, 'a renamed file not read on its base side read as all of its surface added').toEqual(NO_SURFACE);
    expect(d.basis).toBe('unread');
  });

  it('a deleted file not read on its base side keeps main\'s score, and says it was not read', () => {
    const d = fileDelta({
      path: 'src/gone.ts', status: 'D', linesChanged: 9, before: [], after: [],
      beforeExtract: undefined, afterExtract: undefined, unread: { base: 'r' },
    } as Parameters<typeof fileDelta>[0]);
    expect(d.meaningDelta).toBe(1);
    expect(d.basis).toBe('status');
    expect(d.reason).toBe('deleted — whatever this meant is gone');
    expect((d as { unread?: unknown }).unread, 'a deleted file that was not read does not say so').toEqual({ base: 'r' });
  });

  it('the order: a file that was not scored comes after every scored file; scored files keep main\'s order', () => {
    const mk = (p: string, score: number, lines: number, extra: Partial<FileDelta> = {}): FileDelta => ({
      path: p, status: 'M', linesChanged: lines, meaningDelta: score, surface: NO_SURFACE,
      interpreted: false, reason: 'r', basis: 'structure', ...extra,
    });
    const notScored = mk('a-unread.ts', 0, 900, { basis: 'unread' as FileDelta['basis'], unread: { head: 'r' } } as Partial<FileDelta>);
    const added = mk('z-added.ts', 1, 1, { status: 'A', basis: 'status', unread: { head: 'r' } } as Partial<FileDelta>);
    const ordered = orderByMeaning([notScored, mk('b.ts', 0, 1), mk('c.ts', 0.6, 2), added]).map((d) => d.path);
    expect(ordered, 'a file that was not scored was ranked by a meaning nobody read').toEqual(['z-added.ts', 'c.ts', 'b.ts', 'a-unread.ts']);
  });
});

// ------------------------------------------------------------------------ units: the words, and the tour's stop

describe('T-37: how a side not read is said', () => {
  it('one wording for the side and why, each reason against its own side', () => {
    const notReadOn = (delta as Record<string, unknown>)['notReadOn'] as ((u: object) => string) | undefined;
    expect(typeof notReadOn, 'src/delta.ts has no notReadOn: the one wording of side and why').toBe('function');
    expect(notReadOn!({ head: 'h' })).toBe('on the head side: h');
    expect(notReadOn!({ base: 'b' })).toBe('on the base side: b');
    expect(notReadOn!({ base: 'x', head: 'x' })).toBe('on both sides: x');
    expect(notReadOn!({ base: 'b', head: 'h' }), 'two reasons against the wrong sides').toBe('on both sides (base: b; head: h)');
  });

  const refs = {
    number: null, url: null, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null,
    baseLabel: 'main', headLabel: 'feature', baseAhead: 0,
    prose: { title: 'A change', body: null, commits: [], issues: [], source: 'git-only' as const },
  };
  const tour = (deltas: FileDelta[]) => buildPrTour({
    refs, deltas, ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
    staleness: { sha: 'b'.repeat(40), behind: 0, overlap: [], current: true }, hunksByFile: new Map(),
  });
  const notScored = {
    path: 'src/catalog.ts', status: 'M', linesChanged: 4, meaningDelta: 0, surface: NO_SURFACE, interpreted: false,
    reason: 'r', basis: 'unread', unread: { head: 'h' },
  } as unknown as FileDelta;
  const added = {
    path: 'src/added.ts', status: 'A', linesChanged: 9, meaningDelta: 1, surface: NO_SURFACE, interpreted: false,
    reason: 'new file — all of it is new meaning', basis: 'status', unread: { head: 'h' },
  } as unknown as FileDelta;

  it('the tour\'s stop says what not reading means, for a modified file and for an added one', () => {
    const plan = tour([notScored, added]);
    const stop = plan.steps.find((s) => /could not read/i.test(s.title));
    expect(stop?.text, 'the tour has no stop for the files it could not read').toBeDefined();
    expect(stop!.text).toContain('  · src/catalog.ts (modified): not read on the head side: h');
    expect(stop!.text).toContain('  · src/added.ts (added): not read on the head side: h');
    expect(stop!.text, 'the stop does not say what not reading means for a modified file').toContain('is not scored');
    expect(stop!.text, 'the stop does not say what not reading means for an added file').toContain('keeps its place as new or gone');
    const own = plan.steps.find((s) => s.file === 'src/added.ts' && s.chapter?.key === 'pr-moved');
    expect(own?.text, 'an added file that was not read lost its own stop').toContain('Public surface not listed: not read on the head side: h.');
  });

  it('a tour where no file was read on both sides does not ask to be read in order', () => {
    const opening = tour([notScored]).steps[0]!.summary ?? '';
    expect(opening, 'the opening orders files it did not rank').not.toContain('Read them in this order.');
    expect(opening).toContain('none is ranked');
  });
});

// ------------------------------------------------------------------------------- units: the page, with a model

describe('T-37: the PR page when a model read the diff of a file that was not read', () => {
  const refs = {
    number: 7, url: null, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null,
    baseLabel: 'main', headLabel: 'feature', baseAhead: 0,
    prose: { title: 'A change', body: null, commits: [], issues: [], source: 'git-only' as const },
  };
  const d = {
    path: 'src/catalog.ts', status: 'M', linesChanged: 2, meaningDelta: 0, surface: NO_SURFACE, interpreted: true,
    reason: 'not read on the head side: x', basis: 'unread', unread: { head: 'the parser ran out of memory on it (its limit is 2 GiB)' },
  } as unknown as FileDelta;
  const verdict = {
    changed: true, magnitude: 0.9, kind: 'surface' as const, source: 'model' as const,
    headline: 'Adds forty thousand rows.', narrative: 'The catalog gains forty thousand generated rows.',
  };
  const html = renderPrView({
    refs, deltas: [d], diffs: new Map([['src/catalog.ts', parseUnified('src/catalog.ts', '@@ -1,1 +1,2 @@\n a\n+b')]]),
    steps: [], ripple: { reinterpret: [], structuralOnly: [], reachable: 0 }, verdicts: new Map([['src/catalog.ts', verdict]]),
  });

  it('the model\'s words follow the not-read sentence, labelled as its reading of the diff', () => {
    const body = /<div class="body">([^<]*)<\/div>/.exec(html)?.[1] ?? '';
    expect(body, 'the stop does not open by saying the file was not read')
      .toMatch(/^Not read on the head side: the parser ran out of memory on it \(its limit is 2 GiB\)\./);
    expect(body, 'the model\'s reading of the diff is missing, or not labelled as such')
      .toContain('The model\'s reading of the diff: The catalog gains forty thousand generated rows.');
  });

  it('the row says what git says (modified), not the model\'s kind of change', () => {
    const row = /<button class="prfile"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '';
    expect(row, 'the row calls a change nobody read a public-surface change').not.toContain('public surface');
    expect(row).toContain('<span class="chip">modified</span>');
  });

  it('a page handed its files in any order ranks the scored ones among themselves', () => {
    const scored = { ...d, path: 'src/util.ts', meaningDelta: 0.25, basis: 'structure', unread: undefined, reason: 'r' } as unknown as FileDelta;
    const page = renderPrView({
      refs, deltas: [d, scored], diffs: new Map(), steps: [], ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
      verdicts: new Map(),
    });
    const detail = /<div class="stop" data-file="src\/util\.ts">[\s\S]*?<div class="detail">([\s\S]*?)<\/div>/.exec(page)?.[1] ?? '';
    expect(detail, 'a file that was not scored took a place in the rank').toContain('Ranked 1 of 1 by how far the meaning moved (0.25).');
  });

  it('an added file not read keeps its status, and the model\'s words still come after the not-read sentence (review N1)', () => {
    const added = {
      path: 'src/added.ts', status: 'A', linesChanged: 9, meaningDelta: 1, surface: NO_SURFACE, interpreted: false,
      reason: 'new file — all of it is new meaning', basis: 'status', unread: { head: 'h' },
    } as unknown as FileDelta;
    const page = renderPrView({
      refs, deltas: [added], diffs: new Map(), steps: [], ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
      verdicts: new Map([['src/added.ts', verdict]]),
    });
    expect(/<div class="body">([^<]*)<\/div>/.exec(page)?.[1], 'the model\'s reading came first, or unlabelled')
      .toBe('Not read on the head side: h. New file — all of it is new meaning. Its public surface is not listed. '
        + 'The model\'s reading of the diff: The catalog gains forty thousand generated rows.');
    expect(/<span class="chip">([^<]*)<\/span>\s*<h4>/.exec(page)?.[1], 'an added file lost its band').toBe('moved');
  });
});

// ------------------------------------------------------------------------ AC6: what the CLI prints, as GONS runs it

describe('T-37 AC6: `repo-tour pr` from an empty folder says what it could not read', () => {
  it('the not-read block, the table row, the page it writes, and exit 0', async () => {
    const undo = failParses();
    let repo: Repo;
    try {
      repo = await prRepo(
        { ...SHARED, 'src/catalog.ts': CATALOG },
        { 'src/catalog.ts': FAILS + CATALOG + PR_ADDS, 'src/util.ts': UTIL_AFTER },
      );
    } finally {
      undo();
    }
    // The same failure in the CLI's own process, through the copy of the parser it will load.
    const preload = path.join(fresh('preload'), 'fail-parses.mjs');
    fs.writeFileSync(preload, `import { createRequire } from 'node:module';
const { Parser } = createRequire(${JSON.stringify(path.join(REPO_ROOT, 'src', 'extract.ts'))})('web-tree-sitter');
const real = Parser.prototype.parse;
Parser.prototype.parse = function (...args) {
  if (typeof args[0] === 'string' && args[0].includes(${JSON.stringify(MARKER)})) throw new TypeError('injected by test/unread-pr-sides.test.ts');
  return real.apply(this, args);
};
`);
    const view = path.join(fresh('view'), 'pr.html');
    const child = spawn(process.execPath, [
      '--import', TSX, '--import', pathToFileURL(preload).href, path.join(REPO_ROOT, 'src', 'cli.ts'),
      'pr', repo.root, '--base', repo.base, '--head', repo.head, '--no-interpret', '--view', view,
    ], { cwd: fresh('cwd'), env: { ...process.env, TMPDIR: fresh('tmp') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));

    expect(code, `the PR tour did not finish cleanly:\n${out}`).toBe(0);
    expect(out, 'the CLI never says which file it could not read, on which side, or why')
      .toContain(`src/catalog.ts: not read on the head side: ${INJECTED} — not scored`);
    expect(out, 'the CLI\'s table gives a score and a band to a file nobody read')
      .toMatch(/^ {2}— {8}\d+ +not read +unread +src\/catalog\.ts$/m);
    expect(out, 'the file that was read lost its row').toMatch(/^ {2}0\.25 +2 +shifted +structure +src\/util\.ts$/m);
    expect(fs.readFileSync(view, 'utf8'), 'the page the CLI wrote (the one GONS serves) has no notice').toContain('class="bar unread"');
  }, 120_000);
});
