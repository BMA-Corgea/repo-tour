/**
 * T-20 — a PR tour stopped by a signal (AC9, AC10).
 *
 * `sideAt` listens for SIGINT and SIGTERM so that it can delete its temp tree, and listening
 * for a signal cancels Node's own exit. So the first Ctrl-C used to delete the trees and leave
 * `repo-tour pr` running, and paying, through every interpretation still to come. GONS runs
 * that same command and stops it with a signal when it takes too long, so a signal has to end
 * the process the way it would with no handler at all, and leave nothing behind.
 *
 * Everything here happens in child processes. What is under test is what a whole process does
 * with a signal, and the test runner is not a process to send one to.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
/**
 * The tsx loader by address. `--import tsx` is resolved from the working directory, and GONS
 * starts `pr` from a temp directory of its own, where there is no node_modules to find it in.
 */
const TSX = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

let base: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-ckpt-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A fixture repository with an author, so it can commit. */
function newRepo(name: string): string {
  const dir = fresh(name);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'repo-tour test');
  return dir;
}

/** A new, empty directory inside this file's own scratch space. */
function fresh(name: string): string {
  return fs.mkdtempSync(path.join(base, `${name}-`));
}

interface Exit { code: number | null; signal: NodeJS.Signals | null }
interface Child { proc: ChildProcess; out: () => string; exited: Promise<Exit> }

/** Start `node <args>`, keeping everything it prints and how it ended. */
function start(args: string[], opts: { cwd: string; env?: Record<string, string> }): Child {
  const proc = spawn(process.execPath, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
  const exited = new Promise<Exit>((resolve) => { proc.on('exit', (code, signal) => resolve({ code, signal })); });
  return { proc, out: () => out, exited };
}

/** SIGKILL a child this file started, if it has not ended yet. */
function stop(child: Child | null): void {
  if (child && child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGKILL');
}

const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return ok();
};

/** A promise's value, or null if it takes longer than `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => { setTimeout(() => r(null), ms); })]);

/**
 * Whether `pid` is still running. A zombie does not count: it has been killed, and only waits
 * for whoever inherited it to collect it.
 */
function running(pid: number): boolean {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    if (fs.existsSync('/proc/self/stat')) return false; // Linux, and no such process
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0);
  return state !== 'Z' && state !== 'X';
}

// ---------------------------------------------------------------- AC9

