/**
 * T-29 — a cached page is reused only while the code that made it is the code running.
 *
 * The stamp on a cached page used to hash five hand-listed modules, so a change to any other
 * module (which stops exist, the Ask panel inlined into every page) left every cached page
 * "current". The owner's autoSQL tour, built 2026-09-22, kept the tutor panel from before the
 * T-18 rework. And Rebuild re-rendered nothing while the tree and the stamp both matched.
 *
 * A module change cannot be made to the code a test process is running, so most of these tests
 * run a server from a temp copy of the package, in a child process, and change the copy. Most of
 * those run twice: from `src/` under tsx (what `./repo-tour serve` runs) and from a `dist/` this
 * file compiles from `src/` (never the checkout's own `dist/`, which may predate the source).
 * Everything those servers write lands in the temp directory. The in-process checks run once;
 * their fixtures are temp folders too, and the only thing they create in the package is the
 * empty interpretation cache folder that `interpretStops` makes.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type ExpectStatic } from 'vitest';

import { RepoTourServer } from '../src/server.js';
import { configureAssets, resetAssets } from '../src/assets.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The tsx loader by address: `--import tsx` would be resolved from the working directory. */
const TSX = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

interface Runtime {
  name: string;
  /** the folder of the package that holds the running code */
  dir: 'src' | 'dist';
  ext: '.ts' | '.js';
  /** node's arguments ahead of the driver script */
  node: string[];
}

const RUNTIMES: Runtime[] = [
  { name: 'tsx, from src/', dir: 'src', ext: '.ts', node: ['--import', TSX] },
  { name: 'compiled, from dist/', dir: 'dist', ext: '.js', node: [] },
];
const TSX_RUNTIME = RUNTIMES[0]!;

/** The T-18 panel's words, which the owner's 2026-09-22 page does not carry. */
const PANEL = 'The connection to repo-tour dropped before the answer arrived';
const PANEL_CHANGE = 'dropped before the answer arrived';

/** Past the skins half's 2 s window, so no held value can hide a re-read. */
const PAST_THE_WINDOW_MS = 2_100;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True if `p` settles within `ms`. The timer is cleared either way, so nothing lingers. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); });
  try { return await Promise.race([p.then(() => true as const), late]); } finally { clearTimeout(timer); }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}

/**
 * A real repository with one documented function: the smallest tree that builds a tour.
 * `extra` adds that many more small modules, for a test that needs a build to take a while.
 */
function fixtureRepo(under: string, extra = 0): string {
  const repo = path.join(under, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'fixture@test.local');
  git(repo, 'config', 'user.name', 'fixture');
  fs.writeFileSync(path.join(repo, 'a.py'), 'def go(x):\n    """Do it."""\n    return x\n');
  for (let i = 0; i < extra; i++) {
    fs.mkdirSync(path.join(repo, 'more'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'more', `m${i}.py`),
      `def step_${i}(x):\n    """Step ${i}."""\n    return x + ${i}\n\n\nclass Part${i}:\n    def run(self, y):\n        return step_${i}(y)\n`);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

/**
 * The compiled runtime: this checkout's `src/`, compiled for this run into a temp folder.
 *
 * Copying the checkout's own `dist/` would certify whatever the last `npm run build` left there,
 * and `npm test` does not build first. Compiling it in place is not an option either: GONS runs
 * that `dist/`, so no test may rewrite it (the T-14 guard in `consumer.test.ts`).
 */
let compiledDist = '';
beforeAll(() => {
  compiledDist = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-pv-dist-'));
  execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', path.join(REPO_ROOT, 'tsconfig.json'),
    '--outDir', compiledDist, '--declaration', 'false', '--sourceMap', 'false',
  ], { stdio: 'pipe' });
}, 180_000);
afterAll(() => {
  if (compiledDist) fs.rmSync(compiledDist, { recursive: true, force: true });
});

/**
 * A copy of this package as it would run: one of `src/` or the compiled `dist/`, plus the assets
 * and the manifest, with the dependencies linked rather than copied.
 */
function copyPackage(rt: Runtime, under: string): string {
  const pkg = path.join(under, 'pkg');
  fs.mkdirSync(pkg, { recursive: true });
  for (const f of ['package.json', 'tsconfig.json']) fs.copyFileSync(path.join(REPO_ROOT, f), path.join(pkg, f));
  const code = rt.dir === 'dist' ? compiledDist : path.join(REPO_ROOT, rt.dir);
  if (!fs.existsSync(path.join(code, `server${rt.ext}`))) throw new Error(`${code} has no server${rt.ext}`);
  fs.cpSync(code, path.join(pkg, rt.dir), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'assets'), path.join(pkg, 'assets'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(pkg, 'node_modules'), 'dir');
  return pkg;
}

