/**
 * T-58 — PR tours give wrong answers about the diff itself (T-57's items 18-27).
 *
 * Ten shapes a real pull request holds, each toured wrongly on main: a file that becomes a directory failed the whole
 * tour; a path git quotes was read on neither side; a type change (file to symlink) was dropped; a renamed file's counts
 * were 0 and the whole file; a diff over 32 MiB read as "a rename, a mode change, or a binary file"; a checkpoint GONS
 * takes at head read as having missed every file, and the page never said what the tour's steps say; a long line, or a
 * long file, went into a model prompt whole; a binary file's bytes went to the model as text; a package folder showed no
 * diff at all; and the CLI's table ran a seven-digit count into the next column.
 *
 * POSITIVES fail on main, each with its own message. GUARDS pass on main by design: they pin what must not move.
 * Model calls go to a stand-in `claude` (REPO_TOUR_CLAUDE_BIN) that keeps every prompt; content is salted per run so a
 * cached answer never hides a prompt.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { digest } from '../src/digest.js';
import { sideAt, staleness } from '../src/checkpoint.js';
import { runPrFlow, type PrFlowResult } from '../src/prflow.js';
import { diffSet, hunks, lineCounts, type PrRefs } from '../src/pr.js';
import { parseUnified, type FileDiff } from '../src/diff.js';
import { renderPrView } from '../src/prview.js';
import { buildPrTour } from '../src/prtour.js';
import { interpretStops, stopKey } from '../src/interpret.js';
import type { FileDelta } from '../src/delta.js';
import type { FileRecord } from '../src/types.js';
import type { LlmReply } from '../src/llm.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

let scratch: string;
let FAKE: string;
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-t58-'));
  FAKE = fakeClaude();
});
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

const fresh = (name: string): string => fs.mkdtempSync(path.join(scratch, `${name}-`));
/** Content no earlier run has seen, so no cached model answer stands in for the prompt under test. */
const SALT = `${process.pid}-${Date.now()}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

function write(root: string, rel: string, body: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

function writeAll(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
}

/** `top`, then `row` over and over to just past `mib` MiB, written in pieces. */
function writeBig(root: string, rel: string, top: string, row: string, mib: number): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  const fd = fs.openSync(path.join(root, rel), 'w');
  fs.writeSync(fd, top);
  const piece = row.repeat(Math.ceil((1024 * 1024) / row.length));
  for (let i = 0; i < mib; i++) fs.writeSync(fd, piece);
  fs.closeSync(fd);
}

interface Repo { root: string; base: string; head: string; fork: string }

/**
 * A repository: `base` committed on main, `head` on a branch from it (it may run git there too), and with `mainMoves`
 * one more commit on main after the branch forked, so the PR is toured against main's tip. The checkpoint is digested
 * where a reader's repo-tour has it (`base`), where GONS takes it (`head`), or at the fork (`fork`, behind a base that
 * moved), from `folder` when the tour runs in a monorepo package's folder.
 */
async function prRepo(o: {
  base: (root: string) => void;
  head: (root: string) => void;
  mainMoves?: (root: string) => void;
  checkpoint?: 'base' | 'head' | 'fork';
  folder?: string;
}): Promise<Repo> {
  const root = fresh('repo');
  git(root, 'init', '-q');
  git(root, 'checkout', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'repo-tour test');
  write(root, '.gitignore', '.repo-tour/\n');
  o.base(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const fork = git(root, 'rev-parse', 'HEAD');
  const scan = o.folder ? path.join(root, o.folder) : root;
  if (o.checkpoint === 'fork') await digest(scan, { write: true });
  git(root, 'checkout', '-q', '-b', 'feature');
  o.head(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'the change');
  const head = git(root, 'rev-parse', 'HEAD');
  if (o.checkpoint === 'head') await digest(scan, { write: true });
  git(root, 'checkout', '-q', 'main');
  if (o.mainMoves) {
    o.mainMoves(root);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'main moves on');
  }
  const base = git(root, 'rev-parse', 'HEAD');
  if ((o.checkpoint ?? 'base') === 'base') await digest(scan, { write: true });
  return { root, base, head, fork };
}

interface Flow { r?: PrFlowResult; error?: string }

async function flow(repo: Repo, opts: { interpret?: boolean; at?: string } = {}): Promise<Flow> {
  try {
    return { r: await runPrFlow(opts.at ?? repo.root, { base: repo.base, head: repo.head, interpret: opts.interpret ?? false }) };
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}` };
  }
}