describe('T-20 AC9: one Ctrl-C stops a process holding a PR side', () => {
  let root: string;
  let sha: string;
  let script: string;

  beforeAll(() => {
    root = newRepo('ac9-repo');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', 'a.ts');
    git(root, 'commit', '-q', '-m', 'one file');
    sha = git(root, 'rev-parse', 'HEAD');

    script = path.join(base, 'side.mjs');
    fs.writeFileSync(script, `import { sideAt } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'src', 'checkpoint.ts')).href)};
const [root, sha, mode] = process.argv.slice(2);
// The server's graceful stop, registered before any PR side exists, as the app does it.
if (mode === 'server') {
  process.on('SIGINT', () => { console.log('graceful'); setTimeout(() => process.exit(0), 100); });
}
const counts = () => process.listenerCount('SIGINT') + ',' + process.listenerCount('SIGTERM');
console.log('COUNTS before ' + counts());
const side = await sideAt(root, sha, ['a.ts']);
console.log('COUNTS after ' + counts());
if (mode === 'dispose') {
  // A side whose tour has finished: it must stop listening, or every tour leaks two listeners.
  side.dispose();
  console.log('COUNTS disposed ' + counts());
  process.exit(0);
}
console.log('SIDE ' + side.dir);
// A model call in flight: something is keeping the process busy.
setInterval(() => {}, 1000);
`);
  });

  /** A process holding one PR side, once the side's tree exists. */
  async function holdingASide(mode: 'cli' | 'server'): Promise<{ child: Child; dir: string }> {
    const child = start(['--import', 'tsx', script, root, sha, mode], {
      cwd: REPO_ROOT, env: { TMPDIR: fresh('ac9-tmp') },
    });
    const ready = /^SIDE (.+)$/m;
    const up = await until(() => ready.test(child.out()), 30_000);
    if (!up) stop(child);
    expect(up, `the side never came up: ${child.out()}`).toBe(true);
    const dir = ready.exec(child.out())![1]!;
    expect(fs.existsSync(dir), `the side's tree is missing before any signal: ${dir}`).toBe(true);
    return { child, dir };
  }

  it('with nothing else listening, one SIGINT removes the side and ends the process by SIGINT', async () => {
    let child: Child | null = null;
    try {
      const held = await holdingASide('cli');
      child = held.child;
      child.proc.kill('SIGINT');
      const exit = await within(child.exited, 2000);
      expect(exit, `still running after one Ctrl-C: the side tidied up and the process carried on. ${child.out()}`)
        .not.toBeNull();
      expect(exit, 'it ended, but not the way a Ctrl-C ends a process').toEqual({ code: null, signal: 'SIGINT' });
      expect(fs.existsSync(held.dir), `the side's tree outlived the Ctrl-C: ${held.dir}`).toBe(false);
    } finally {
      stop(child);
    }
  }, 60_000);

  it('a disposed side stops listening: one listener each while it lives, none after (review nit 4)', async () => {
    const child = start(['--import', 'tsx', script, root, sha, 'dispose'], {
      cwd: REPO_ROOT, env: { TMPDIR: fresh('ac9-tmp') },
    });
    try {
      const exit = await within(child.exited, 30_000);
      expect(exit, `the child did not finish: ${child.out()}`).toEqual({ code: 0, signal: null });
      const count = (when: string): string | undefined => new RegExp(`^COUNTS ${when} (\\d+,\\d+)$`, 'm').exec(child.out())?.[1];
      const [before, after, disposed] = [count('before'), count('after'), count('disposed')];
      expect(before, `the child printed no counts: ${child.out()}`).toBeDefined();
      const plusOne = before!.split(',').map((n) => String(Number(n) + 1)).join(',');
      expect(after, 'a live side should add one SIGINT and one SIGTERM listener').toBe(plusOne);
      expect(disposed, 'a disposed side still listens for SIGINT/SIGTERM, so every tour leaks listeners').toBe(before);
    } finally {
      stop(child);
    }
  }, 60_000);

  it('with a server-style stop listening, one SIGINT removes the side and leaves the stop to that handler', async () => {
    let child: Child | null = null;
    try {
      const held = await holdingASide('server');
      child = held.child;
      child.proc.kill('SIGINT');
      const exit = await within(child.exited, 5000);
      expect(exit, `the server-style stop never finished: ${child.out()}`).not.toBeNull();
      expect(exit, 'the side took the stop away from the handler that owns it').toEqual({ code: 0, signal: null });
      // To the real server a second Ctrl-C means "stop now", skipping the graceful part, so the
      // one Ctrl-C the reader pressed must reach its handler exactly once.
      expect(child.out().match(/^graceful$/gm)?.length ?? 0, 'one Ctrl-C reached the server-style handler more than once')
        .toBe(1);
      expect(fs.existsSync(held.dir), `the side's tree outlived the Ctrl-C: ${held.dir}`).toBe(false);
    } finally {
      stop(child);
    }
  }, 60_000);
});

// ---------------------------------------------------------------- AC10, the GONS path

interface GonsFixture { fix: string; sha1: string; sha2: string; fakeDir: string; fake: string }

let gons: Promise<GonsFixture> | null = null;

/**
 * A repository with a checkpoint and one change on top of it, and a fake claude for its model
 * calls. Made once, and shared by AC10 and the signal-listener probe below.
 */
function gonsFixture(): Promise<GonsFixture> {
  gons ??= makeGonsFixture();
  return gons;
}

