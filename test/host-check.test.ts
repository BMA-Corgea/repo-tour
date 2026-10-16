/**
 * T-45 — repo-tour answers only requests addressed to itself.
 *
 * Every guard against another site reads `Sec-Fetch-Site`. A page whose own name has been pointed
 * at this machine is same-origin to the browser, so those guards passed it, and it could read every
 * answer. What it cannot change is the name its requests carry in `Host`.
 *
 * These run a real server on port 0 and send requests through a socket, because the check sits
 * where a socket request enters, ahead of the routes (the tests elsewhere that call `handler()`
 * directly never reach it). `fetch` cannot set `Host`, so requests go through `node:http`, and a
 * request with no `Host` at all through a raw socket. Nothing here calls a model: the bodies are
 * chosen so that even the unguarded server stops short of one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RepoTourServer } from '../src/server.js';

/** A name the server does not answer to: what a page re-pointed at this machine sends. */
const ELSEWHERE = 'another.example';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function scratch(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `repo-tour-host-${name}-`));
}

/** A real repository with one documented function: the smallest tree that builds a tour. */
function fixtureRepo(under: string, name = 'repo'): string {
  const repo = path.join(under, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => { execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' }); };
  git('init', '-q');
  git('config', 'user.email', 'fixture@test.local');
  git('config', 'user.name', 'fixture');
  fs.writeFileSync(path.join(repo, 'a.py'), 'def go(x):\n    """Do it."""\n    return x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}

async function settle(server: RepoTourServer, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && server.listRepos().some((r) => r.running)) await sleep(50);
}

interface Answer { status: number; type: string; body: string }

/** One request over its own connection. `host` replaces the `Host` node:http would send. */
function send(port: number, route: string, opts: { host?: string; method?: string; body?: string; site?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: opts.method ?? 'GET', agent: false,
      headers: {
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        ...(opts.site ? { 'sec-fetch-site': opts.site } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'text/plain;charset=UTF-8' } : {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** A request written by hand, for what node:http will not send: no `Host`, or an empty one. */
function raw(port: number, request: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => { data += c; });
    socket.on('end', () => resolve({
      status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0),
      body: data.slice(data.indexOf('\r\n\r\n') + 4),
    }));
    socket.on('error', reject);
    socket.write(request);
  });
}

async function withServer(use: (port: number, server: RepoTourServer, under: string) => Promise<void>): Promise<void> {
  const under = scratch('server');
  const server = new RepoTourServer({ statePath: path.join(under, 'state.json'), interpret: false, port: 0 });
  const { port, close } = await server.listen();
  try { await use(port, server, under); } finally {
    await close();
    await settle(server);
    fs.rmSync(under, { recursive: true, force: true });
  }
}

describe('AC1: a request naming any other host is refused before any route runs', () => {
  it('every route, read or write, as a page at another name would send it', async () => {
    await withServer(async (port, server, under) => {
      // `repo` is the one a build is asked for, and stays loaded so `settle` can see a build that
      // did start; `other` is the one asked to be removed.
      const repo = fixtureRepo(under);
      const other = fixtureRepo(under, 'other');
      const theirs = fixtureRepo(under, 'theirs');
      server.addRepo(repo);
      server.addRepo(other);
      const q = (p: string): string => encodeURIComponent(p);
      const notLoaded = q(path.join(under, 'nowhere'));

      // The PR routes get a path that is not loaded, so the unguarded server answers 404 rather than
      // asking GitHub. /api/ask gets an empty question, so it answers 400 rather than calling a model.
      const routes: Array<{ method: string; route: string; body?: string }> = [
        { method: 'GET', route: '/' },
        { method: 'GET', route: '/img/hero.jpg' },
        { method: 'GET', route: '/api/version' },
        { method: 'GET', route: '/api/llm' },
        { method: 'GET', route: '/api/repos' },
        { method: 'GET', route: `/api/job?path=${q(repo)}` },
        { method: 'GET', route: `/r?path=${q(repo)}` },
        { method: 'GET', route: `/api/prs?path=${notLoaded}` },
        { method: 'GET', route: `/prs?path=${notLoaded}` },
        { method: 'GET', route: `/pr?path=${notLoaded}&n=1` },
        { method: 'GET', route: '/no-such-page' },
        { method: 'POST', route: '/api/llm-set', body: JSON.stringify({ provider: 'codex' }) },
        { method: 'POST', route: '/api/ask', body: '{}' },
        { method: 'POST', route: '/api/add', body: JSON.stringify({ path: theirs }) },
        { method: 'POST', route: '/api/build', body: JSON.stringify({ path: repo }) },
        { method: 'POST', route: '/api/rebuild', body: JSON.stringify({ path: repo }) },
        { method: 'POST', route: '/api/remove', body: JSON.stringify({ path: other }) },
      ];
      for (const { method, route, body } of routes) {
        const got = await send(port, route, { host: `${ELSEWHERE}:${port}`, site: 'same-origin', method, ...(body !== undefined ? { body } : {}) });
        expect.soft(got.status, `${method} ${route} sent to another name must be refused`).toBe(403);
        if (got.status !== 403) continue;   // what a route answered instead is not a refusal to inspect
        expect.soft(got.type, `${method} ${route}: the refusal is plain text`).toMatch(/^text\/plain/);
        expect.soft(got.body, `${method} ${route}: the refusal names the server's own address`).toContain(`http://127.0.0.1:${port}/`);
        expect.soft(got.body, `${method} ${route}: the refusal does not repeat the name it was sent to`).not.toContain(ELSEWHERE);
      }

      await settle(server);
      expect.soft(server.listRepos().map((r) => r.path), 'the list is as it was: nothing loaded, nothing removed').toEqual([repo, other]);
      expect.soft(fs.existsSync(path.join(under, 'llm.json')), 'the model choice was never written').toBe(false);
      expect.soft(fs.existsSync(path.join(repo, '.repo-tour')), 'nothing was built in the loaded repository').toBe(false);
    });
  }, 60_000);

  it('every other spelling of the address is refused too', async () => {
    await withServer(async (port) => {
      const wrong = [
        `127.0.0.1:${port + 1}`,
        `localhost:${port + 1}`,
        '127.0.0.1',
        'localhost',
        `0.0.0.0:${port}`,
        `app.localhost:${port}`,
        `localhost.:${port}`,
        `127.0.0.1.:${port}`,
        `127.1:${port}`,
        `${ELSEWHERE}`,
      ];
      for (const host of wrong) {
        expect.soft((await send(port, '/api/repos', { host })).status, `Host: ${host} is not this server`).toBe(403);
      }
      const empty = await raw(port, 'GET /api/repos HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n');
      expect.soft(empty.status, 'an empty Host names nothing, so it is refused').toBe(403);
    });
  }, 60_000);
});

describe('AC2: requests addressed to the server pass as before', () => {
  it('each of its own names, with the port it is on', async () => {
    await withServer(async (port, server, under) => {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
        const got = await send(port, '/api/version', { host });
        expect.soft(got.status, `Host: ${host} is this server`).toBe(200);
        expect.soft(got.status === 200 ? (JSON.parse(got.body) as { bootId?: string }).bootId : null, `Host: ${host} gets the boot id`).toBe(server.bootId);
      }
      const ours = path.join(under, 'ours');
      fs.mkdirSync(ours);
      const added = await send(port, '/api/add', { host: `localhost:${port}`, site: 'same-origin', method: 'POST', body: JSON.stringify({ path: ours }) });
      expect(added.status, 'repo-tour\'s own page, opened at localhost, still loads a folder').toBe(200);
      expect(server.listRepos().some((r) => r.path === ours)).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/api/version`)).status, 'a plain fetch, which sends the address it dialled').toBe(200);
    });
  }, 60_000);

  it('a request with no Host keeps today\'s behaviour', async () => {
    await withServer(async (port, server) => {
      const old = await raw(port, 'GET /api/version HTTP/1.0\r\n\r\n');
      expect(old.status, 'HTTP/1.0 may leave Host out, and is routed as before').toBe(200);
      expect((JSON.parse(old.body) as { bootId?: string }).bootId).toBe(server.bootId);
      const bare = await raw(port, 'GET /api/version HTTP/1.1\r\nConnection: close\r\n\r\n');
      expect(bare.status, 'HTTP/1.1 without Host gets Node\'s own 400, as before').toBe(400);
    });
  }, 60_000);
});