/** A stand-in `claude`: keeps every prompt in $T58_PROMPTS, answers a verdict or one meaning per excerpt. */
function fakeClaude(): string {
  const bin = path.join(fresh('fake'), 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === '--version') { process.stdout.write('0.0.0 (T-58 test stand-in)\\n'); process.exit(0); }
const buf = fs.readFileSync(0);
if (process.env.T58_PROMPTS) fs.writeFileSync(path.join(process.env.T58_PROMPTS, process.hrtime.bigint() + '-' + process.pid + '.prompt'), buf);
const prompt = buf.toString('utf8');
const answer = prompt.includes('=== THE DIFF ===')
  ? { kind: 'behaviour', magnitude: 0.6, headline: 'A stand-in verdict.', narrative: 'A stand-in narrative.' }
  : Array.from({ length: (prompt.match(/^--- EXCERPT \\d+/gm) || []).length || 1 }, (_, i) => ({ n: i + 1, what: 'A stand-in meaning.', why: 'A stand-in reason.', summary: 'A stand-in summary.' }));
process.stdout.write(JSON.stringify({ result: JSON.stringify(answer), usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }));
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

interface Prompt { bytes: Buffer; text: string; kind: 'adjudicate' | 'stops'; file: string | null }

/** Run `fn` with the stand-in model, and hand back every prompt it was sent. */
async function withModel<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string; prompts: Prompt[] }> {
  const dir = fresh('prompts');
  const was = { bin: process.env['REPO_TOUR_CLAUDE_BIN'], dir: process.env['T58_PROMPTS'] };
  process.env['REPO_TOUR_CLAUDE_BIN'] = FAKE;
  process.env['T58_PROMPTS'] = dir;
  const read = (): Prompt[] => fs.readdirSync(dir).sort().map((f) => {
    const bytes = fs.readFileSync(path.join(dir, f));
    const text = bytes.toString('utf8');
    const kind = text.includes('=== THE DIFF ===') ? 'adjudicate' as const : 'stops' as const;
    const file = (kind === 'adjudicate' ? /^File: (.*)$/m : /^File: (.*) \(/m).exec(text)?.[1] ?? null;
    return { bytes, text, kind, file };
  });
  try {
    const value = await fn();
    return { value, prompts: read() };
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}`, prompts: read() };
  } finally {
    if (was.bin === undefined) delete process.env['REPO_TOUR_CLAUDE_BIN']; else process.env['REPO_TOUR_CLAUDE_BIN'] = was.bin;
    if (was.dir === undefined) delete process.env['T58_PROMPTS']; else process.env['T58_PROMPTS'] = was.dir;
  }
}

const unescape = (s: string): string => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The page's file rows: path -> the +n −n it shows. */
function rowsOf(html: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>();
  const re = /<button class="prfile" data-file="([^"]*)"[\s\S]*?<span class="pfnum"><i class="add">\+(\d+)<\/i> <i class="del">−(\d+)<\/i><\/span>/g;
  for (const m of html.matchAll(re)) out.set(unescape(m[1]!), { added: Number(m[2]), removed: Number(m[3]) });
  return out;
}

/** The detail of the page's stop for `file`, unescaped. */
function detailOf(html: string, file: string): string | null {
  for (const m of html.matchAll(/<div class="stop" data-file="([^"]*)">[\s\S]*?<div class="detail">([\s\S]*?)<\/div>/g)) {
    if (unescape(m[1]!) === file) return unescape(m[2]!);
  }
  return null;
}

type Payload = Record<string, { lang: string | null; rows: Array<{ k: string; t: string }>; big?: { added: number; removed: number } } | null>;
const payloadOf = (html: string): Payload => JSON.parse(/var DIFFS = (\{.*?\});\n/s.exec(html)![1]!) as Payload;

// ---- the fixture most PRs below are made of (the T-37 reviewers' fixtures)

const CATALOG = 'export function alpha(): number { return 1; }\n'
  + 'export function beta(): number { return 2; }\n'
  + 'export const gamma = 3;\n';
/** gamma goes, delta comes: one line out, one in */
const EDITED = CATALOG.replace('export const gamma = 3;\n', 'export const delta = 4;\n');
const PR_ADDS = 'export const delta = 4;\nexport const epsilon = 5;\nexport const zeta = 6;\n';
const PAD = Array.from({ length: 30 }, (_, i) => `export const pad${i} = ${i}; // padding line ${i}\n`).join('');
const SHARED = {
  'src/app.ts': "import { alpha } from './catalog';\nexport function start(): number { return alpha(); }\n",
  'src/util.ts': 'export function helper(): number { return 1; }\n',
};
const UTIL_AFTER = 'export function helper(): number { return 2; }\n';
const ROW_CSV = '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,a,b,c,d,e,f,g\n';
const NO_SURFACE = { added: [], removed: [], changed: [] };

/** Bytes git and repo-tour both call binary (a NUL in the first 8 KB), with bytes past 0x7f that are not UTF-8. */
const binary = (salt: string): Buffer => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]), Buffer.from(`BINARY-PAYLOAD-${salt}-`), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0, 0x80]),
]);

// =========================================================================== AC18: a file becomes a directory

describe('T-58 AC18: a PR that turns a file into a directory of the same name, or the reverse, tours', () => {
  const runs: Record<string, Flow> = {};
  beforeAll(async () => {
    const toDir = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'lib/config': 'not code\n' }),
      head: (r) => { fs.rmSync(path.join(r, 'lib/config')); writeAll(r, { 'lib/config/index.ts': CATALOG, 'src/util.ts': UTIL_AFTER }); },
    });
    runs['file-to-dir'] = await flow(toDir);
    const toFile = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'lib/config/index.ts': CATALOG }),
      head: (r) => { fs.rmSync(path.join(r, 'lib/config'), { recursive: true }); writeAll(r, { 'lib/config': 'not code\n', 'src/util.ts': UTIL_AFTER }); },
    });
    runs['dir-to-file'] = await flow(toFile);
  }, 120_000);

  for (const [name, removed, added] of [['file-to-dir', 'lib/config', 'lib/config/index.ts'], ['dir-to-file', 'lib/config/index.ts', 'lib/config']] as const) {
    it(`${name}: the tour finishes, and the page lists the removed file and the added one, each with its diff`, () => {
      const { r, error } = runs[name]!;
      expect(error, `a PR where ${removed} gives way to ${added} failed outright`).toBeUndefined();
      expect(r!.deltas.map((d) => `${d.status} ${d.path}`).sort()).toEqual([`A ${added}`, `D ${removed}`, 'M src/util.ts'].sort());
      const rows = rowsOf(r!.html);
      expect(rows.get(removed), `the page does not show ${removed}'s removed line`).toEqual({ added: 0, removed: removed.endsWith('.ts') ? 3 : 1 });
      expect(rows.get(added), `the page does not show ${added}'s added lines`).toEqual({ added: added.endsWith('.ts') ? 3 : 1, removed: 0 });
    });
  }

  it('a renamed file that takes a directory\'s name, beside a file deleted from that directory: one path that cannot be written beside the others never stops the tour', async () => {
    // base: x/y.ts and x/z.ts. head: x/y.ts renamed to `x` (a file), x/z.ts deleted. The base side writes the rename
    // under its new name, `x`, so x/z.ts has no folder to go in.
    const repo = await prRepo({
      base: (r) => writeAll(r, { 'x/y.ts': CATALOG + PAD, 'x/z.ts': 'export const z = 1;\n' }),
      head: (r) => {
        fs.rmSync(path.join(r, 'x'), { recursive: true });
        write(r, 'x', CATALOG + PAD + 'export const omega = 9;\n');
      },
    });
    const { r, error } = await flow(repo);
    expect(error, 'one file that could not be written beside the others failed the whole tour').toBeUndefined();
    expect(r!.deltas.map((d) => `${d.status} ${d.path}`).sort()).toEqual(['D x/z.ts', 'R x']);
    const z = r!.deltas.find((d) => d.path === 'x/z.ts')!;
    expect(z.unread?.base, 'the file that could not be written is not said to be unread').toMatch(/could not be written/);
  }, 120_000);
});