async function makeGonsFixture(): Promise<GonsFixture> {
  // A stand-in for the claude CLI: as slow as the fixture says, and saying where it stood.
  const fakeDir = fresh('ac10-fake');
  const fake = path.join(fakeDir, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const dir = ${JSON.stringify(fakeDir)};
if (process.argv.includes('--version')) { process.stdout.write('fake 1.0\\n'); process.exit(0); }
// The pid first: whoever sees where.json can count on the pid being there already. Every pid
// is kept as well, so a run that carries on to another call cannot leave one running.
fs.writeFileSync(dir + '/pid', String(process.pid));
fs.appendFileSync(dir + '/pids', process.pid + '\\n');
const here = process.cwd();
fs.writeFileSync(dir + '/where.json', JSON.stringify({ cwd: here, listing: fs.readdirSync(here), mode: fs.statSync(here).mode & 0o777 }));
const slow = fs.existsSync(dir + '/slow') ? Number(fs.readFileSync(dir + '/slow', 'utf8')) : 0;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => setTimeout(() => {
  // No braces, so neither the interpreter nor the judge can read it: nothing is cached, and
  // every run asks the model again instead of reusing the last run's answer.
  process.stdout.write(JSON.stringify({ result: 'no structured answer here', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }));
  process.exit(0);
}, slow));
`);
  fs.chmodSync(fake, 0o755);

  // The interpretation cache is keyed on content and lives in this checkout, so a nonce keeps
  // any earlier answer for an identical file from standing in for the model call.
  const nonce = randomBytes(8).toString('hex');
  const source = (body: string): string =>
    `// ${nonce}\nexport function add(a: number, b: number): number {\n  return ${body};\n}\n`;
  const fix = newRepo('ac10-repo');
  fs.writeFileSync(path.join(fix, 'a.ts'), source('a + b'));
  git(fix, 'add', 'a.ts');
  git(fix, 'commit', '-q', '-m', 'one');
  const sha1 = git(fix, 'rev-parse', 'HEAD');

  // The checkpoint PR mode compares against is the digest on disk (`loadCheckpoint`).
  const digest = start(['--import', TSX, CLI, 'digest', fix, '--no-interpret'], {
    cwd: fresh('ac10-cwd'), env: { TMPDIR: fresh('ac10-tmp'), REPO_TOUR_CLAUDE_BIN: fake },
  });
  const done = await within(digest.exited, 60_000);
  if (!done) stop(digest);
  expect(done, `digest did not finish cleanly: ${digest.out()}`).toEqual({ code: 0, signal: null });
  expect(fs.existsSync(path.join(fix, '.repo-tour', 'digest.json')), 'digest wrote no checkpoint').toBe(true);

  fs.writeFileSync(path.join(fix, 'a.ts'), source('a + b + 0'));
  git(fix, 'add', 'a.ts');
  git(fix, 'commit', '-q', '-m', 'two');
  const sha2 = git(fix, 'rev-parse', 'HEAD');
  return { fix, sha1, sha2, fakeDir, fake };
}

/**
 * T-44 — how long one signal mid-call may take to end the run. Not 3 s: the first model call of a process starts
 * with a one-time pause, V8's TurboFan compiling the parser's WebAssembly while the main thread waits on it, and no
 * signal handler runs until it ends (T-20's review; T-21 holds the pause, parked by the owner). Measured
 * (`.autodev/evidence/T-44/`): 908 to 994 ms at rest; 1,150 to 2,725 ms, and once past 3 s, on four cores carrying
 * eight busy loops. Removing the pause (`--liftoff-only`) made every digest 65% slower, so the product keeps it and
 * this window allows for it. A swallowed signal still fails here: that run carries on through the fake's 20 s call
 * and the next one, so it is still running when the window ends.
 */
const SIGNAL_EXIT_MS = 15_000;