/** Rewrite one module of the copy, the way an edit or `npm run build` rewrites it on disk. */
function rewrite(pkg: string, rt: Runtime, mod: string, change: (src: string) => string): void {
  const file = path.join(pkg, rt.dir, `${mod}${rt.ext}`);
  const before = fs.readFileSync(file, 'utf8');
  const after = change(before);
  if (after === before) throw new Error(`the change to ${mod}${rt.ext} changed nothing: has the module moved on?`);
  fs.writeFileSync(file, after);
}

/**
 * The child process: a RepoTourServer from the copy, driven by one JSON command per line.
 *
 * `open` goes through the handler exactly as a browser's GET /r does, and reports which of the
 * strings it was asked about the page holds, and whether a build is running afterwards. Its
 * response closes after it ends, as a real one does, so a build waits for it the same way.
 * `rebuild` asks for a rebuild and answers at once. `crash` asks for one and dies straight after,
 * before it can start, as a killed server would.
 */
const DRIVER = `
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const [serverModule, repo, state] = process.argv.slice(2);
const { RepoTourServer } = await import(pathToFileURL(serverModule).href);
const server = new RepoTourServer({ statePath: state, interpret: false });
server.addRepo(repo);

async function call(url, method = 'GET', body) {
  let out = '';
  const res = Object.assign(new EventEmitter(), {
    writeHead() { return this; },
    end(chunk) {
      if (typeof chunk === 'string') out = chunk;
      setImmediate(() => this.emit('close'));
      return this;
    },
  });
  const req = {
    url, method, headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
  };
  await server.handler(req, res);
  return out;
}

const running = () => server.listRepos()[0].running;
async function settle() {
  const until = Date.now() + 60000;
  while (running() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

const commands = {
  async ping() { return {}; },
  async build() {
    const r = await server.build(repo, () => {});
    return { presentation: r.presentation, builtAt: r.builtAt };
  },
  async open({ look = [] }) {
    const body = await call('/r?path=' + encodeURIComponent(repo));
    return {
      tour: body.includes('id="startbig"'),
      found: Object.fromEntries(look.map((s) => [s, body.includes(s)])),
      running: running(),
    };
  },
  async settle() {
    await settle();
    return { running: running(), job: JSON.parse(await call('/api/job?path=' + encodeURIComponent(repo))) };
  },
  async stamp() {
    const built = server.listRepos()[0].built;
    return { presentation: built ? built.presentation : null, builtAt: built ? built.builtAt : null };
  },
  async touch({ name }) {
    fs.writeFileSync(path.join(repo, name), 'def more(x):\\n    """More of it."""\\n    return x\\n');
    return {};
  },
  async rebuild() {
    await call('/api/rebuild', 'POST', { path: repo });
    return {};
  },
  async crash() {
    await call('/api/rebuild', 'POST', { path: repo });
    process.exit(0);
  },
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line);
  try {
    process.stdout.write(JSON.stringify({ ok: true, ...(await commands[cmd.do](cmd)) }) + '\\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.stack) || e) }) + '\\n');
  }
}
await settle();
process.exit(0);
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Driver {
  send(cmd: Record<string, unknown>): Promise<any>;
  /** For a command that ends the process instead of answering. */
  sendAndWaitForExit(cmd: Record<string, unknown>): Promise<void>;
  /** A crash: this test's own child, killed outright, whatever it is doing. */
  kill(): Promise<void>;
  close(): Promise<void>;
}

function startDriver(rt: Runtime, pkg: string, repo: string, under: string): Driver {
  const script = path.join(under, 'driver.mjs');
  if (!fs.existsSync(script)) fs.writeFileSync(script, DRIVER);
  const proc: ChildProcess = spawn(
    process.execPath,
    [...rt.node, script, path.join(pkg, rt.dir, `server${rt.ext}`), repo, path.join(under, 'state.json')],
    { cwd: under, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
  // Ending the input of a driver that already died (the crash command) must not throw here.
  proc.stdin!.on('error', () => {});
  const exited = new Promise<void>((resolve) => { proc.on('exit', () => resolve()); });
  const replies: string[] = [];
  let waiting: ((line: string) => void) | null = null;
  readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
    if (waiting) { const w = waiting; waiting = null; w(line); } else replies.push(line);
  });
  const nextLine = (what: string): Promise<string> => {
    const queued = replies.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${what} in 90 s; stderr: ${stderr}`)), 90_000);
      waiting = (line) => { clearTimeout(timer); resolve(line); };
      void exited.then(() => {
        if (waiting) { clearTimeout(timer); reject(new Error(`the driver exited during ${what}; stderr: ${stderr}`)); }
      });
    });
  };
  return {
    async send(cmd) {
      proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
      const reply = JSON.parse(await nextLine(String(cmd['do']))) as { ok: boolean; error?: string };
      if (!reply.ok) throw new Error(`driver ${String(cmd['do'])} failed: ${reply.error}`);
      return reply;
    },
    async sendAndWaitForExit(cmd) {
      proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
      if (!(await within(exited, 90_000))) throw new Error(`still running after ${String(cmd['do'])}; stderr: ${stderr}`);
    },
    async kill() {
      proc.kill('SIGKILL');
      await exited;
    },
    async close() {
      proc.stdin!.end();
      // Only this test's own child: it settles its build first, so it normally exits by itself.
      if (!(await within(exited, 60_000))) { proc.kill('SIGKILL'); await exited; }
    },
  };
}