// =========================================================================== AC19: paths git quotes

const QUOTED = ['src/café.ts', 'src/say "hi".ts', 'src/back\\slash.ts', 'src/tab\there.ts'];

describe('T-58 AC19: a path git quotes is read on both sides like any other', () => {
  let repo: Repo;
  let run: Flow;
  beforeAll(async () => {
    repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, ...Object.fromEntries(QUOTED.map((p) => [p, CATALOG])) }),
      head: (r) => writeAll(r, { ...Object.fromEntries(QUOTED.map((p) => [p, EDITED])), 'src/util.ts': UTIL_AFTER }),
    });
    run = await flow(repo);
  }, 120_000);

  it('the diff set names each file as it is', () => {
    expect(diffSet(repo.root, repo.base, repo.head).map((c) => c.path).sort(), 'the diff set holds git\'s quoted strings, not the files')
      .toEqual([...QUOTED, 'src/util.ts'].sort());
  });

  it('each line count is under the file\'s own name', () => {
    const counts = lineCounts(repo.root, repo.base, repo.head);
    expect(QUOTED.map((p) => counts.get(p)), 'a quoted path\'s line count is filed under the quoted string').toEqual([2, 2, 2, 2]);
  });

  for (const p of QUOTED) {
    it(`${JSON.stringify(p)}: its surface, its count, its diff and its page row are its own`, () => {
      expect(run.error).toBeUndefined();
      const d = run.r!.deltas.find((x) => x.path === p);
      expect(d, `${JSON.stringify(p)} is not in the tour under its own name`).toBeDefined();
      expect(d!.surface, 'a file read on neither side claims an unchanged surface').toEqual({ added: ['delta'], removed: ['gamma'], changed: [] });
      expect(d!.linesChanged).toBe(2);
      const diff = run.r!.diffs.get(p);
      expect([diff?.added, diff?.removed], 'its diff is empty').toEqual([1, 1]);
      expect(rowsOf(run.r!.html).get(p), 'the page has no row for it under its own name').toEqual({ added: 1, removed: 1 });
      expect(detailOf(run.r!.html, p), 'the page says its surface is unchanged').not.toMatch(/Public surface unchanged/);
    });
  }
});

// =========================================================================== AC20: a file becomes a symlink

describe('T-58 AC20: a file that becomes a symlink, or the reverse, appears as that change', () => {
  const runs: Record<string, { repo: Repo; run: Flow }> = {};
  beforeAll(async () => {
    const toLink = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/catalog.ts': CATALOG }),
      head: (r) => {
        fs.rmSync(path.join(r, 'src/catalog.ts'));
        writeAll(r, { 'src/catalog-impl.ts': CATALOG + PR_ADDS, 'src/util.ts': UTIL_AFTER });
        fs.symlinkSync('catalog-impl.ts', path.join(r, 'src/catalog.ts'));
      },
    });
    runs['file-to-symlink'] = { repo: toLink, run: await flow(toLink) };
    const toFile = await prRepo({
      base: (r) => { writeAll(r, { ...SHARED, 'src/catalog-impl.ts': CATALOG }); fs.symlinkSync('catalog-impl.ts', path.join(r, 'src/catalog.ts')); },
      head: (r) => { fs.rmSync(path.join(r, 'src/catalog.ts')); writeAll(r, { 'src/catalog.ts': EDITED, 'src/util.ts': UTIL_AFTER }); },
    });
    runs['symlink-to-file'] = { repo: toFile, run: await flow(toFile) };
  }, 120_000);

  for (const [name, side] of [['file-to-symlink', 'head'], ['symlink-to-file', 'base']] as const) {
    it(`${name}: a type change, the ${side} side named as the link, not scored, not ranked, not rippled`, () => {
      const { run } = runs[name]!;
      expect(run.error).toBeUndefined();
      const d = run.r!.deltas.find((x) => x.path === 'src/catalog.ts');
      expect(d, 'a type change is missing from the tour').toBeDefined();
      expect(d!.status, 'a type change is not shown as one').toBe('T');
      expect(d!.unread?.[side], `the ${side} side is not said to be a symbolic link`).toMatch(/symbolic link/);
      expect(d!.basis, 'a file one side of which is a link was scored').toBe('unread');
      expect(d!.surface).toEqual(NO_SURFACE);
      expect(run.r!.ripple.reinterpret, 'a type change sent its importer down the ripple').not.toContain('src/app.ts');
      expect(run.r!.html, 'the page does not name the change').toMatch(/data-file="src\/catalog\.ts"[\s\S]*?<span class="chip">type changed<\/span>/);
    });
  }

  it('the side that holds the link does not read it as code', async () => {
    const { repo } = runs['file-to-symlink']!;
    const side = await sideAt(repo.root, repo.head, ['src/catalog.ts']);
    try {
      expect(side.files.map((f) => f.path), 'the link\'s target was written and read as a source file').toEqual([]);
      expect(side.extracts).toEqual([]);
    } finally {
      side.dispose();
    }
  }, 60_000);
});

