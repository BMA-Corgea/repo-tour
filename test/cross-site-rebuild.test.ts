/**
 * T-34 — only a visit the reader made starts a build behind the page.
 *
 * `GET /r` started the automatic rebuild of a stale page for any request, and `GET /pr` started a PR tour, with
 * its model calls, the same way. A browser sends both for an image, a script, a frame or a fetch that another
 * site's page embeds, with no click and no preflight, and since T-29 every page is stale after every update.
 *
 * Each request below carries the Fetch Metadata headers a real browser sends for one way of reaching the page,
 * as measured in headless Chromium 151 and Firefox 153 (T-34's evidence, `probe-headers.json`). They go over
 * real HTTP with node:http, not fetch: Node's fetch sends `sec-fetch-mode: cors` whatever a test asks for, and a
 * navigation has to say `navigate`.
 *
 * Also here, from T-46 (AC5): no other site may put a repo-tour page in a frame.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { RepoTourServer } from '../src/server.js';
import { configureAssets, resetAssets } from '../src/assets.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Past the skins half's 2 s window, so the stamp is read again (T-29). */
const PAST_THE_WINDOW_MS = 2_100;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scratch(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `repo-tour-t34-${name}-`));
}

/** A real repository with one documented function: the smallest tree that builds a tour. No remote. */
function fixtureRepo(under: string, name = 'repo'): string {
  const repo = path.join(under, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@test.local');
  git('config', 'user.name', 'fixture');
  fs.writeFileSync(path.join(repo, 'a.py'), 'def go(x):\n    """Do it."""\n    return x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}

/** Mark the page on disk as built by an older app, as a landing does. */
function makeStale(repo: string): void {
  const dir = path.join(repo, '.repo-tour', 'rendered');
  const metaPath = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))!);
  fs.writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath, 'utf8')), presentation: 'from-before' }));
}

function presentationOnDisk(repo: string): string {
  const dir = path.join(repo, '.repo-tour', 'rendered');
  const json = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  expect(json.length, 'one tree state, one page').toBe(1);
  return (JSON.parse(fs.readFileSync(path.join(dir, json[0]!), 'utf8')) as { presentation: string }).presentation;
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }

/** A GET with exactly these headers, on a connection of its own. */
function get(port: number, route: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

const tourOf = (repo: string): string => `/r?path=${encodeURIComponent(repo)}`;
const prOf = (repo: string, n: number): string => `/pr?path=${encodeURIComponent(repo)}&n=${n}`;

async function prJob(port: number, repo: string, n: number): Promise<{ state: string; lines: string[] }> {
  return JSON.parse((await get(port, `/api/job?path=${encodeURIComponent(`${repo}#pr-${n}`)}`)).body) as { state: string; lines: string[] };
}

async function settle(server: RepoTourServer, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && server.listRepos().some((r) => r.running)) await sleep(50);
}

/** A PR job on a fixture with no remote fails at once; wait for that before the fixture goes. */
async function settlePr(port: number, repo: string, n: number, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && (await prJob(port, repo, n)).state === 'running') await sleep(50);
}

/** A server listening on a port of its own, closed and settled whatever the test did. */
async function withServer(
  under: string,
  use: (port: number, server: RepoTourServer) => Promise<void>,
): Promise<void> {
  const server = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false, port: 0 });
  const { port, close } = await server.listen();
  try { await use(port, server); } finally {
    await settle(server);
    await close();
  }
}

/** A built page made stale on disk, for a fresh server that has not opened it: T-8's shape. */
async function staleOnDisk(under: string): Promise<string> {
  const repo = fixtureRepo(under);
  const builder = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false });
  builder.addRepo(repo);
  await builder.build(repo, () => {});
  makeStale(repo);
  return repo;
}

/**
 * Mark the page a running server holds in memory as built by an older app. That is the stale page a skin saved
 * under the server leaves (T-29's AC5), without waiting out the skins' 2 s window again.
 */
function makeStaleInMemory(server: RepoTourServer, repo: string): void {
  const held = (server as unknown as { cache: Map<string, { presentation: string }> }).cache.get(repo);
  if (!held) throw new Error('the server holds no page for this repository');
  held.presentation = 'from-before';
}

/**
 * The job a server holds for a repository, or for `<path>#pr-<n>`. A request that starts a build registers a new
 * one before its page is sent. `running` is no sign of it: a small fixture's build can be over before the page
 * has been read, and `running` is false again by then.
 */
function jobOf(server: RepoTourServer, key: string): unknown {
  return (server as unknown as { jobs: Map<string, unknown> }).jobs.get(key);
}