function scratch(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `repo-tour-pv-${name}-`));
}

/** One fresh server process from the copy, for the length of `use`. */
async function withDriver<T>(rt: Runtime, pkg: string, repo: string, under: string, use: (d: Driver) => Promise<T>): Promise<T> {
  const d = startDriver(rt, pkg, repo, under);
  try { return await use(d); } finally { await d.close(); }
}

/**
 * Build a page with the copy as it stands, change one module, and open the tour in a fresh
 * server: the cached page must be served once while a rebuild starts, and the rebuild must
 * leave a page with a new stamp. The control comes first: a fresh server with nothing changed
 * must reuse the page, or a stamp that changed with every process would pass for this.
 */
async function aModuleChangeIsSeen(
  rt: Runtime, mod: string, change: (src: string) => string, expect: ExpectStatic,
  look: { before?: string; after?: string } = {},
): Promise<void> {
  const under = scratch(mod.replace(/\W/g, '-'));
  try {
    const pkg = copyPackage(rt, under);
    const repo = fixtureRepo(under);

    const first = await withDriver(rt, pkg, repo, under, async (d) => {
      const built = await d.send({ do: 'build' });
      if (look.before) {
        const opened = await d.send({ do: 'open', look: [look.before] });
        expect(opened.found[look.before], `the page should carry the text this test changes: ${look.before}`).toBe(true);
      }
      return built as { presentation: string };
    });

    await withDriver(rt, pkg, repo, under, async (d) => {
      const same = await d.send({ do: 'open', look: [] });
      expect(same.running, 'nothing changed: a fresh server must reuse the page, not rebuild it').toBe(false);
    });

    rewrite(pkg, rt, mod, change);

    await withDriver(rt, pkg, repo, under, async (d) => {
      const strings = [look.before, look.after].filter((s): s is string => Boolean(s));
      const once = await d.send({ do: 'open', look: strings });
      expect.soft(once.tour, 'the first open after the change still serves the cached tour').toBe(true);
      expect.soft(once.running, `${mod}${rt.ext} changed, so the cached page is stale: opening it must start a rebuild behind the reader`).toBe(true);
      await d.send({ do: 'settle' });

      const stamp = await d.send({ do: 'stamp' });
      expect.soft(stamp.presentation, `a page rendered after ${mod}${rt.ext} changed must carry a new stamp`).not.toBe(first.presentation);
      if (look.after && look.before) {
        const next = await d.send({ do: 'open', look: strings });
        expect.soft(next.found[look.after], `the next open must serve the page the changed ${mod}${rt.ext} renders`).toBe(true);
        expect.soft(next.found[look.before], 'and no longer the old text').toBe(false);
      }
    });
  } finally {
    fs.rmSync(under, { recursive: true, force: true });
  }
}

describe.concurrent('AC1 + AC2: a module change anywhere in the running build makes a cached page stale', () => {
  for (const rt of RUNTIMES) {
    it(`${rt.name}: the Ask panel's words change, and the next open shows the new ones`, async ({ expect }) => {
      const nonce = randomBytes(6).toString('hex');
      // The T-18 change in miniature: only the panel's words move.
      const revised = `went quiet before the answer arrived (${nonce})`;
      await aModuleChangeIsSeen(rt, 'askpanel', (s) => s.replace(PANEL_CHANGE, revised), expect, {
        before: PANEL, after: revised,
      });
    }, 180_000);

    it(`${rt.name}: a change to extract, which decides what stops exist`, async ({ expect }) => {
      const nonce = randomBytes(6).toString('hex');
      await aModuleChangeIsSeen(rt, 'extract', (s) => `${s}\n// T-29 ${nonce}\n`, expect);
    }, 180_000);

    it(`${rt.name}: a change to a module in a subfolder (build/plan)`, async ({ expect }) => {
      const nonce = randomBytes(6).toString('hex');
      await aModuleChangeIsSeen(rt, 'build/plan', (s) => `${s}\n// T-29 ${nonce}\n`, expect);
    }, 180_000);
  }
});