// =========================================================================== AC21: a renamed file's counts

describe('T-58 AC21: a renamed file\'s counts are its real ones, everywhere the owner sees one', () => {
  let repo: Repo;
  let run: Flow;
  beforeAll(async () => {
    repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/old.ts': CATALOG + PAD }),
      head: (r) => { git(r, 'mv', 'src/old.ts', 'src/new.ts'); writeAll(r, { 'src/new.ts': EDITED + PAD, 'src/util.ts': UTIL_AFTER }); },
    });
    run = await flow(repo);
  }, 120_000);

  it('the line count (the CLI\'s lines column, the tour\'s count)', () => {
    expect(lineCounts(repo.root, repo.base, repo.head).get('src/new.ts'), 'a renamed file\'s line count reads 0').toBe(2);
    expect(run.r!.deltas.find((d) => d.path === 'src/new.ts')?.linesChanged).toBe(2);
  });

  it('the page\'s row, its diff and its stop detail: one line out, one in, not the whole file as new', () => {
    const diff = run.r!.diffs.get('src/new.ts');
    expect([diff?.added, diff?.removed], 'the page\'s diff shows the renamed file as all new').toEqual([1, 1]);
    expect(rowsOf(run.r!.html).get('src/new.ts')).toEqual({ added: 1, removed: 1 });
    expect(detailOf(run.r!.html, 'src/new.ts')).toMatch(/^renamed · \+1 −1\n/);
  });

  it('the tour\'s stop points at the changed line, not at the whole file', () => {
    const hs = hunks(repo.root, repo.base, repo.head, 'src/new.ts', 'src/old.ts');
    expect(hs.map((h) => [h.start, h.end]), 'the renamed file\'s hunks are the whole file as added').toEqual([[3, 3]]);
  });

  it('a pure rename counts 0, on the page too', async () => {
    const pure = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/old.ts': CATALOG + PAD }),
      head: (r) => { git(r, 'mv', 'src/old.ts', 'src/new.ts'); writeAll(r, { 'src/util.ts': UTIL_AFTER }); },
    });
    const { r } = await flow(pure);
    expect(r!.deltas.find((d) => d.path === 'src/new.ts')?.linesChanged).toBe(0);
    expect(rowsOf(r!.html).get('src/new.ts'), 'a pure rename shows the whole file as added').toEqual({ added: 0, removed: 0 });
  }, 120_000);
});

// =========================================================================== AC22: a diff too big to show

describe('T-58 AC22: a diff too big to show says so', () => {
  let repo: Repo;
  let run: { value?: PrFlowResult; error?: string; prompts: Prompt[] };
  let counts: { added: number; removed: number };
  beforeAll(async () => {
    repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'data/big.csv': `h,${SALT}\n${ROW_CSV}` }),
      head: (r) => { writeBig(r, 'data/big.csv', `h,${SALT}\n`, ROW_CSV, 33); writeAll(r, { 'src/util.ts': UTIL_AFTER + `// ${SALT}\n` }); },
    });
    const [add, del] = git(repo.root, 'diff', '--numstat', `${repo.base}..${repo.head}`, '--', 'data/big.csv').split('\t');
    counts = { added: Number(add), removed: Number(del) };
    run = await withModel(() => runPrFlow(repo.root, { base: repo.base, head: repo.head }));
  }, 300_000);

  it('the flow knows the diff was too big, and keeps git\'s counts for it', () => {
    expect(run.error).toBeUndefined();
    const diff = run.value!.diffs.get('data/big.csv') as (FileDiff & { tooBig?: boolean }) | undefined;
    expect(diff?.tooBig, 'a diff over 32 MiB reads as empty').toBe(true);
    expect([diff?.added, diff?.removed], 'the counts of a diff too big to show are not git\'s').toEqual([counts.added, counts.removed]);
  });

  it('the page says it is too big, with the counts, and never "a rename, a mode change, or a binary file"', () => {
    const html = run.value!.html;
    expect(payloadOf(html)['data/big.csv']?.big, 'the page carries nothing that tells this diff from an empty one').toEqual(counts);
    expect(html, 'the page has no words for a diff too big to show').toContain('too big to show');
    expect(rowsOf(html).get('data/big.csv'), 'the row reads +0 −0').toEqual(counts);
  });

  it('the model is told the diff was left out, not handed an empty one', () => {
    const verdict = run.prompts.find((p) => p.kind === 'adjudicate' && p.file === 'data/big.csv');
    expect(verdict, 'no verdict was asked for the file').toBeDefined();
    expect(verdict!.text, 'the model read an empty diff as the whole change').toMatch(/too big/);
  });
});

// =========================================================================== AC23: what the checkpoint has not seen