describe('T-20 AC10: `repo-tour pr` as GONS runs it, and stopped by a signal mid-call', () => {
  let fix: string;
  let sha1: string;
  let sha2: string;
  let fakeDir: string;
  let fake: string;

  beforeAll(async () => {
    ({ fix, sha1, sha2, fakeDir, fake } = await gonsFixture());
  }, 90_000);

  /** `repo-tour pr` the way GONS starts it: from a temp directory of its own, here with a private TMPDIR. */
  function startPr(slowMs: number): { child: Child; tmp: string } {
    for (const f of ['where.json', 'pid', 'pids']) fs.rmSync(path.join(fakeDir, f), { force: true });
    fs.writeFileSync(path.join(fakeDir, 'slow'), String(slowMs));
    const tmp = fresh('tmp');
    const child = start(['--import', TSX, CLI, 'pr', fix, '--base', sha1, '--head', sha2], {
      cwd: fresh('cwd'), env: { TMPDIR: tmp, REPO_TOUR_CLAUDE_BIN: fake },
    });
    return { child, tmp };
  }

  /** Everything repo-tour left in a temp dir: side trees (`repo-tour-<sha8>-*`) and `repo-tour-llm-*` alike. */
  const leftovers = (tmp: string): string[] => fs.readdirSync(tmp).filter((n) => n.startsWith('repo-tour-'));

  const whereNow = (): { cwd: string } | null => {
    try { return JSON.parse(fs.readFileSync(path.join(fakeDir, 'where.json'), 'utf8')) as { cwd: string }; }
    catch { return null; }
  };

  /** The fake's pid. Never 0 or 1: `process.kill(0, …)` signals the whole process group. */
  const fakePid = (): number | null => {
    try {
      const n = Number(fs.readFileSync(path.join(fakeDir, 'pid'), 'utf8'));
      return Number.isInteger(n) && n > 1 ? n : null;
    } catch { return null; }
  };

  /**
   * SIGKILL every fake this run started that is still running and is still that fake. A run
   * that swallows the signal carries on to its next model call, so there can be more than one.
   */
  const killFakes = (): void => {
    let pids: number[] = [];
    try { pids = fs.readFileSync(path.join(fakeDir, 'pids'), 'utf8').split('\n').map(Number); } catch { return; }
    for (const pid of pids) {
      if (!Number.isInteger(pid) || pid <= 1 || !running(pid)) continue;
      try { if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(fake)) continue; } catch { continue; }
      process.kill(pid, 'SIGKILL');
    }
  };

  it('a normal run exits 0 and leaves nothing in its temp dir', async () => {
    const { child, tmp } = startPr(0);
    try {
      const exit = await within(child.exited, 60_000);
      expect(exit, `the PR tour did not finish: ${child.out()}`).not.toBeNull();
      expect(exit, `a normal run must exit 0, which GONS reads as success: ${child.out()}`).toEqual({ code: 0, signal: null });
      const seen = whereNow();
      expect(seen, 'the PR tour never asked the model, so this run proves nothing').not.toBeNull();
      expect(path.dirname(seen!.cwd), 'the model call did not stand in the temp dir being counted')
        .toBe(fs.realpathSync(tmp));
      expect(leftovers(tmp), 'a normal run left temp entries behind').toEqual([]);
    } finally {
      stop(child);
      killFakes();
    }
  }, 90_000);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`one ${signal} mid-call ends it by ${signal}, stops its model call, and leaves nothing`, async () => {
      const { child, tmp } = startPr(20_000);
      // Another process's directories in the same temp dir (the owner's live server stands in
      // an empty one): killLlmChildren on this path must take only what this process made.
      const empty = fs.mkdtempSync(path.join(tmp, 'repo-tour-llm-'));
      const full = fs.mkdtempSync(path.join(tmp, 'repo-tour-llm-'));
      fs.writeFileSync(path.join(full, 'theirs.txt'), 'another process stands here');
      const ours = (): string[] => leftovers(tmp).filter((n) => n !== path.basename(empty) && n !== path.basename(full));
      let pid: number | null = null;
      try {
        // A model call in flight, while both PR sides are alive.
        const asked = await until(() => whereNow() !== null, 60_000);
        expect(asked, `no model call started: ${child.out()}`).toBe(true);
        pid = fakePid();
        expect(pid, 'the fake claude recorded no pid').not.toBeNull();
        expect(ours().filter((n) => !n.startsWith('repo-tour-llm-')), 'both PR sides should be alive during the call')
          .toHaveLength(2);

        child.proc.kill(signal);
        const exit = await within(child.exited, SIGNAL_EXIT_MS);
        expect.soft(exit, `still running ${SIGNAL_EXIT_MS / 1000} s after one ${signal}: the signal was swallowed and the tour carried on`)
          .not.toBeNull();
        if (exit) expect.soft(exit, `it ended, but not by ${signal} as it would with no handler`).toEqual({ code: null, signal });
        const stopped = await until(() => !running(pid!), 2000);
        expect.soft(stopped, `its model call (pid ${pid}) is still running after one ${signal}, and still paying`).toBe(true);
        expect.soft(ours(), `${signal} left temp entries behind`).toEqual([]);
        expect.soft(fs.existsSync(empty), `${signal} removed another process's empty directory: ${empty}`).toBe(true);
        expect.soft(fs.existsSync(path.join(full, 'theirs.txt')), `${signal} emptied another process's directory: ${full}`)
          .toBe(true);
      } finally {
        stop(child);
        killFakes();
      }
    }, 90_000);
  }
});

// ---------------------------------------------------------------- which commands listen for signals