describe.concurrent('AC3: the stamp names the code that is running, not the files on disk', () => {
  for (const rt of RUNTIMES) {
    it(`${rt.name}: a module rewritten under a running server does not re-stamp its pages`, async ({ expect }) => {
      // Under a dist/ server, `npm run build` rewrites the files while the old code keeps
      // running. A stamp read from disk would then name code that did not render the page, and
      // the restarted server would take that page as current and never re-render it.
      const under = scratch('running');
      try {
        const pkg = copyPackage(rt, under);
        const repo = fixtureRepo(under);
        await withDriver(rt, pkg, repo, under, async (d) => {
          const first = await d.send({ do: 'build' });
          rewrite(pkg, rt, 'repoview', (s) => `${s}\n// T-29 ${randomBytes(6).toString('hex')}\n`);
          await sleep(PAST_THE_WINDOW_MS);
          await d.send({ do: 'touch', name: 'later.py' });
          const second = await d.send({ do: 'build' });
          expect(second.builtAt, 'the second build must really render (the tree moved)').not.toBe(first.builtAt);
          expect(
            second.presentation,
            'this process still runs the code it loaded, so its pages must carry the same stamp',
          ).toBe(first.presentation);
        });
      } finally {
        fs.rmSync(under, { recursive: true, force: true });
      }
    }, 180_000);

    it(`${rt.name}: a module rewritten after the server loaded, before its first page, is not what the stamp names`, async ({ expect }) => {
      // What a stamp read lazily would get wrong: a dist/ server that has been up for a day when
      // `npm run build` runs, and only then serves its first page.
      const under = scratch('loaded');
      try {
        const pkg = copyPackage(rt, under);
        const repo = fixtureRepo(under);
        const original = await withDriver(rt, pkg, repo, under, async (d) => d.send({ do: 'build' }));
        await withDriver(rt, pkg, repo, under, async (d) => {
          await d.send({ do: 'ping' }); // loaded, and nothing has asked for a stamp yet
          rewrite(pkg, rt, 'repoview', (s) => `${s}\n// T-29 ${randomBytes(6).toString('hex')}\n`);
          await d.send({ do: 'touch', name: 'later.py' });
          const page = await d.send({ do: 'build' });
          expect(
            page.presentation,
            'this process runs the code it loaded, so its first page must carry the stamp of that code',
          ).toBe(original.presentation);
        });
      } finally {
        fs.rmSync(under, { recursive: true, force: true });
      }
    }, 180_000);
  }
});