describe('T-58 AC23: staleness counts only what the checkpoint has not seen', () => {
  const PR = ['src/catalog.ts', 'src/util.ts'];
  it('a checkpoint at head (as GONS takes it) has missed nothing', async () => {
    const repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/catalog.ts': CATALOG }),
      head: (r) => writeAll(r, { 'src/catalog.ts': EDITED, 'src/util.ts': UTIL_AFTER }),
      checkpoint: 'head',
    });
    const s = staleness(repo.root, repo.head, repo.base, PR);
    expect(s.overlap, 'a checkpoint that has seen every file the PR changed is said to have missed them').toEqual([]);
    expect(s.behind).toBe(0);
    const { r } = await flow(repo);
    expect(r!.staleness.overlap).toEqual([]);
    expect(r!.html, 'the page warns about a checkpoint that missed nothing').not.toContain('class="bar stale"');
  }, 120_000);

  it('a checkpoint at head when main moved: only the file both changed is missed', async () => {
    const repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/catalog.ts': CATALOG, 'src/other.ts': 'export const other = 1;\n' }),
      head: (r) => writeAll(r, { 'src/catalog.ts': EDITED, 'src/util.ts': UTIL_AFTER }),
      mainMoves: (r) => writeAll(r, { 'src/catalog.ts': CATALOG + 'export const omega = 9;\n', 'src/other.ts': 'export const other = 2;\n' }),
      checkpoint: 'head',
    });
    const s = staleness(repo.root, repo.head, repo.base, PR);
    expect(s.overlap, 'a file only the PR changed is said to be missed').toEqual(['src/catalog.ts']);
    expect(s.behind).toBe(1);
    const { r } = await flow(repo);
    const bar = /<div class="bar stale">([\s\S]*?)<\/div>/.exec(r!.html)?.[1];
    expect(bar, 'the page never says the checkpoint has not seen a file this PR changes').toBeDefined();
    expect(bar).toContain('src/catalog.ts');
    expect(bar).not.toContain('src/util.ts');
    expect(r!.html, 'the page gives an ahead or behind count (T-9 criterion 7)').not.toMatch(/\b\d+ commits? (ahead|behind)\b/i);
    expect(r!.html).not.toMatch(/base has moved|commits since this branch forked/i);
  }, 120_000);

  it('a reader\'s checkpoint behind base on one line: as on main (guard)', async () => {
    const repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/catalog.ts': CATALOG, 'src/other.ts': 'export const other = 1;\n' }),
      head: (r) => writeAll(r, { 'src/catalog.ts': EDITED, 'src/util.ts': UTIL_AFTER }),
      mainMoves: (r) => writeAll(r, { 'src/catalog.ts': CATALOG + 'export const omega = 9;\n', 'src/other.ts': 'export const other = 2;\n' }),
      checkpoint: 'fork',
    });
    const s = staleness(repo.root, repo.fork, repo.base, PR);
    expect(s).toEqual({ sha: repo.fork, behind: 1, overlap: ['src/catalog.ts'], current: false });
  }, 120_000);
});