/** Send one request, and say whether it started a build under `key`. */
async function sendAndSee(server: RepoTourServer, key: string, send: () => Promise<Answer>): Promise<Answer & { started: boolean }> {
  const before = jobOf(server, key);
  const answer = await send();
  return { ...answer, started: jobOf(server, key) !== before };
}

// ------------------------------------------------------------------- what browsers send

/**
 * What another site's page embeds, or makes the tab do without a click. None of these carries `Sec-Fetch-User` in
 * either browser, except a click inside another site's frame: that one navigates the frame, not the tab.
 */
const EMBEDDED = [
  { name: 'an image', mode: 'no-cors', dest: 'image' },
  { name: 'a script', mode: 'no-cors', dest: 'script' },
  { name: 'a stylesheet', mode: 'no-cors', dest: 'style' },
  { name: 'a fetch', mode: 'cors', dest: 'empty' },
  { name: 'a no-cors fetch', mode: 'no-cors', dest: 'empty' },
  { name: 'a frame', mode: 'navigate', dest: 'iframe' },
  { name: 'a link clicked inside a frame', mode: 'navigate', dest: 'iframe', user: '?1' },
  { name: 'an object', mode: 'navigate', dest: 'object' },
  { name: 'an embed', mode: 'navigate', dest: 'embed' },
  { name: 'a navigation of the tab that nobody clicked (a script, a refresh, a form it sends)', mode: 'navigate', dest: 'document' },
];

/** `cross-site` from another domain; `same-site` from another local app on another port (a GONS page, say). */
const OTHER_SITES = ['cross-site', 'same-site'];

const NOT_THE_READER = OTHER_SITES.flatMap((site) => EMBEDDED.map((e) => ({
  label: `${e.name} from ${site === 'cross-site' ? 'another site' : 'another local app'} (${site}, ${e.mode}, ${e.dest}${e.user ? `, ${e.user}` : ''})`,
  headers: {
    'sec-fetch-site': site, 'sec-fetch-mode': e.mode, 'sec-fetch-dest': e.dest,
    ...(e.user ? { 'sec-fetch-user': e.user } : {}),
  } as Record<string, string>,
})));

const navigation = (site: string, clicked: boolean): Record<string, string> => ({
  'sec-fetch-site': site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
  ...(clicked ? { 'sec-fetch-user': '?1' } : {}),
});

/** The reader's own visits. A request with no Fetch Metadata at all is T-8's test, left as it was. */
const THE_READER = [
  { name: 'a click on a page of repo-tour\'s own', headers: navigation('same-origin', true) },
  { name: 'repo-tour\'s own page navigating by script, as the live reload and the building page do', headers: navigation('same-origin', false) },
  { name: 'the address bar or a bookmark', headers: navigation('none', true) },
  { name: 'Firefox reloading a tab first opened from the address bar', headers: navigation('none', false) },
  { name: 'a link clicked on another local app (GONS, on another port)', headers: navigation('same-site', true) },
  { name: 'a link clicked on another site', headers: navigation('cross-site', true) },
];

// ------------------------------------------------------------------- AC1