describe.concurrent('AC5: a page in memory obeys the same stamp rule as a page on disk', () => {
  it(`${TSX_RUNTIME.name}: a skin saved under a running server reaches the page it already holds`, async ({ expect }) => {
    // The page is in memory, and its stamp is stale. The rebuild that opening it starts must
    // render, not hand that same page back.
    const under = scratch('skin');
    try {
      const rt = TSX_RUNTIME;
      const pkg = copyPackage(rt, under);
      const repo = fixtureRepo(under);
      const marker = `t29-skin-${randomBytes(6).toString('hex')}`;
      await withDriver(rt, pkg, repo, under, async (d) => {
        await d.send({ do: 'build' });
        fs.appendFileSync(path.join(pkg, 'assets', 'skins', 'base.css'), `\n/* ${marker} */\n`);
        await sleep(PAST_THE_WINDOW_MS);
        const once = await d.send({ do: 'open', look: [marker] });
        expect.soft(once.running, 'the skin changed, so opening the page must start a rebuild').toBe(true);
        await d.send({ do: 'settle' });
        const next = await d.send({ do: 'open', look: [marker] });
        expect(next.found[marker], 'and the rebuild must render the new stylesheet into the page').toBe(true);
      });
    } finally {
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 180_000);
});

describe.concurrent('AC4: a Rebuild cut off by a restart is resumed', () => {
  for (const rt of RUNTIMES) {
    it(`${rt.name}: the fresh server resumes it, although the page is current`, async ({ expect }) => {
      const under = scratch('restart');
      try {
        const pkg = copyPackage(rt, under);
        const repo = fixtureRepo(under);
        const d = startDriver(rt, pkg, repo, under);
        try {
          await d.send({ do: 'build' });
          // The reader presses Rebuild, and the server dies before the build has begun.
          await d.sendAndWaitForExit({ do: 'crash' });
        } finally {
          await d.close();
        }
        expect.soft(
          fs.existsSync(path.join(repo, '.repo-tour', 'building.json')),
          'the rebuild the reader asked for was cut off, so its marker is still there',
        ).toBe(true);

        await withDriver(rt, pkg, repo, under, async (fresh) => {
          const opened = await fresh.send({ do: 'open', look: [] });
          expect(opened.running, 'the reader asked for a rebuild: a fresh server must resume it, not decide the page is current').toBe(true);
          await fresh.send({ do: 'settle' });
        });
      } finally {
        fs.rmSync(under, { recursive: true, force: true });
      }
    }, 180_000);

    it(`${rt.name}: and so does one cut off mid-build, after it has logged its progress`, async ({ expect }) => {
      // The usual restart: a `tsx watch` reload or a Ctrl-C lands while the build runs, after
      // the marker has been rewritten with each progress line. That rewrite must keep saying
      // the reader asked. A few hundred modules keep the build running long enough to cut it.
      const under = scratch('restart-mid');
      try {
        const pkg = copyPackage(rt, under);
        const repo = fixtureRepo(under, 300);
        const marker = path.join(repo, '.repo-tour', 'building.json');
        const d = startDriver(rt, pkg, repo, under);
        try {
          await d.send({ do: 'build' });
          await d.send({ do: 'rebuild' });
          const until = Date.now() + 60_000;
          let progressed = false;
          while (!progressed && Date.now() < until) {
            try {
              progressed = (JSON.parse(fs.readFileSync(marker, 'utf8')) as { lines: string[] }).lines.includes('reading the tree…');
            } catch { /* not there yet, or mid-write */ }
            if (!progressed) await sleep(5);
          }
          expect(progressed, 'the rebuild never logged its first line').toBe(true);
          await d.kill();
        } finally {
          await d.close();
        }
        expect(
          fs.existsSync(marker),
          'the rebuild finished before it could be cut off (the fixture is too small for this machine), so this check proves nothing',
        ).toBe(true);

        await withDriver(rt, pkg, repo, under, async (fresh) => {
          const opened = await fresh.send({ do: 'open', look: [] });
          expect(opened.running, 'the marker rewritten mid-build must still say the reader asked: a fresh server must resume it').toBe(true);
          await fresh.send({ do: 'settle' });
        });
      } finally {
        fs.rmSync(under, { recursive: true, force: true });
      }
    }, 180_000);
  }
});

describe.concurrent('AC1: the walk never passes off what it cannot read as an unchanged build', () => {
  const COMPILED = RUNTIMES[1]!;

  it(`${COMPILED.name}: a code folder the server cannot list never matches a page from another process`, async ({ expect }) => {
    // Node imports a module by name through a folder it can search but not list, so the
    // server runs normally while the walk sees nothing: a stamp that never changes would reuse
    // every page as current, through any edit (T-29 again, silently).
    const under = scratch('unlisted');
    const pkg = path.join(under, 'pkg');
    try {
      copyPackage(COMPILED, under);
      const repo = fixtureRepo(under);
      fs.chmodSync(path.join(pkg, 'dist'), 0o111);
      expect(() => fs.readdirSync(path.join(pkg, 'dist')), 'the test needs a folder it cannot list').toThrow();
      await withDriver(COMPILED, pkg, repo, under, (d) => d.send({ do: 'build' }));
      await withDriver(COMPILED, pkg, repo, under, async (d) => {
        const opened = await d.send({ do: 'open', look: [] });
        expect(opened.running, 'a build the walk could not read is unknown, so its pages must be rebuilt, not reused').toBe(true);
        await d.send({ do: 'settle' });
      });
    } finally {
      if (fs.existsSync(path.join(pkg, 'dist'))) fs.chmodSync(path.join(pkg, 'dist'), 0o755);
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 180_000);

  it(`${TSX_RUNTIME.name}: a module that is a link counts by what it links to`, async ({ expect }) => {
    const under = scratch('linked');
    try {
      const rt = TSX_RUNTIME;
      const pkg = copyPackage(rt, under);
      const repo = fixtureRepo(under);
      const vendor = path.join(under, 'vendor', 'askpanel.ts');
      fs.mkdirSync(path.dirname(vendor), { recursive: true });
      fs.renameSync(path.join(pkg, 'src', 'askpanel.ts'), vendor);
      fs.symlinkSync(vendor, path.join(pkg, 'src', 'askpanel.ts'));
      await withDriver(rt, pkg, repo, under, (d) => d.send({ do: 'build' }));

      const revised = `went quiet before the answer arrived (${randomBytes(6).toString('hex')})`;
      fs.writeFileSync(vendor, fs.readFileSync(vendor, 'utf8').replace(PANEL_CHANGE, revised));
      await withDriver(rt, pkg, repo, under, async (d) => {
        const opened = await d.send({ do: 'open', look: [] });
        expect.soft(opened.running, 'the linked module changed, so the page is stale').toBe(true);
        await d.send({ do: 'settle' });
        const next = await d.send({ do: 'open', look: [revised] });
        expect(next.found[revised], 'and the next open carries what the module now says').toBe(true);
      });
    } finally {
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 180_000);
});

// ---------------------------------------------------------------- in this process

interface Meta { builtAt: string; presentation: string }

function onDisk(repo: string): { meta: Meta; html: string } {
  const dir = path.join(repo, '.repo-tour', 'rendered');
  const json = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  expect(json.length, 'one tree state, one page').toBe(1);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, json[0]!), 'utf8')) as Meta;
  return { meta, html: fs.readFileSync(path.join(dir, json[0]!.replace(/\.json$/, '.html')), 'utf8') };
}

/** Mark the page on disk as built by an older app, as a landing does. */
function makeStale(repo: string): void {
  const dir = path.join(repo, '.repo-tour', 'rendered');
  const metaPath = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))!);
  fs.writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath, 'utf8')), presentation: 'from-before' }));
}