describe('T-58 AC23: what the tour\'s steps tell the reader reaches the PR page', () => {
  const refs: PrRefs = {
    number: 7, url: 'https://github.com/o/r/pull/7',
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: 'c'.repeat(40),
    baseLabel: 'main', headLabel: 'feature', baseAhead: 3,
    prose: {
      title: 'Rank tests lower', body: 'Tests were crowding the tour.\nThis lowers their weight.\n\nCloses #12',
      commits: [{ sha: 'd'.repeat(40), message: 'rank.ts: damp test files harder\n\nbecause they crowd the tour' }],
      issues: ['#12'], source: 'github',
    },
  };
  const delta = (p: string, extra: Partial<FileDelta> = {}): FileDelta => ({
    path: p, status: 'M', linesChanged: 2, meaningDelta: 0.6, surface: NO_SURFACE, interpreted: true,
    reason: 'the test multiplier dropped', basis: 'adjudicated', ...extra,
  });
  const deltas = [delta('src/rank.ts'), delta('src/util.ts', { meaningDelta: 0.1, basis: 'structure', interpreted: false })];
  const ripple = { reinterpret: ['src/tour.ts'], structuralOnly: ['src/cli.ts', 'src/server.ts'], reachable: 3 };
  const stale = { sha: 'e'.repeat(40), behind: 2, overlap: ['src/rank.ts'], current: false };
  const page = (): string => renderPrView({
    refs, deltas, diffs: new Map(), ripple, verdicts: new Map(),
    steps: buildPrTour({ refs, deltas, ripple, staleness: stale, hunksByFile: new Map() }).steps,
    staleness: stale,
  } as Parameters<typeof renderPrView>[0]);

  it('"The checkpoint has not seen these": a notice bar naming the files and the checkpoint, with no count of commits', () => {
    const html = page();
    const bar = /<div class="bar stale">([\s\S]*?)<\/div>/.exec(html)?.[1];
    expect(bar, 'the page never says the checkpoint has not seen files this PR changes').toBeDefined();
    expect(bar).toContain('src/rank.ts');
    expect(bar).toContain('eeeeeeee');
    expect(html, 'the page gives an ahead or behind count (T-9 criterion 7)').not.toMatch(/\b\d+ commits? (ahead|behind)\b/i);
    expect(html).not.toMatch(/base has moved|commits since this branch forked/i);
  });

  it('each file\'s "why", with its source, in the stop\'s detail (the tour\'s §7 sentence)', () => {
    const html = page();
    expect(detailOf(html, 'src/rank.ts'), 'the page never says why a file changed, or where that came from')
      .toContain('Why: "rank.ts: damp test files harder" — from commit dddddddd.');
    expect(detailOf(html, 'src/util.ts')).toContain('Why: "Tests were crowding the tour." — from the pull request description.');
  });

  it('the ripple\'s files past one hop are named', () => {
    const html = page();
    expect(html, 'the page counts the files past one hop and never names them').toMatch(/not re-read: src\/cli\.ts, src\/server\.ts\./);
  });

  it('the description\'s first lines are on the page', () => {
    const html = page();
    expect(html, 'the description is only behind the link').toMatch(/<h4>From the description<\/h4>\s*<div class="body">Tests were crowding the tour\.<br>This lowers their weight\.<br><br>Closes #12<\/div>/);
  });
});

// =========================================================================== AC24: bounded prompts

/** Every prompt interpretStops sends for one file, with a canned runner and an empty cache. */
async function promptsFor(text: string, record: Partial<FileRecord>, steps: Array<[number, number]>): Promise<{ prompts: string[]; keys: string[]; sha: string }> {
  const root = path.join(fresh('interp'), 'fixture-repo');
  write(root, 'src/x.ts', text);
  const sha = createHash('sha256').update(text).digest('hex');
  const file: FileRecord = {
    path: 'src/x.ts', repo: '', bytes: Buffer.byteLength(text), loc: text.split('\n').length - 1, language: 'typescript',
    sha256: sha, classification: 'source', signals: [], binary: false, ...record,
  };
  const cacheDir = fresh('cache');
  const prompts: string[] = [];
  const runner = async (prompt: string): Promise<LlmReply> => {
    prompts.push(prompt);
    return { text: JSON.stringify(steps.map((_, i) => ({ n: i + 1, what: 'w', why: 'y', summary: 's' }))), inputTokens: 0, outputTokens: 0, usd: 0, metered: true };
  };
  await interpretStops(root, steps.map(([startLine, endLine], i) => ({ file: 'src/x.ts', startLine, endLine, title: `stop ${i + 1}`, text: '' })),
    [file], [], [], { runner, cacheDir });
  return { prompts, keys: fs.readdirSync(cacheDir).map((f) => f.replace(/\.json$/, '')), sha: file.sha256 };
}

describe('T-58 AC24: no model prompt carries a line, or a file, whole', () => {
  it('one line of 7 MiB: cut at 1,000 characters, and the prompt says so', async () => {
    const { prompts } = await promptsFor(`export const BLOB = "${'a'.repeat(7 * 1024 * 1024)}";\n`, {}, [[1, 1]]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.length, 'a 7 MiB line went into the prompt whole').toBeLessThan(210_000);
    expect(prompts[0], 'the prompt does not say the line was cut').toMatch(/this line is 7,340,055 characters long; only its first 1,000 are shown/);
  }, 60_000);

  it('a file of 1,000,001 short lines: at most 200,000 characters of source, and the prompt says which lines it left out', async () => {
    const { prompts } = await promptsFor('x\n'.repeat(1_000_001), {}, [[1, 1_000_001]]);
    expect(prompts[0]!.length, 'a million-line excerpt went into the prompt whole').toBeLessThan(210_000);
    expect(prompts[0], 'the prompt does not say which lines were left out').toMatch(/lines \d+-1000001 of this excerpt are not shown/);
  }, 60_000);

  it('a cut stop is cached under its own key, never the key an uncut one has', async () => {
    const { keys, sha } = await promptsFor(`export const BLOB = "${'b'.repeat(5000)}";\n`, {}, [[1, 1]]);
    expect(keys, 'a cut prompt\'s answer is filed where an uncut prompt\'s would be').not.toContain(stopKey(sha, 1, 1));
    expect(keys).toHaveLength(1);
  });

  it('a prompt under both bounds is byte for byte main\'s (guard)', async () => {
    const root = path.join(fresh('interp'), 'fixture-repo');
    const text = 'import { a } from "./a";\n\nexport function shout(s: string): string {\n  return s.toUpperCase();\n}\n\nexport const LOUD = shout("x");\n';
    write(root, 'src/shout.ts', text);
    const prompts: string[] = [];
    const runner = async (prompt: string): Promise<LlmReply> => {
      prompts.push(prompt);
      return { text: JSON.stringify([{ n: 1, what: 'w', why: 'y', summary: 's' }, { n: 2, what: 'w', why: 'y', summary: 's' }]), inputTokens: 0, outputTokens: 0, usd: 0, metered: true };
    };
    const cacheDir = fresh('cache');
    await interpretStops(root, [
      { file: 'src/shout.ts', startLine: 3, endLine: 5, title: 'shout', text: '' },
      { file: 'src/shout.ts', startLine: 7, endLine: 7, title: 'LOUD', text: '' },
    ], [{ path: 'src/shout.ts', repo: '', bytes: text.length, loc: 7, language: 'typescript', sha256: 'pin-sha', classification: 'source', signals: [], binary: false }],
    [{ path: 'src/shout.ts', language: 'typescript', parseErrors: 0, symbols: [], imports: [{ raw: './a', resolved: 'src/a.ts' }] }],
    [{ from: 'src/b.ts', to: 'src/shout.ts' }], { runner, cacheDir });
    expect(prompts[0]!.slice(0, prompts[0]!.indexOf('\n\nYou explain'))).toBe('Repository: fixture-repo\nFile: src/shout.ts (7 lines, typescript)\n'
      + 'Context: 1 other file in this repo import it.\nIt imports from inside this repo: ./a\n\nThere are 2 excerpts to explain.\n\n'
      + '--- EXCERPT 1 — lines 3-5 (shout) ---\n3 | export function shout(s: string): string {\n4 |   return s.toUpperCase();\n5 | }\n\n'
      + '--- EXCERPT 2 — lines 7-7 (LOUD) ---\n7 | export const LOUD = shout("x");');
    // the whole prompt, pinned from main 646faf4
    expect(createHash('sha256').update(prompts[0]!).digest('hex')).toBe('1c11947bd5cf2d1f7f3268fcdc25677c5dfb9abd6189cbc1924b2c5b86ddb55f');
    expect(fs.readdirSync(cacheDir).sort(), 'an uncut stop moved to a new cache key').toEqual([stopKey('pin-sha', 3, 5), stopKey('pin-sha', 7, 7)].map((k) => `${k}.json`).sort());
  });

  it('a PR side with one line of 12 MiB (past the inventory\'s 8 MiB read) sends that line cut, not an empty excerpt that says nothing', async () => {
    const repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/oneline.ts': `export const BLOB = "${SALT}${'a'.repeat(12 * 1024 * 1024)}";\n` }),
      head: (r) => writeAll(r, { 'src/oneline.ts': `export const BLOB = "${SALT}${'b'.repeat(12 * 1024 * 1024)}";\n`, 'src/util.ts': UTIL_AFTER }),
    });
    const run = await withModel(() => runPrFlow(repo.root, { base: repo.base, head: repo.head }));
    expect(run.error).toBeUndefined();
    const stops = run.prompts.filter((p) => p.kind === 'stops' && p.file === 'src/oneline.ts');
    expect(stops, 'a side prompt is missing').toHaveLength(2);
    for (const p of stops) {
      expect(p.bytes.length).toBeLessThan(210_000);
      expect(p.text, 'the excerpt of the changed line is empty').toMatch(/^1 \| export const BLOB = "/m);
      expect(p.text, 'the prompt does not say the line was cut').toMatch(/only its first 1,000 are shown/);
      expect(p.text, 'the prompt calls the file "-1 lines" long').not.toMatch(/\(-1 lines/);
    }
  }, 300_000);
});

// =========================================================================== AC25: binary files

describe('T-58 AC25: a binary file is never sent to the model as text', () => {
  it('interpretStops never reads a file the inventory calls binary', async () => {
    const { prompts } = await promptsFor(binary('unit').toString('latin1'), { binary: true, language: null, classification: 'data', loc: 0 }, [[1, 1]]);
    expect(prompts.filter((p) => p.includes('\0') || p.includes('BINARY-PAYLOAD')), 'a binary file\'s bytes went into a prompt').toEqual([]);
  });

  it('a PR that changes a binary file: no side prompt and no verdict carries its bytes', async () => {
    const repo = await prRepo({
      base: (r) => { writeAll(r, SHARED); write(r, 'assets/blob.dat', binary(`${SALT}-base`)); },
      head: (r) => { write(r, 'assets/blob.dat', binary(`${SALT}-head`)); writeAll(r, { 'src/util.ts': UTIL_AFTER + `// ${SALT}\n` }); },
    });
    const run = await withModel(() => runPrFlow(repo.root, { base: repo.base, head: repo.head }));
    expect(run.error).toBeUndefined();
    expect(run.prompts.length).toBeGreaterThan(0);
    expect(run.prompts.filter((p) => p.bytes.includes(0) || p.text.includes('BINARY-PAYLOAD')).map((p) => `${p.kind} ${p.file}`),
      'a binary file\'s bytes went to the model').toEqual([]);
  }, 120_000);

  it('a binary file git is told to diff as text (a `diff` attribute): its hunks reach neither the model nor the page', async () => {
    const repo = await prRepo({
      base: (r) => { writeAll(r, { ...SHARED, '.gitattributes': '*.dat diff\n' }); write(r, 'assets/blob.dat', binary(`${SALT}-attr-base`)); },
      head: (r) => { write(r, 'assets/blob.dat', binary(`${SALT}-attr-head`)); writeAll(r, { 'src/util.ts': UTIL_AFTER + `// ${SALT} attr\n` }); },
    });
    const run = await withModel(() => runPrFlow(repo.root, { base: repo.base, head: repo.head }));
    expect(run.error).toBeUndefined();
    expect(run.prompts.filter((p) => p.bytes.includes(0) || p.text.includes('BINARY-PAYLOAD')).map((p) => `${p.kind} ${p.file}`),
      'git\'s text diff of a binary file went to the model').toEqual([]);
    expect(payloadOf(run.value!.html)['assets/blob.dat'] ?? null, 'the page carries the binary file\'s bytes as diff rows').toBeNull();
  }, 120_000);
});

// =========================================================================== AC26: a monorepo package folder

describe('T-58 AC26: a PR toured from a folder inside a repository shows every file\'s diff', () => {
  let repo: Repo;
  let run: Flow;
  beforeAll(async () => {
    repo = await prRepo({
      base: (r) => writeAll(r, { 'pkg/src/catalog.ts': CATALOG, 'pkg/src/app.ts': SHARED['src/app.ts'], 'pkg/src/util.ts': SHARED['src/util.ts'], 'README.md': '# mono\n' }),
      head: (r) => writeAll(r, { 'pkg/src/catalog.ts': EDITED, 'pkg/src/util.ts': UTIL_AFTER }),
      folder: 'pkg',
    });
    run = await flow(repo, { at: path.join(repo.root, 'pkg') });
  }, 120_000);

  it('each file\'s diff and counts, on the flow and the page', () => {
    expect(run.error).toBeUndefined();
    for (const p of ['pkg/src/catalog.ts', 'pkg/src/util.ts']) {
      const diff = run.r!.diffs.get(p);
      expect([diff?.added, diff?.removed], `${p} shows no diff from the package folder`).toEqual([1, 1]);
      expect(rowsOf(run.r!.html).get(p)).toEqual({ added: 1, removed: 1 });
    }
  });

  it('the tour\'s hunks, from the package folder', () => {
    expect(hunks(path.join(repo.root, 'pkg'), repo.base, repo.head, 'pkg/src/catalog.ts').length, 'no hunks from the package folder').toBe(1);
  });
});

// =========================================================================== AC27: the CLI table

describe('T-58 AC27: the CLI table keeps its columns for any line count', () => {
  it('a seven-digit count, and the counts beside it, as GONS runs the CLI', async () => {
    const repo = await prRepo({
      base: (r) => writeAll(r, SHARED),
      head: (r) => { write(r, 'data/lines.txt', 'x\n'.repeat(1_000_001)); writeAll(r, { 'src/util.ts': UTIL_AFTER }); },
    });
    const view = path.join(fresh('view'), 'pr.html');
    const child = spawn(process.execPath, [
      '--import', TSX, path.join(REPO_ROOT, 'src', 'cli.ts'),
      'pr', repo.root, '--base', repo.base, '--head', repo.head, '--no-interpret', '--view', view,
    ], { cwd: fresh('cwd'), env: { ...process.env, TMPDIR: fresh('tmp') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code, out).toBe(0);
    expect(out, 'a seven-digit count runs into the band column').toMatch(/^ {2}1\.00 +1000001 +moved +status +data\/lines\.txt$/m);
    const header = out.split('\n').find((l) => /^ {2}meaning +lines +band +basis +path$/.test(l));
    const row = out.split('\n').find((l) => l.includes('data/lines.txt'))!;
    expect(header, 'the header is missing').toBeDefined();
    expect(row.indexOf('moved'), 'the band column moved off its header').toBe(header!.indexOf('band'));
    expect(row.indexOf('data/lines.txt'), 'the path column moved off its header').toBe(header!.indexOf('path'));
  }, 120_000);

  it('a table of smaller counts is main\'s, to the character (guard)', async () => {
    const repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/catalog.ts': CATALOG }),
      head: (r) => writeAll(r, { 'src/catalog.ts': CATALOG + PR_ADDS, 'src/util.ts': UTIL_AFTER }),
    });
    const child = spawn(process.execPath, [
      '--import', TSX, path.join(REPO_ROOT, 'src', 'cli.ts'),
      'pr', repo.root, '--base', repo.base, '--head', repo.head, '--no-interpret', '--view', path.join(fresh('view'), 'pr.html'),
    ], { cwd: fresh('cwd'), env: { ...process.env, TMPDIR: fresh('tmp') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    expect(code).toBe(0);
    const table = out.split('\n').filter((l) => /^ {2}(meaning|-{78}|\d\.\d\d) /.test(l) || /^ {2}-{78}$/.test(l));
    expect(table).toEqual([
      '  meaning  lines  band     basis        path',
      `  ${'-'.repeat(78)}`,
      '  0.70     3      moved    structure    src/catalog.ts',
      '  0.25     2      shifted  structure    src/util.ts',
    ]);
  }, 120_000);
});

// =========================================================================== guards: what must not move

describe('T-58 guards: a PR none of the shapes touch tours as on main', () => {
  it('a plain PR: deltas, ripple and page counts as main gives them', async () => {
    const repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/catalog.ts': CATALOG }),
      head: (r) => writeAll(r, { 'src/catalog.ts': CATALOG + PR_ADDS, 'src/util.ts': UTIL_AFTER }),
    });
    const { r, error } = await flow(repo);
    expect(error).toBeUndefined();
    expect(r!.deltas).toStrictEqual([
      {
        path: 'src/catalog.ts', status: 'M', linesChanged: 3, meaningDelta: 0.7,
        surface: { added: ['delta', 'epsilon', 'zeta'], removed: [], changed: [] }, interpreted: false,
        reason: 'the public surface moved (3 added) — other code can feel this', basis: 'structure',
      },
      {
        path: 'src/util.ts', status: 'M', linesChanged: 2, meaningDelta: 0.25, surface: NO_SURFACE, interpreted: false,
        reason: 'not interpreted on both sides — scored on structure alone', basis: 'structure',
      },
    ]);
    expect(r!.ripple).toEqual({ reinterpret: ['src/app.ts'], structuralOnly: [], reachable: 1 });
    expect([...rowsOf(r!.html)]).toEqual([['src/catalog.ts', { added: 3, removed: 0 }], ['src/util.ts', { added: 1, removed: 1 }]]);
    expect(r!.staleness).toEqual({ sha: repo.base, behind: 0, overlap: [], current: true });
  }, 120_000);

  it('the diff set keeps A, M, D and R as main reports them', async () => {
    const repo = await prRepo({
      base: (r) => writeAll(r, { ...SHARED, 'src/old.ts': CATALOG + PAD, 'src/gone.ts': 'export const g = 1;\n' }),
      head: (r) => {
        git(r, 'mv', 'src/old.ts', 'src/new.ts');
        fs.rmSync(path.join(r, 'src/gone.ts'));
        writeAll(r, { 'src/added.ts': 'export const a = 1;\n', 'src/util.ts': UTIL_AFTER });
      },
    });
    expect(diffSet(repo.root, repo.base, repo.head)).toEqual([
      { status: 'A', path: 'src/added.ts' },
      { status: 'D', path: 'src/gone.ts' },
      { status: 'R', from: 'src/old.ts', path: 'src/new.ts' },
      { status: 'M', path: 'src/util.ts' },
    ]);
  }, 120_000);

  it('a diff under the size limit renders as main renders it', () => {
    const parsed = parseUnified('src/a.ts', '@@ -1 +1 @@\n-a\n+b');
    const html = renderPrView({
      refs: {
        number: null, url: null, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null, baseLabel: 'main',
        headLabel: 'feature', baseAhead: 0, prose: { title: null, body: null, commits: [], issues: [], source: 'git-only' },
      },
      deltas: [{ path: 'src/a.ts', status: 'M', linesChanged: 2, meaningDelta: 0.2, surface: NO_SURFACE, interpreted: false, reason: 'r', basis: 'structure' }],
      diffs: new Map([['src/a.ts', parsed]]), steps: [], ripple: { reinterpret: [], structuralOnly: [], reachable: 0 }, verdicts: new Map(),
    });
    expect(payloadOf(html)['src/a.ts']).toEqual({ lang: 'ts', rows: [
      { k: 'hh', o: null, n: null, t: '@@ 1 → 1 @@ ' }, { k: 'del', o: 1, n: null, t: 'a' }, { k: 'add', o: null, n: 1, t: 'b' },
    ] });
  });
});
