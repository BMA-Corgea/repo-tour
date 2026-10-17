/**
 * T-44 — `repo-tour pr` hears a signal at once, even at the start of its first model call.
 *
 * Node runs a signal's listener from its event loop. When nothing holds that loop, Node first
 * waits, on the main thread, for every background job V8 has started, and nothing held it while
 * `pr` loaded its grammars: they wait on V8's promises, not on anything of Node's. The job it then
 * met was TurboFan compiling the parser code the extraction had just made hot, and it met it at
 * the start of its first model call. A signal there waited about 1 s at rest and up to 5 s on
 * loaded cores, past the 3 s that T-20's mid-call pair allows. `src/cli.ts` now holds the loop for
 * the whole of `pr`.
 *
 * T-20's pair sees that wait only when load stretches it past 3 s. This measures the wait itself:
 * how long one signal, sent as the first model call starts, takes to reach any JavaScript. A probe
 * loaded beside the CLI listens for SIGUSR2, which means nothing to repo-tour, and prints when it
 * ran. A signal listener does not hold the loop, so the probe cannot hide the wait, and it is not
 * the CLI's own handler, so this passes or fails on the wait alone, whatever that handler does.
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
/** The tsx loader by address: `pr` starts from a temp directory, with no node_modules to find it in. */
const TSX = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

/**
 * How long the signal may wait. Measured with this check (`.autodev/evidence/T-44/rework/`), on four
 * cores carrying no, eight and twelve busy loops: without the held loop, 966 to 1,047 ms, 2.5 to
 * 2.9 s and 3.2 to 4.7 s; with it, 0 to 5 ms at all three.
 */
const HANDLED_WITHIN_MS = 500;

let base: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-pause-'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** A new, empty directory inside this file's own scratch space. */
const fresh = (name: string): string => fs.mkdtempSync(path.join(base, `${name}-`));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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
function stop(child: Child): void {
  if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGKILL');
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

describe('T-44: one signal at the start of `pr`\'s first model call reaches JavaScript at once', () => {
  let fix: string;
  let sha1: string;
  let sha2: string;
  let fakeDir: string;
  let fake: string;
  let probe: string;

  beforeAll(async () => {
    // A stand-in for the claude CLI: it notes each call's pid as the call starts, then takes 20 s.
    fakeDir = fresh('fake');
    fake = path.join(fakeDir, 'claude');
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) { process.stdout.write('fake 1.0\\n'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(fakeDir, 'pids'))}, process.pid + '\\n');
process.stdin.on('data', () => {});
process.stdin.on('end', () => setTimeout(() => {
  process.stdout.write(JSON.stringify({ result: 'no structured answer here', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }));
  process.exit(0);
}, 20000));
`);
    fs.chmodSync(fake, 0o755);

    // One change on top of a checkpoint, as in T-20's AC10. The interpretation cache is keyed on
    // content and lives in this checkout, so a nonce keeps an earlier answer from standing in for
    // the model call.
    const nonce = randomBytes(8).toString('hex');
    const source = (body: string): string =>
      `// ${nonce}\nexport function add(a: number, b: number): number {\n  return ${body};\n}\n`;
    fix = fresh('repo');
    git(fix, 'init', '-q');
    git(fix, 'config', 'user.email', 'test@example.com');
    git(fix, 'config', 'user.name', 'repo-tour test');
    fs.writeFileSync(path.join(fix, 'a.ts'), source('a + b'));
    git(fix, 'add', 'a.ts');
    git(fix, 'commit', '-q', '-m', 'one');
    sha1 = git(fix, 'rev-parse', 'HEAD');
    const digest = start(['--import', TSX, CLI, 'digest', fix, '--no-interpret'], {
      cwd: fresh('cwd'), env: { TMPDIR: fresh('tmp'), REPO_TOUR_CLAUDE_BIN: fake },
    });
    const done = await within(digest.exited, 60_000);
    if (!done) stop(digest);
    expect(done, `digest did not finish cleanly: ${digest.out()}`).toEqual({ code: 0, signal: null });
    fs.writeFileSync(path.join(fix, 'a.ts'), source('a + b + 0'));
    git(fix, 'add', 'a.ts');
    git(fix, 'commit', '-q', '-m', 'two');
    sha2 = git(fix, 'rev-parse', 'HEAD');

    // Loaded with a second --import, after tsx's, so it listens before the CLI runs.
    probe = path.join(base, 'pause-probe.mjs');
    fs.writeFileSync(probe, `process.on('SIGUSR2', () => { process.stdout.write('PAUSE-PROBE ' + Date.now() + '\\n'); });\n`);
  }, 90_000);

  /** The pid of every model call this run started so far. Never 0 or 1, which would signal a group. */
  const fakePids = (): number[] => {
    try {
      return fs.readFileSync(path.join(fakeDir, 'pids'), 'utf8').split('\n').map(Number).filter((n) => Number.isInteger(n) && n > 1);
    } catch { return []; }
  };

  it(`one signal sent as the first model call starts reaches JavaScript within ${HANDLED_WITHIN_MS} ms`, async ({ task }) => {
    fs.rmSync(path.join(fakeDir, 'pids'), { force: true });
    const child = start(['--import', TSX, '--import', pathToFileURL(probe).href, CLI, 'pr', fix, '--base', sha1, '--head', sha2], {
      cwd: fresh('cwd'), env: { TMPDIR: fresh('tmp'), REPO_TOUR_CLAUDE_BIN: fake },
    });
    const handled = /^PAUSE-PROBE (\d+)$/m;
    try {
      const asked = await until(() => fakePids().length > 0, 60_000);
      expect(asked, `no model call started: ${child.out()}`).toBe(true);
      const sent = Date.now();
      child.proc.kill('SIGUSR2');
      const seen = await until(() => handled.test(child.out()), 30_000);
      expect(seen, `one signal, sent as the first model call started, had reached no JavaScript 30 s later: ${child.out()}`)
        .toBe(true);
      const waited = Number(handled.exec(child.out())![1]) - sent;
      Object.assign(task.meta, { waitedMs: waited }); // in the JSON report, for the record
      expect(waited, `one signal, sent as the first model call started, waited ${waited} ms to reach any JavaScript: `
        + 'nothing held the event loop, so Node held the main thread until V8\'s background compile was done')
        .toBeLessThan(HANDLED_WITHIN_MS);
    } finally {
      // End it as T-20's pair does, then make sure of it and of every model call it started.
      child.proc.kill('SIGTERM');
      await within(child.exited, 30_000);
      stop(child);
      for (const pid of fakePids()) {
        // Only a process that is still this fake: an ended one's pid may be someone else's now.
        try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(fake)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  }, 120_000);
});