async function settle(server: RepoTourServer, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && server.listRepos().some((r) => r.running)) await sleep(50);
}

/** A response still being sent: it closes when the test says so. */
function stillSending(): http.ServerResponse & EventEmitter {
  return Object.assign(new EventEmitter(), {
    writeHead() { return this; },
    end() { return this; },
  }) as unknown as http.ServerResponse & EventEmitter;
}

async function jobLines(server: RepoTourServer, repo: string): Promise<string[]> {
  let body = '';
  const capture = {
    writeHead() { return this; },
    end(chunk?: string) { if (typeof chunk === 'string') body = chunk; return this; },
  } as unknown as http.ServerResponse;
  await server.handler({ url: `/api/job?path=${encodeURIComponent(repo)}`, method: 'GET' } as http.IncomingMessage, capture);
  return (JSON.parse(body) as { lines: string[] }).lines;
}

async function open(server: RepoTourServer, repo: string, res: http.ServerResponse): Promise<void> {
  await server.handler({ url: `/r?path=${encodeURIComponent(repo)}`, method: 'GET' } as http.IncomingMessage, res);
}

describe('AC4: a rebuild the reader asks for re-renders', () => {
  it('POST /api/rebuild and /api/build re-render a page whose tree and stamp both match', async () => {
    const under = scratch('routes');
    const server = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false, port: 0 });
    const { port, close } = await server.listen();
    try {
      const repo = fixtureRepo(under);
      server.addRepo(repo);
      await server.build(repo, () => {});
      expect(server.listRepos()[0]!.current).toBe(true);

      for (const route of ['/api/rebuild', '/api/build']) {
        const before = onDisk(repo);
        await sleep(5);
        const posted = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: repo }),
        });
        expect(posted.status).toBe(200);

        let job: { state: string; lines: string[] } = { state: 'running', lines: [] };
        const until = Date.now() + 30_000;
        while (job.state === 'running' && Date.now() < until) {
          await sleep(50);
          job = await (await fetch(`http://127.0.0.1:${port}/api/job?path=${encodeURIComponent(repo)}`)).json() as typeof job;
        }
        expect(job.state).toBe('done');
        expect(job.lines, `${route} on a current page must render it again, not hand back the page on disk`).toContain('rendering…');

        const after = onDisk(repo);
        expect(after.meta.builtAt > before.meta.builtAt, `${route}: the page on disk must be the new one`).toBe(true);
        const served = await (await fetch(`http://127.0.0.1:${port}/r?path=${encodeURIComponent(repo)}`)).text();
        expect(served === after.html, `${route}: and /r must serve it`).toBe(true);
      }
    } finally {
      await close();
      await settle(server);
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);

  it('only the app\'s own pages can ask: another site, or a folder that is not loaded, starts nothing', async () => {
    // A forced build is a full digest and render, and it re-sends every stop whose explanation
    // failed. So a page on another site must not be able to start one (a text/plain POST needs no
    // preflight, and the browser labels it), nor start one for a path the reader never loaded or
    // spelled differently (each spelling would be a job of its own).
    const under = scratch('routes-who');
    const server = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false, port: 0 });
    const { port, close } = await server.listen();
    try {
      const repo = fixtureRepo(under);
      const elsewhere = path.join(under, 'elsewhere');
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, 'b.py'), 'def stay(x):\n    return x\n');
      server.addRepo(repo);
      await server.build(repo, () => {});
      const builtAt = onDisk(repo).meta.builtAt;

      const post = async (route: string, p: string, site?: string): Promise<number> => (await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8', ...(site ? { 'sec-fetch-site': site } : {}) },
        body: JSON.stringify({ path: p }),
      })).status;
      const idle = async (): Promise<boolean> => {
        await sleep(100);
        return !server.listRepos()[0]!.running;
      };

      for (const route of ['/api/rebuild', '/api/build']) {
        expect.soft(await post(route, repo, 'cross-site'), `${route} from another site must be refused`).toBe(403);
        expect.soft(await idle(), `${route} from another site must start nothing`).toBe(true);
        expect.soft(await post(route, `${repo}/`, undefined), `${route} for a path spelled unlike the loaded one must be refused`).toBe(404);
        expect.soft(await post(route, elsewhere, undefined), `${route} for a folder that is not loaded must be refused`).toBe(404);
      }
      await settle(server);
      expect(fs.existsSync(path.join(elsewhere, '.repo-tour')), 'nothing was built in a folder that is not loaded').toBe(false);
      expect(onDisk(repo).meta.builtAt, 'and the loaded repo was not rebuilt').toBe(builtAt);

      expect(await post('/api/rebuild', repo, 'same-origin'), 'the app\'s own page may ask').toBe(200);
      await settle(server);
      expect(onDisk(repo).meta.builtAt > builtAt, 'and its rebuild runs').toBe(true);
    } finally {
      await close();
      await settle(server);
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);

  it('a marker from a build that did finish is still cleared when the page is current (a guard)', async () => {
    const under = scratch('marker');
    let fresh: RepoTourServer | null = null;
    try {
      const repo = fixtureRepo(under);
      const first = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      first.addRepo(repo);
      await first.build(repo, () => {});

      const marker = path.join(repo, '.repo-tour', 'building.json');
      fs.writeFileSync(marker, JSON.stringify({ startedAt: new Date().toISOString(), lines: ['reading the tree…'] }));
      fresh = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      expect(fresh.listRepos()[0]!.running, 'nobody asked for this one again: the page is current').toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      // Whatever failed above, a build it started must finish before the fixture goes.
      if (fresh) await settle(fresh);
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);

  it('a marker dated in the future is not resumed, whatever it says', async () => {
    // The marker lives in the toured repository, which can ship one. A negative age passed the
    // resume window, and with `force` it now rebuilt a current page at every start.
    const under = scratch('marker-future');
    let fresh: RepoTourServer | null = null;
    try {
      const repo = fixtureRepo(under);
      const first = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      first.addRepo(repo);
      await first.build(repo, () => {});

      const marker = path.join(repo, '.repo-tour', 'building.json');
      fs.writeFileSync(marker, JSON.stringify({ startedAt: '2099-01-01T00:00:00.000Z', lines: ['reading the tree…'], force: true }));
      fresh = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      expect(fresh.listRepos()[0]!.running, 'a marker from the future is no build anybody started').toBe(false);
      expect(fs.existsSync(marker), 'and it is cleared').toBe(false);
    } finally {
      if (fresh) await settle(fresh);
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('AC7: a rebuild waits until the page that started it has been sent', () => {
  it('opening a stale page answers before the rebuild does any work', async () => {
    // The digest's first stretch is synchronous: the inventory walks and hashes the whole tree
    // before anything yields. Started inside the request, it held the page back for as long as
    // that took, on the first open after every update to the app.
    const under = scratch('answer-first');
    const sending = stillSending();
    let fresh: RepoTourServer | null = null;
    try {
      const repo = fixtureRepo(under);
      const state = path.join(under, 'state.json');
      const first = new RepoTourServer({ statePath: state, interpret: false });
      first.addRepo(repo);
      await first.build(repo, () => {});
      makeStale(repo);

      fresh = new RepoTourServer({ statePath: state, interpret: false });
      await open(fresh, repo, sending);

      expect(fresh.listRepos()[0]!.running, 'the page is stale, so a rebuild is under way').toBe(true);
      // Several turns of the event loop: a page of a few megabytes takes more than one to send,
      // so starting on the next turn would still stall it.
      await sleep(50);
      expect(await jobLines(fresh, repo), 'but it must not start its work while the page is still being sent').toEqual([]);

      sending.emit('close');
      await settle(fresh);
      expect(onDisk(repo).meta.presentation, 'once the page is sent, the rebuild runs').not.toBe('from-before');
    } finally {
      // Let any build finish before the fixture goes, whatever failed above: a build still
      // running writes its cache back into a deleted folder and leaves it in the temp dir.
      sending.emit('close');
      if (fresh) await settle(fresh);
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);

  it('and so does the rebuild of a stale page held in memory', async () => {
    // The other way into a rebuild on open: a skin saved under a running server makes the page
    // it holds in memory stale (AC5). That page is just as large.
    const under = scratch('answer-first-hot');
    const assets = path.join(under, 'assets');
    fs.cpSync(path.join(REPO_ROOT, 'assets'), assets, { recursive: true });
    configureAssets({ assetsDir: assets });
    const sending = stillSending();
    let server: RepoTourServer | null = null;
    try {
      const repo = fixtureRepo(under);
      server = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      server.addRepo(repo);
      await server.build(repo, () => {});
      const marker = `t29-hot-${randomBytes(6).toString('hex')}`;
      fs.appendFileSync(path.join(assets, 'skins', 'base.css'), `\n/* ${marker} */\n`);
      await sleep(PAST_THE_WINDOW_MS);

      await open(server, repo, sending);
      expect(server.listRepos()[0]!.running, 'the page in memory is stale, so a rebuild is under way').toBe(true);
      await sleep(50);
      expect(await jobLines(server, repo), 'but it must not start its work while the page is still being sent').toEqual([]);

      sending.emit('close');
      await settle(server);
      expect(onDisk(repo).html, 'once the page is sent, the rebuild runs').toContain(marker);
    } finally {
      sending.emit('close');
      if (server) await settle(server);
      resetAssets();
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);

  it('a response that has already closed still starts its build', async () => {
    // Waiting for a `close` that has already gone by would leave the job "running" and never
    // started, and every later Rebuild would be handed that same dead job until a restart.
    const under = scratch('closed');
    const closed = await new Promise<http.ServerResponse>((resolve) => {
      const srv = http.createServer((_req, res) => {
        res.once('close', () => { srv.close(); resolve(res); });
        res.end('done');
      });
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as import('node:net').AddressInfo;
        http.get({ port, host: '127.0.0.1', agent: false }, (r) => r.resume());
      });
    });
    let server: RepoTourServer | null = null;
    try {
      const repo = fixtureRepo(under);
      server = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      server.addRepo(repo);
      await server.build(repo, () => {});
      const builtAt = onDisk(repo).meta.builtAt;

      (server as unknown as { startJob(p: string, force: boolean, res: http.ServerResponse): unknown })
        .startJob(repo, true, closed);
      await settle(server, 10_000);
      expect(server.listRepos()[0]!.running, 'the build must have started and finished').toBe(false);
      expect(onDisk(repo).meta.builtAt > builtAt, 'and rendered the page again').toBe(true);
    } finally {
      if (server) await settle(server, 10_000);
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('after an update, the listing reads each stale page\'s .json, not its HTML', () => {
  it('reports the newest build of a stale repo without opening its page', async () => {
    // Every page goes stale after an update to the app, and every open tab polls the listing every
    // four seconds. Reading each stale page's whole HTML (megabytes) to report its .json was waste.
    const under = scratch('listing');
    let html = '';
    try {
      const repo = fixtureRepo(under);
      const first = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      first.addRepo(repo);
      await first.build(repo, () => {});
      makeStale(repo);
      const dir = path.join(repo, '.repo-tour', 'rendered');
      html = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.html'))!);
      fs.chmodSync(html, 0o000);
      expect(() => fs.readFileSync(html), 'the test needs a page it cannot read').toThrow();

      const fresh = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      const listed = fresh.listRepos()[0]!;
      expect(listed.built, 'the listing needs only the .json').not.toBeNull();
      expect(listed.built!.stops).toBeGreaterThan(0);
    } finally {
      if (html && fs.existsSync(html)) fs.chmodSync(html, 0o644);
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('AC1: the skins half reads the root the renderer reads', () => {
  it('a skin edit under a configured asset root changes the stamp', async () => {
    const under = scratch('assets');
    const assets = path.join(under, 'assets');
    fs.cpSync(path.join(REPO_ROOT, 'assets'), assets, { recursive: true });
    configureAssets({ assetsDir: assets });
    try {
      const repo = fixtureRepo(under);
      const server = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      server.addRepo(repo);
      const first = await server.build(repo, () => {});

      const marker = `t29-root-${randomBytes(6).toString('hex')}`;
      fs.appendFileSync(path.join(assets, 'skins', 'base.css'), `\n/* ${marker} */\n`);
      await sleep(PAST_THE_WINDOW_MS);
      fs.writeFileSync(path.join(repo, 'later.py'), 'def more(x):\n    return x\n');
      const second = await server.build(repo, () => {});

      expect(second.html, 'the renderer reads the configured root').toContain(marker);
      expect(second.presentation, 'so the stamp must change with a skin edit there').not.toBe(first.presentation);
    } finally {
      resetAssets();
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('AC3: the stamp is read before the render reads the skins', () => {
  it('a skin saved as the render starts leaves the page stale, never current', async () => {
    // The order matters for the case no test can schedule: a skin saved between the render's read
    // and a stamp read after it would stamp a page with a stylesheet it does not carry, and that
    // page would be reused as current. Read first, the stamp can only be older than the page, so
    // the same save costs one more render. This sees the order through that effect: the skin is
    // saved where the render is about to read it, and held past the skins half's 2 s window so a
    // stamp read afterwards would be a fresh read. (Proposed by the T-29 auto-review.)
    const under = scratch('order');
    const assets = path.join(under, 'assets');
    fs.cpSync(path.join(REPO_ROOT, 'assets'), assets, { recursive: true });
    configureAssets({ assetsDir: assets });
    try {
      const repo = fixtureRepo(under);
      const server = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
      server.addRepo(repo);
      const marker = `t29-order-${randomBytes(6).toString('hex')}`;
      const page = await server.build(repo, (line) => {
        if (line !== 'rendering…') return;
        fs.appendFileSync(path.join(assets, 'skins', 'base.css'), `\n/* ${marker} */\n`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAST_THE_WINDOW_MS);
      });
      expect(page.html, 'the render read the skin saved as it started').toContain(marker);

      const lines: string[] = [];
      await server.build(repo, (l) => lines.push(l));
      expect(lines, 'the stamp must be read before the render reads the skins, so this page is stale, not current').toContain('rendering…');
    } finally {
      resetAssets();
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});