describe('AC1: what another site embeds, or makes the tab do on its own, starts nothing', () => {
  it('GET /r on a page made stale by an update (on disk): the page, and no rebuild', async () => {
    const under = scratch('disk');
    try {
      const repo = await staleOnDisk(under);
      for (const c of NOT_THE_READER) {
        // A fresh server for each request, with the page marked stale again: a request that did start the
        // rebuild leaves the page current, and the next one would then prove nothing.
        makeStale(repo);
        await withServer(under, async (port, server) => {
          server.addRepo(repo);
          const a = await sendAndSee(server, repo, () => get(port, tourOf(repo), c.headers));
          expect.soft(a.status, `${c.label}: still gets the page`).toBe(200);
          expect.soft(a.body, `${c.label}: still gets the page`).toContain('id="startbig"');
          expect.soft(a.started, `${c.label} must not start the rebuild`).toBe(false);
        });
      }
      expect.soft(fs.existsSync(path.join(repo, '.repo-tour', 'building.json')), 'no build marker').toBe(false);
      expect.soft(presentationOnDisk(repo), 'the page on disk is still the stale one').toBe('from-before');

      // The control: the page really was stale, and the reader's own visit rebuilds it.
      makeStale(repo);
      await withServer(under, async (port, server) => {
        server.addRepo(repo);
        const own = await sendAndSee(server, repo, () => get(port, tourOf(repo), navigation('none', true)));
        expect(own.started, 'the reader\'s own visit to the same page starts the rebuild').toBe(true);
        await settle(server);
        expect(presentationOnDisk(repo)).not.toBe('from-before');
      });
    } finally {
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 120_000);

  it('GET /r on a page made stale under a running server (in memory): the page, and no rebuild', async () => {
    const under = scratch('memory');
    const assets = path.join(under, 'assets');
    fs.cpSync(path.join(REPO_ROOT, 'assets'), assets, { recursive: true });
    configureAssets({ assetsDir: assets });
    try {
      const repo = fixtureRepo(under);
      await withServer(under, async (port, server) => {
        server.addRepo(repo);
        await server.build(repo, () => {});
        // The real way a page in memory goes stale: a skin saved under the running server.
        const marker = `t34-skin-${randomBytes(6).toString('hex')}`;
        fs.appendFileSync(path.join(assets, 'skins', 'base.css'), `\n/* ${marker} */\n`);
        await sleep(PAST_THE_WINDOW_MS);

        for (const c of NOT_THE_READER) {
          const a = await sendAndSee(server, repo, () => get(port, tourOf(repo), c.headers));
          expect.soft(a.status, `${c.label}: still gets the page`).toBe(200);
          expect.soft(a.body, `${c.label}: still gets the page`).toContain('id="startbig"');
          expect.soft(a.started, `${c.label} must not start the rebuild`).toBe(false);
          if (a.started) {
            // Let it finish and mark the page stale again, so the next request is a fair test.
            await settle(server);
            makeStaleInMemory(server, repo);
          }
        }

        // The control: the page in memory really was stale, and the reader's own visit rebuilds it.
        const own = await sendAndSee(server, repo, () => get(port, tourOf(repo), navigation('same-origin', true)));
        expect(own.started, 'the reader\'s own visit to the same page starts the rebuild').toBe(true);
        await settle(server);
        expect((await get(port, tourOf(repo), navigation('same-origin', true))).body, 'and the next open has the new skin').toContain(marker);
      });
    } finally {
      resetAssets();
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 120_000);

  it('GET /pr with no tour built: a page that offers the build, and no job', async () => {
    const under = scratch('pr');
    try {
      const repo = fixtureRepo(under);
      await withServer(under, async (port, server) => {
        server.addRepo(repo);
        for (const [i, c] of NOT_THE_READER.entries()) {
          // A pull request of its own for each, so one request's job cannot hide the next one's.
          const n = 100 + i;
          const a = await get(port, prOf(repo, n), c.headers);
          expect.soft(a.status, `${c.label}: still gets a page`).toBe(200);
          expect.soft(a.body, `${c.label}: a page that says the tour is not built`).toContain('has no tour yet');
          expect.soft(a.body, `${c.label}: and links to the same address, so a click builds it`)
            .toContain(`href="/pr?path=${encodeURIComponent(repo)}&amp;n=${n}"`);
          expect.soft((await prJob(port, repo, n)).state, `${c.label} must not start the PR tour`).toBe('idle');
          await settlePr(port, repo, n);
        }

        // The control: the reader's own visit starts one.
        const own = await get(port, prOf(repo, 99), navigation('same-origin', true));
        expect(own.body, 'the reader\'s own visit gets the building page').toContain(`var jobKey = ${JSON.stringify(`${repo}#pr-99`)}`);
        expect((await prJob(port, repo, 99)).state, 'and its job').not.toBe('idle');
        await settlePr(port, repo, 99);
      });
    } finally {
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});

// ------------------------------------------------------------------- AC2

describe('AC2: the reader\'s own visits still start it', () => {
  for (const visit of THE_READER) {
    it(`GET /r on a stale page, by ${visit.name}`, async () => {
      const under = scratch('visit-r');
      try {
        const repo = await staleOnDisk(under);
        await withServer(under, async (port, server) => {
          server.addRepo(repo);
          const a = await sendAndSee(server, repo, () => get(port, tourOf(repo), visit.headers));
          expect(a.status).toBe(200);
          expect(a.body, 'the page, while the rebuild runs behind it').toContain('id="startbig"');
          expect(a.started, `${visit.name} must start the rebuild`).toBe(true);
          await settle(server);
          expect(presentationOnDisk(repo), 'and the rebuild ran').not.toBe('from-before');
        });
      } finally {
        fs.rmSync(under, { recursive: true, force: true });
      }
    }, 60_000);
  }

  for (const [i, visit] of THE_READER.entries()) {
    it(`GET /pr with no tour built, by ${visit.name}`, async () => {
      const under = scratch('visit-pr');
      const n = 20 + i;
      try {
        const repo = fixtureRepo(under);
        await withServer(under, async (port, server) => {
          server.addRepo(repo);
          const a = await get(port, prOf(repo, n), visit.headers);
          expect(a.status).toBe(200);
          expect(a.body, 'the building page').toContain(`var jobKey = ${JSON.stringify(`${repo}#pr-${n}`)}`);
          expect((await prJob(port, repo, n)).state, `${visit.name} must start the PR tour`).not.toBe('idle');
          await settlePr(port, repo, n);
        });
      } finally {
        fs.rmSync(under, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

// ------------------------------------------------------------------- AC4

describe('AC4: the live reload is the page\'s own request', () => {
  it('on a new server it replaces the page\'s own address, never reload()', async () => {
    // Firefox sends a reload with the label of the link that first opened the tab, so a tour opened from another
    // site's link would reload as that site's request, and start no rebuild. location.replace() is the page's own
    // request in both browsers. Without the fragment, so the navigation is a load and not a jump on the page.
    const under = scratch('live');
    try {
      const repo = fixtureRepo(under);
      await withServer(under, async (port, server) => {
        server.addRepo(repo);
        await server.build(repo, () => {});
        const page = (await get(port, tourOf(repo), navigation('same-origin', true))).body;
        const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
        const live = scripts.filter((s) => s.includes('/api/version'));
        expect(live.length, 'one live-reload script in the page').toBe(1);

        const calls: string[] = [];
        const ticks: Array<() => void> = [];
        let bootId = 'the first server';
        // Short, so a failure message shows all of it.
        const address = 'http://h/r?path=x';
        const location = {
          href: `${address}#notes`,
          reload: () => { calls.push('reload()'); },
          replace: (u: string) => { calls.push(`replace(${u})`); },
          assign: (u: string) => { calls.push(`assign(${u})`); },
        };
        const fakeFetch = (): Promise<unknown> => Promise.resolve({ json: () => Promise.resolve({ bootId }) });
        const fakeSetInterval = (fn: () => void): number => { ticks.push(fn); return 0; };
        new Function('fetch', 'location', 'setInterval', live[0]!)(fakeFetch, location, fakeSetInterval);

        await sleep(20);
        expect(calls.join(' | '), 'the first answer only sets the baseline').toBe('');
        expect(ticks.length, 'and it keeps polling').toBe(1);
        ticks[0]!();
        await sleep(20);
        expect(calls.join(' | '), 'the same server: nothing happens').toBe('');
        bootId = 'a new server';
        ticks[0]!();
        await sleep(20);
        expect(calls.join(' | '), 'a new server: the page loads itself again, as its own request').toBe(`replace(${address})`);
      });
    } finally {
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});

// ------------------------------------------------------------------- AC5 (T-46)

describe('AC5: no other site can put a repo-tour page in a frame (T-46)', () => {
  it('every HTML page says so, in both the header browsers read today and the older one', async () => {
    const under = scratch('frames');
    try {
      const built = fixtureRepo(under, 'built');
      const fresh = fixtureRepo(under, 'fresh');
      const stale = await staleOnDisk(path.join(under, 'stale-home'));
      await withServer(under, async (port, server) => {
        for (const r of [built, fresh, stale]) server.addRepo(r);
        await server.build(built, () => {});

        const pages: Array<{ name: string; route: string; status: number; headers?: Record<string, string> }> = [
          { name: 'the home page', route: '/', status: 200 },
          { name: 'a tour', route: tourOf(built), status: 200 },
          { name: 'a stale tour', route: tourOf(stale), status: 200, headers: NOT_THE_READER[0]!.headers },
          { name: 'a repository with no tour yet', route: tourOf(fresh), status: 200 },
          { name: 'a folder that is not loaded', route: tourOf(path.join(under, 'nowhere')), status: 404 },
          { name: 'the pull request list', route: `/prs?path=${encodeURIComponent(built)}`, status: 200 },
          { name: 'a PR tour building', route: prOf(built, 3), status: 200, headers: navigation('same-origin', true) },
          { name: 'a PR tour not built, from another site', route: prOf(built, 4), status: 200, headers: NOT_THE_READER[0]!.headers },
        ];
        for (const p of pages) {
          const a = await get(port, p.route, p.headers);
          expect.soft(a.status, `${p.name}: the route ran`).toBe(p.status);
          expect.soft(a.headers['content-type'], `${p.name} is a page`).toMatch(/^text\/html/);
          expect.soft(a.headers['content-security-policy'], `${p.name}: no other site may frame it`).toBe('frame-ancestors \'none\'');
          expect.soft(a.headers['x-frame-options'], `${p.name}: and the same for an older browser`).toBe('DENY');
        }
        await settlePr(port, built, 3);
        await settlePr(port, built, 4);
      });
    } finally {
      fs.rmSync(under, { recursive: true, force: true });
    }
  }, 60_000);
});