describe('T-20: only `pr` gives up Node\'s own Ctrl-C', () => {
  // Any SIGINT or SIGTERM listener moves Ctrl-C off Node's instant default and onto the event
  // loop, and `digest`'s extraction runs for seconds without yielding to it. The seat measured
  // one Ctrl-C at 3 s into a 10 s digest: on main it died 10 ms later; with a listener, the whole
  // digest ran on and exited 0. Timing is too slow and too loose to pin that, so a probe watches
  // for the listener itself.
  let probe: string;

  beforeAll(() => {
    // Loaded with a second --import, after tsx's, so it sees every registration the program
    // makes and none of the loader's own.
    probe = path.join(base, 'signal-probe.mjs');
    fs.writeFileSync(probe, `import fs from 'node:fs';
const seen = [];
for (const name of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) {
  const original = process[name];
  process[name] = function (event, ...rest) {
    if (event === 'SIGINT' || event === 'SIGTERM') seen.push(name + ':' + event);
    return original.call(this, event, ...rest);
  };
}
process.on('exit', () => { fs.writeFileSync(process.env.SIGNAL_PROBE_OUT, JSON.stringify(seen)); });
`);
  });

  /** Run the CLI under the probe: how it ended, and every SIGINT/SIGTERM registration it made. */
  async function probed(args: string[], env: Record<string, string> = {}): Promise<{ exit: Exit | null; seen: string[] | null; out: string }> {
    const record = path.join(fresh('probe'), 'signals.json');
    const child = start(['--import', TSX, '--import', pathToFileURL(probe).href, CLI, ...args], {
      cwd: fresh('cwd'), env: { TMPDIR: fresh('tmp'), SIGNAL_PROBE_OUT: record, ...env },
    });
    const exit = await within(child.exited, 60_000);
    if (!exit) stop(child);
    const seen = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) as string[] : null;
    return { exit, seen, out: child.out() };
  }

  it('digest keeps it: nothing listens for SIGINT or SIGTERM, so one Ctrl-C ends it at once', async () => {
    const { fix } = await gonsFixture();
    const view = path.join(fresh('view'), 'view.html');
    const { exit, seen, out } = await probed(['digest', fix, '--no-interpret', '--no-write', '--view', view]);
    expect(exit, `digest did not finish cleanly: ${out}`).toEqual({ code: 0, signal: null });
    expect(seen, 'the probe wrote no record, so this run proves nothing').not.toBeNull();
    expect(seen, 'digest gave up Node\'s own Ctrl-C: it listens for a signal, and its extraction never yields to the loop that would run the listener')
      .toEqual([]);
  }, 90_000);

  it('tour keeps it too: its extraction is digest\'s, offline here (review nit 1)', async () => {
    const { fix } = await gonsFixture();
    const view = path.join(fresh('view'), 'tour.html');
    // --no-interpret asks no model (cached meanings only); --no-write keeps it out of the library.
    const { exit, seen, out } = await probed(['tour', fix, '--no-interpret', '--no-write', '--view', view]);
    expect(exit, `tour did not finish cleanly: ${out}`).toEqual({ code: 0, signal: null });
    expect(seen, 'the probe wrote no record, so this run proves nothing').not.toBeNull();
    expect(seen, 'tour gave up Node\'s own Ctrl-C: it listens for a signal').toEqual([]);
  }, 90_000);

  it('plan keeps it too: offline and deterministic without --interpret (review nit 1)', async () => {
    const { fix } = await gonsFixture();
    // --no-write keeps the fixture's checkpoint as it is; plan.json still lands in the fixture.
    const { exit, seen, out } = await probed(['plan', fix, '--no-write']);
    expect(exit, `plan did not finish cleanly: ${out}`).toEqual({ code: 0, signal: null });
    expect(seen, 'the probe wrote no record, so this run proves nothing').not.toBeNull();
    expect(seen, 'plan gave up Node\'s own Ctrl-C: it listens for a signal').toEqual([]);
  }, 90_000);

  it('a pr with nothing changed, where no side ever exists, has the CLI\'s own handler and nothing else (review nit 3)', async () => {
    const { fix, sha1 } = await gonsFixture();
    const { exit, seen, out } = await probed(['pr', fix, '--base', sha1, '--head', sha1]);
    expect(exit, `the empty PR tour did not finish cleanly: ${out}`).toEqual({ code: 0, signal: null });
    expect(out, 'this PR was meant to change nothing').toContain('nothing changed');
    // `once` shows twice: Node's `once` registers through `on`.
    expect(seen, 'pr lost its own handler: with no side alive, nothing stops its model calls on a signal')
      .toEqual(['once:SIGINT', 'on:SIGINT', 'once:SIGTERM', 'on:SIGTERM']);
  }, 90_000);

  it('pr listens for both, which shows the probe sees a registration when there is one', async () => {
    const { fix, sha1, sha2, fakeDir, fake } = await gonsFixture();
    fs.writeFileSync(path.join(fakeDir, 'slow'), '0');
    const { exit, seen, out } = await probed(['pr', fix, '--base', sha1, '--head', sha2], { REPO_TOUR_CLAUDE_BIN: fake });
    expect(exit, `the PR tour did not finish cleanly: ${out}`).toEqual({ code: 0, signal: null });
    expect(seen, 'the probe wrote no record, so this run proves nothing').not.toBeNull();
    expect(seen!.some((s) => s.endsWith(':SIGINT')), `the probe saw no SIGINT listener on pr: ${JSON.stringify(seen)}`).toBe(true);
    expect(seen!.some((s) => s.endsWith(':SIGTERM')), `the probe saw no SIGTERM listener on pr: ${JSON.stringify(seen)}`).toBe(true);
  }, 90_000);
});
