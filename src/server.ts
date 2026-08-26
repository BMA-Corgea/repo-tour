/**
 * The app.
 *
 * A generated HTML file is a snapshot: refreshing it can never show new code, because it
 * never looks at the repository again. That is the wrong shape for something you keep
 * open while you work.
 *
 * So repo-tour runs as a small local server instead. Repositories are LOADED IN and stay
 * loaded; a tour is a thing you select rather than a file you have to find; and a refresh
 * re-reads the repository, so the page you are looking at is the code as it is now.
 *
 * What makes the refresh affordable is everything built underneath it. The tree is
 * fingerprinted first — HEAD plus the working-tree status — and if nothing moved, the
 * rendered page is served straight from memory. When something did move, the digest reuses
 * every unchanged file by content hash and every already-explained stop from the
 * interpretation cache, so a refresh after one edit re-does one file's worth of work.
 *
 * No framework and no dependencies: node:http, and the same renderer the static export uses.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digest, CACHE_DIR } from './digest.js';
import { buildCodeTour, buildArchitectureSteps } from './codetour.js';
import { buildArchitecture, architectureBrief } from './architecture.js';
import { interpretStops, applyMeanings, interpretArchitecture, DEFAULT_MODEL } from './interpret.js';
import { renderRepoView } from './repoview.js';
import { baseCss, alternateCss, skinPicker, skinScript } from './skins.js';

export interface LoadedRepo {
  path: string;
  name: string;
  addedAt: string;
}

interface Rendered {
  fingerprint: string;
  html: string;
  builtAt: string;
  stops: number;
  files: string[];
  head: string | null;
}

/** Everything about a build except the page itself, so a listing need not read the HTML. */
type RenderedMeta = Omit<Rendered, 'html'>;

/**
 * Where a built page lives between restarts.
 *
 * Keeping it only in memory meant every restart showed "not built yet" for every
 * repository — and once the server started restarting on its own source changes, that was
 * constantly. The digest and the interpretations survived on disk, so a rebuild was cheap,
 * but "not built yet" reads as "your work is gone", and clicking through meant waiting
 * again for something already finished.
 *
 * Keyed by FINGERPRINT, so a page is only reused for the exact tree state it describes.
 */
function renderedDir(repoPath: string): string {
  return path.join(repoPath, CACHE_DIR, 'rendered');
}

/**
 * Has this repository ever been built, at any tree state?
 *
 * The distinction matters: a repo that has never been built should wait for someone to ask,
 * while one that HAS been built and has since moved should rebuild on a refresh — that is
 * the whole point of the app over a static file. Same route, two different answers.
 */
function hasAnyBuild(repoPath: string): boolean {
  try {
    return fs.readdirSync(renderedDir(repoPath)).some((f) => f.endsWith('.json'));
  } catch { return false; }
}

/**
 * A build in flight, recorded on disk.
 *
 * The server restarts — on a code change, on a crash, on Ctrl-C — and an in-process build
 * dies with it, leaving the card back at "no tour yet" as though nothing had happened. That
 * is the worst possible presentation of it: minutes of work vanish and the only signal is a
 * label that says you never started.
 *
 * The marker makes the attempt durable, so the next boot picks it up. Resuming is cheap
 * because every finished stop is already cached by content hash — a resumed build re-does
 * only what the killed one had not reached.
 */
function markerPath(repoPath: string): string {
  return path.join(repoPath, CACHE_DIR, 'building.json');
}

function markBuilding(repoPath: string, lines: string[]): void {
  try {
    fs.mkdirSync(path.dirname(markerPath(repoPath)), { recursive: true });
    fs.writeFileSync(markerPath(repoPath), JSON.stringify({ startedAt: new Date().toISOString(), lines }, null, 2));
  } catch { /* a build that cannot record itself still runs */ }
}

function clearBuilding(repoPath: string): void {
  try { fs.rmSync(markerPath(repoPath), { force: true }); } catch { /* nothing to clear */ }
}

/** A marker older than this is from a run nobody is waiting for any more. */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

function wasBuilding(repoPath: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(repoPath), 'utf8')) as { startedAt: string };
    return Date.now() - Date.parse(m.startedAt) < RESUME_WINDOW_MS;
  } catch { return false; }
}

/**
 * The most recent build of a repository, whatever tree state it describes.
 *
 * This is what makes a tour survive the code moving underneath it. A tour pinned to an older
 * commit is still the truth about that commit — it does not stop being readable because a
 * file changed — and taking it away the moment anything is edited turns every edit into a
 * multi-minute wait before you can read anything at all.
 */
function newestRendered(repoPath: string): Rendered | null {
  const dir = renderedDir(repoPath);
  let best: { at: string; fp: string } | null = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as RenderedMeta;
      if (!best || meta.builtAt > best.at) best = { at: meta.builtAt, fp: meta.fingerprint };
    }
  } catch { return null; }
  return best ? readRendered(repoPath, best.fp) : null;
}

function readRendered(repoPath: string, fp: string): Rendered | null {
  const dir = renderedDir(repoPath);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${fp}.json`), 'utf8')) as RenderedMeta;
    const html = fs.readFileSync(path.join(dir, `${fp}.html`), 'utf8');
    return { ...meta, html };
  } catch {
    return null;
  }
}

/** Keep the last few builds of a repo; older ones describe trees nobody is looking at. */
function writeRendered(repoPath: string, r: Rendered, keep = 4): void {
  const dir = renderedDir(repoPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const { html, ...meta } = r;
    fs.writeFileSync(path.join(dir, `${r.fingerprint}.html`), html);
    fs.writeFileSync(path.join(dir, `${r.fingerprint}.json`), JSON.stringify(meta, null, 2));

    const metas = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const dated = metas
      .map((f) => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as RenderedMeta;
          return { f, at: m.builtAt };
        } catch { return { f, at: '' }; }
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    for (const stale of dated.slice(keep)) {
      const base = stale.f.replace(/\.json$/, '');
      fs.rmSync(path.join(dir, `${base}.json`), { force: true });
      fs.rmSync(path.join(dir, `${base}.html`), { force: true });
    }
  } catch { /* an unwritable cache costs a rebuild, never correctness */ }
}

interface Job {
  repo: string;
  state: 'running' | 'done' | 'failed';
  lines: string[];
  startedAt: number;
}

function assetsImgDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'img');
}

/** The photographer, for the credit line. Absent images are a designed state, not a gap. */
function heroCredit(): { photographer: string; url: string } | null {
  try {
    const credits = JSON.parse(fs.readFileSync(path.join(assetsImgDir(), 'credits.json'), 'utf8')) as
      Array<{ slug: string; photographer: string; pageUrl: string }>;
    const hero = credits.find((c) => c.slug === 'hero');
    return hero ? { photographer: hero.photographer, url: hero.pageUrl } : null;
  } catch { return null; }
}

function hasHero(): boolean {
  return fs.existsSync(path.join(assetsImgDir(), 'hero.jpg'));
}

function git(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch { return null; }
}

/**
 * What the repository looks like right now, cheaply.
 *
 * HEAD alone is not enough — an uncommitted edit leaves HEAD untouched, and serving a
 * cached page then would be exactly the staleness this whole server exists to remove.
 * `git status --porcelain` catches the working tree; a tree with no git at all falls back
 * to the newest mtime it can see.
 */
export function fingerprint(repoPath: string): string {
  const head = git(repoPath, ['rev-parse', 'HEAD']) ?? '';
  const status = git(repoPath, ['status', '--porcelain']) ?? null;
  if (status !== null) {
    // The digest writes its cache INTO the repo, so `git status` reports it and the
    // fingerprint would change on every single build — leaving the page permanently
    // "stale" and rebuilding forever. The cache is our own output; it is not a change to
    // the repository. (The digest itself learned the same lesson: `.repo-tour` is in
    // NEVER_DESCEND for exactly this reason.)
    const real = status
      .split('\n')
      .filter((l) => l.trim() && !l.includes(`${CACHE_DIR}/`) && !l.trimEnd().endsWith(CACHE_DIR))
      .join('\n');
    return createHash('sha256').update(`${head}\n${real}`).digest('hex').slice(0, 24);
  }

  let newest = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === CACHE_DIR) continue;
      const abs = path.join(dir, e.name);
      try {
        const st = fs.statSync(abs);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (e.isDirectory()) walk(abs, depth + 1);
      } catch { /* unreadable is not fatal */ }
    }
  };
  walk(repoPath, 0);
  return createHash('sha256').update(String(newest)).digest('hex').slice(0, 24);
}

export interface ServerOptions {
  /**
   * Default 7788, recorded in ../PROJECT_PORTS.md.
   *
   * NOT 7777, which was the obvious pick and is a trap: GUTS's
   * `.claude/skills/gons-pr-integration/reference/integrate.sh` health-checks guts-bridge on
   * 7777 (the bridge itself binds 7681 — that default is simply wrong). With nothing
   * listening there the check failed, which was at least honest. A server answering 200 on
   * that port would report the Bridge healthy while it is down, and a false green is worse
   * than a red.
   */
  port?: number;
  model?: string;
  interpret?: boolean;
  statePath?: string;
}

export class RepoTourServer {
  /**
   * Identifies THIS run of the server.
   *
   * A page served by one boot polls for this; when it changes, the code behind the page has
   * changed and the page reloads itself. It is derived from the process start time because
   * anything persisted would survive the restart it exists to detect.
   */
  readonly bootId = `${process.pid}-${Math.floor(process.uptime() * 1000)}-${Date.now().toString(36)}`;
  private repos: LoadedRepo[] = [];
  private cache = new Map<string, Rendered>();
  private jobs = new Map<string, Job>();
  private readonly statePath: string;
  private readonly model: string;
  private readonly interpret: boolean;

  constructor(private opts: ServerOptions = {}) {
    this.statePath = opts.statePath
      ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'loaded.json');
    this.model = opts.model ?? DEFAULT_MODEL;
    this.interpret = opts.interpret !== false;
    this.load();
    this.resumeInterrupted();
  }

  /**
   * Pick up builds that a previous run was in the middle of.
   *
   * Deliberately automatic: someone asked for this build, the process died under them, and
   * making them ask again — with no way to know they had to — is how minutes of work get
   * lost silently. A marker whose repo is already built at its current state is stale and is
   * simply cleared.
   */
  private resumeInterrupted(): void {
    for (const r of this.repos) {
      if (!wasBuilding(r.path)) { clearBuilding(r.path); continue; }
      if (this.lookup(r.path, fingerprint(r.path))) { clearBuilding(r.path); continue; }
      const job = this.startJob(r.path);
      job.lines.unshift('resuming a build the last run did not finish…');
    }
  }

  private load(): void {
    try {
      this.repos = (JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as LoadedRepo[])
        .filter((r) => fs.existsSync(r.path));
    } catch { this.repos = []; }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.repos, null, 2));
    } catch { /* an unwritable state file loses the list on restart, nothing worse */ }
  }

  addRepo(input: string): { ok: true; repo: LoadedRepo } | { ok: false; error: string } {
    const abs = path.resolve(input.replace(/^~(?=\/|$)/, process.env['HOME'] ?? '~').trim());
    if (!fs.existsSync(abs)) return { ok: false, error: `no such directory: ${abs}` };
    if (!fs.statSync(abs).isDirectory()) return { ok: false, error: `not a directory: ${abs}` };

    const existing = this.repos.find((r) => r.path === abs);
    if (existing) return { ok: true, repo: existing };

    const repo: LoadedRepo = { path: abs, name: path.basename(abs) || abs, addedAt: new Date().toISOString() };
    this.repos.push(repo);
    this.persist();
    return { ok: true, repo };
  }

  removeRepo(abs: string): void {
    this.repos = this.repos.filter((r) => r.path !== abs);
    this.cache.delete(abs);
    this.persist();
  }

  /** A build for this repo at this exact tree state, from memory or from disk. */
  private lookup(repoPath: string, fp: string): Rendered | null {
    const hot = this.cache.get(repoPath);
    if (hot && hot.fingerprint === fp) return hot;
    const cold = readRendered(repoPath, fp);
    if (cold) this.cache.set(repoPath, cold);
    return cold;
  }

  listRepos(): Array<LoadedRepo & {
    built: RenderedMeta | null; current: boolean; running: boolean; resumed: boolean;
  }> {
    return this.repos.map((r) => {
      const fp = fingerprint(r.path);
      // Fall back to the newest build of ANY tree state: a repo whose code has moved still
      // HAS a tour, and reporting "no tour yet" would both be false and hide a readable one.
      const built = this.lookup(r.path, fp) ?? newestRendered(r.path) ?? null;
      const meta = built ? (({ html, ...rest }) => rest)(built) : null;
      return {
        ...r,
        built: meta,
        current: meta !== null && meta.fingerprint === fp,
        running: this.jobs.get(r.path)?.state === 'running',
        resumed: (this.jobs.get(r.path)?.lines[0] ?? '').startsWith('resuming'),
      };
    });
  }

  /** Build (or rebuild) a repository's tour. Returns the rendered page. */
  async build(repoPath: string, onLine: (s: string) => void): Promise<Rendered> {
    const fp = fingerprint(repoPath);
    const already = this.lookup(repoPath, fp);
    if (already) return already;

    onLine('reading the tree…');
    const result = await digest(repoPath, { write: true });

    const plan = buildCodeTour(result);
    const arch = buildArchitecture(result);
    const name = path.basename(repoPath) || repoPath;
    const io = { model: this.model, cachedOnly: !this.interpret, onProgress: onLine };

    const archSteps = arch.subsystems.length > 1
      ? buildArchitectureSteps(arch, name, result.inventory.files.length)
      : [];

    if (archSteps.length) {
      const { meaning } = await interpretArchitecture(
        repoPath, architectureBrief(arch, name, result.inventory.files.length), io,
      );
      if (meaning) {
        arch.overview = meaning.overview;
        for (const sub of arch.subsystems) sub.purpose = meaning.purposes[sub.path] ?? null;
        for (const step of archSteps) {
          const part = step.architecture?.part ?? null;
          const text = part === null ? meaning.overview : meaning.purposes[part];
          if (text) {
            (step as { text: string; interpreted?: boolean }).text = `${text}\n\n${step.text}`;
            (step as { interpreted?: boolean }).interpreted = true;
          }
        }
      }
    }

    const interp = await interpretStops(
      repoPath, plan.steps, result.inventory.files, result.extracts, result.graph.edges, io,
    );
    const steps = [...archSteps, ...applyMeanings(plan.steps, result.inventory.files, interp.meanings)];

    onLine('rendering…');
    const html = renderRepoView(result, {
      steps, itinerary: plan.itinerary, architecture: arch.subsystems.length > 1 ? arch : undefined,
      servedBy: { homeUrl: '/', repoPath, builtAt: new Date().toISOString() },
    });

    const rendered: Rendered = {
      fingerprint: fp,
      html,
      builtAt: new Date().toISOString(),
      stops: steps.length,
      files: plan.itinerary,
      head: result.manifest.repos.find((r) => r.root === '')?.head ?? null,
    };
    this.cache.set(repoPath, rendered);
    writeRendered(repoPath, rendered);
    return rendered;
  }

  private startJob(repoPath: string): Job {
    const running = this.jobs.get(repoPath);
    if (running?.state === 'running') return running;

    const job: Job = { repo: repoPath, state: 'running', lines: [], startedAt: Date.now() };
    this.jobs.set(repoPath, job);
    markBuilding(repoPath, job.lines);

    void this.build(repoPath, (line) => {
      job.lines.push(line);
      // Kept current on disk so a resumed build can say where the last one got to.
      markBuilding(repoPath, job.lines);
    })
      .then(() => { job.state = 'done'; job.lines.push('ready'); clearBuilding(repoPath); })
      .catch((e: unknown) => {
        job.state = 'failed';
        job.lines.push(e instanceof Error ? e.message : String(e));
        clearBuilding(repoPath);
      });

    return job;
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }

  private html(res: http.ServerResponse, code: number, body: string): void {
    res.writeHead(code, {
      'content-type': 'text/html; charset=utf-8',
      // The whole point is that a refresh re-reads the repo, so never let a proxy or the
      // browser hand back a stale copy of a page that is meant to be live.
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(body);
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname;

    try {
      if (route === '/') return this.html(res, 200, renderHome());

      // Images only, by exact name. A server that hands out arbitrary paths from disk while
      // sitting in front of someone's private repositories is not a convenience worth having.
      if (route.startsWith('/img/')) {
        const name = route.slice('/img/'.length);
        if (!/^[a-z0-9-]+\.jpg$/.test(name)) { res.writeHead(404).end(); return; }
        const file = path.join(assetsImgDir(), name);
        try {
          const bytes = fs.readFileSync(file);
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'content-length': bytes.length,
            'cache-control': 'public, max-age=86400',
          });
          res.end(bytes);
        } catch { res.writeHead(404).end(); }
        return;
      }

      if (route === '/api/version') return this.json(res, 200, { bootId: this.bootId });

      if (route === '/api/repos') return this.json(res, 200, { repos: this.listRepos() });

      if (route === '/api/add' && req.method === 'POST') {
        const { path: p } = JSON.parse(await this.readBody(req)) as { path?: string };
        if (!p) return this.json(res, 400, { error: 'a path is required' });
        const added = this.addRepo(p);
        if (!added.ok) return this.json(res, 400, { error: added.error });
        // Deliberately does NOT start a build. Loading a repository and committing minutes
        // of work to it are two different decisions, and only one of them was made here.
        return this.json(res, 200, { repo: added.repo });
      }

      if (route === '/api/remove' && req.method === 'POST') {
        const { path: p } = JSON.parse(await this.readBody(req)) as { path?: string };
        if (p) this.removeRepo(p);
        return this.json(res, 200, { ok: true });
      }

      if ((route === '/api/build' || route === '/api/rebuild') && req.method === 'POST') {
        const { path: p } = JSON.parse(await this.readBody(req)) as { path?: string };
        if (!p) return this.json(res, 400, { error: 'a path is required' });
        this.cache.delete(p);
        this.startJob(p);
        return this.json(res, 200, { ok: true });
      }

      if (route === '/api/job') {
        const p = url.searchParams.get('path') ?? '';
        const job = this.jobs.get(p);
        return this.json(res, 200, job
          ? { state: job.state, lines: job.lines.slice(-6) }
          : { state: 'idle', lines: [] });
      }

      // The live tour. Refreshing this re-checks the repository and rebuilds if it moved.
      if (route === '/r') {
        const p = url.searchParams.get('path') ?? '';
        if (!this.repos.some((r) => r.path === p)) return this.html(res, 404, notFound(p));
        const job = this.jobs.get(p);
        const fp = fingerprint(p);
        const cached = this.lookup(p, fp);

        if (cached) return this.html(res, 200, cached.html);

        // The tree has moved since the last build. Serve that build anyway — it is still the
        // truth about the commit it describes, and making it unreachable turns every edit
        // into a wait before anything can be read. The page carries a quiet marker instead.
        const older = newestRendered(p);
        if (older) return this.html(res, 200, older.html);

        if (job?.state === 'running') return this.html(res, 200, building(p, job.lines));
        return this.html(res, 200, notBuilt(p));
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      this.json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  listen(): Promise<{ port: number; close: () => void }> {
    const port = this.opts.port ?? 7788;
    const server = http.createServer((req, res) => { void this.handler(req, res); });
    return new Promise((resolve, reject) => {
      server.on('error', reject);
      // Loopback only. This serves the contents of your repositories; it has no business
      // listening on anything reachable from outside this machine.
      server.listen(port, '127.0.0.1', () => {
        resolve({ port, close: () => server.close() });
      });
    });
  }
}

// ---------------------------------------------------------------- pages

/**
 * The app's pages ride the SAME skin files as a generated tour — one contract, not two.
 * base.css carries the tokens and the control layer; the rules below are only the shapes
 * these three pages need on top of it.
 */
const SHELL_STYLE = `
${baseCss()}
${alternateCss()}
:root{--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root:not([data-theme]){--ok:#3fb950}}
:root[data-theme="dark"]{--ok:#3fb950}
:root[data-theme="gunmetal"]{--ok:#5fd39a}
:root[data-theme="titanium"]{--ok:#1f6b45}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Noto Sans,Helvetica,Arial,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:44px 20px 80px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin-bottom:26px}
.addbar{display:flex;gap:8px;margin-bottom:26px;flex-wrap:wrap}
input[type=text]{flex:1;min-width:280px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:10px}
.card .top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.card .nm{font-size:15px;font-weight:600}
.card .pth{color:var(--muted);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.tag.ok{border-color:transparent;background:var(--chip);color:var(--ok)}
.tag.stale{border-color:transparent;background:var(--chip);color:var(--warn)}
.row{display:flex;gap:8px;margin-top:11px;align-items:center;flex-wrap:wrap}
.row .spacer{flex:1}
.log{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);margin-top:9px;white-space:pre-wrap}
.err{color:#cf222e;font-size:13px;margin-bottom:14px}
.empty{color:var(--muted)}
code{background:var(--chip);padding:1px 6px;border-radius:4px;font-size:12px}
footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.7}
a{color:var(--accent)}
.nav{
  position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;
  padding:10px 20px;background:var(--bg);border-bottom:1px solid var(--line)
}
.navhome{font-weight:600;text-decoration:none;font-size:14px}
.nav .btn{text-decoration:none}
.buildwrap{max-width:760px;margin:0 auto;padding:40px 20px}
.elapsed{color:var(--muted);font-size:12px;margin-top:8px}
.spin{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--accent);margin-right:8px;animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}

/* ── the hero ──────────────────────────────────────────────────────────────────────────────
   The photograph is a library in levels with a staircase through it, which is the product's
   own idea: enter at the top, descend to one shelf. It sits UNDER a scrim built from the
   page's own ground colour, so the band reads as part of the page in every skin rather than
   as a picture pasted onto it — and the type stays legible on light skins and dark alike.
   With no image the same band renders as a token gradient: a designed state, not a gap. */
.hero{position:relative;overflow:hidden;border-bottom:1px solid var(--line);background:var(--bg)}
.hero::before{
  content:'';position:absolute;inset:0;
  background:linear-gradient(115deg,var(--accent-soft),transparent 60%),var(--chip);
}
.hero.hasimg::before{
  background-image:url('/img/hero.jpg');
  background-size:cover;background-position:center 38%;
  filter:saturate(.72);
}
/* the scrim: opaque where the words are, clearing toward the far edge */
.hero::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(100deg,var(--bg) 0%,var(--bg) 34%,color-mix(in srgb,var(--bg) 82%,transparent) 52%,color-mix(in srgb,var(--bg) 42%,transparent) 78%,color-mix(in srgb,var(--bg) 20%,transparent) 100%);
}
.hero-inner{position:relative;z-index:1;max-width:1040px;margin:0 auto;padding:64px 20px 56px}
.kicker{
  margin:0 0 12px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--accent);font-weight:700
}
.hero h1{
  margin:0 0 14px;font-size:clamp(26px,3.4vw,40px);line-height:1.16;
  letter-spacing:-.022em;font-weight:700;max-width:19ch
}
.lede{margin:0 0 26px;max-width:56ch;color:var(--muted);font-size:15px;line-height:1.65}
.addbar{display:flex;gap:8px;flex-wrap:wrap;max-width:640px}
.addbar input[type=text]{flex:1;min-width:260px;font-size:14px;padding:10px 13px}
.addbar .btn{padding:10px 18px;font-size:14px}
.credit{
  position:absolute;right:10px;bottom:9px;z-index:1;font-size:10px;
  color:var(--ink);text-decoration:none;
  padding:3px 8px;border-radius:999px;
  /* Attribution is an obligation, so it has to be READABLE — over a photograph that is
     bright in one skin and dark in another, only its own backdrop can guarantee that. */
  background:color-mix(in srgb,var(--bg) 78%,transparent);
  border:1px solid color-mix(in srgb,var(--line) 60%,transparent);
  opacity:.8
}
.credit:hover{opacity:1;border-color:var(--accent)}
@media (max-width:700px){ .hero::after{background:linear-gradient(180deg,color-mix(in srgb,var(--bg) 72%,transparent),var(--bg) 70%)} .hero-inner{padding:40px 20px 36px} }

/* ── the list ──────────────────────────────────────────────────────────────────────────── */
.wrap{max-width:1040px;margin:0 auto;padding:34px 20px 80px}
.secthead{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.secthead h2{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600}

.card{
  background:var(--bg);border:1px solid var(--line);border-radius:10px;
  padding:16px 18px;margin-bottom:12px;transition:border-color .14s ease,transform .1s ease
}
.card:hover{border-color:var(--btn-edge-hover);transform:translateY(-1px)}
.cardtop{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.ident{flex:1;min-width:0}
.card h3{margin:0 0 3px;font-size:17px;font-weight:600;letter-spacing:-.01em}
.pth{
  color:var(--muted);font-size:12px;word-break:break-all;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace
}
.status{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--muted)}
.dot.ok{background:var(--ok)} .dot.warn{background:var(--warn)}
.dot.work{background:var(--accent);animation:pulse 1.2s ease-in-out infinite}
.dot.idle{background:transparent;border:1px solid var(--muted)}
.meta{display:flex;gap:14px;flex-wrap:wrap;margin:11px 0 0;color:var(--muted);font-size:12px}
.meta span{position:relative}
.meta span+span::before{content:'·';position:absolute;left:-9px;opacity:.6}
.actions{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.actions .spacer{flex:1}
.actions .btn{text-decoration:none}
.btn.ghost{background:transparent;border-color:transparent;color:var(--muted)}
.btn.ghost:hover{background:var(--btn-bg);border-color:var(--btn-edge);color:var(--ink)}
.log{
  font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);
  margin:10px 0 0;white-space:pre-wrap
}
.log:empty{display:none}

.empty-card{
  border:1px dashed var(--line);border-radius:10px;padding:26px 22px;background:var(--bg)
}
.empty-card h3{margin:0 0 8px;font-size:16px}
.empty-card p{margin:0 0 8px;color:var(--muted);font-size:13px;line-height:1.65;max-width:62ch}
.err{color:#cf222e;font-size:13px;margin:10px 0 0;min-height:1em}
.empty{color:var(--muted)}
code{background:var(--chip);padding:1px 6px;border-radius:4px;font-size:12px}
footer{margin-top:42px;padding-top:22px;border-top:1px solid var(--line)}
.notegrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}
.notegrid div{color:var(--muted);font-size:12.5px;line-height:1.7}
.notegrid b{color:var(--ink);font-weight:600}
.said{color:var(--muted);font-size:12px}
a{color:var(--accent)}
`;

/**
 * The same bar on every page the server renders.
 *
 * A build can take minutes. Leaving the progress page has to be a visible, obvious action
 * at the TOP of the screen — not a link in a footer below the fold — because the whole
 * point is that you are not trapped waiting for it.
 */
function navBar(here: 'home' | 'building'): string {
  return `<div class="nav">
  <a class="navhome" href="/">repo-tour</a>
  ${here === 'building' ? '<a class="btn" href="/">\u2190 All repositories</a>' : ''}
  <span style="flex:1"></span>
  ${skinPicker()}
</div>`;
}

function renderHome(): string {
  const credit = heroCredit();
  const hero = hasHero();

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>repo-tour</title><style>${SHELL_STYLE}</style>
<script>${skinScript()}</script></head>
<body>${navBar('home')}

<header class="hero${hero ? ' hasimg' : ''}">
  <div class="hero-inner">
    <p class="kicker">Read an unfamiliar codebase</p>
    <h1>Be walked through a repository<br>instead of opening it cold.</h1>
    <p class="lede">
      repo-tour reads the whole tree, works out which few files actually carry it, and builds a
      guided tour — the system first, then the code, with the reasoning written by reading the
      lines it points at.
    </p>

    <form class="addbar" id="addform" onsubmit="return false">
      <input type="text" id="p" placeholder="/path/to/a/repository" spellcheck="false" autocomplete="off">
      <button class="btn primary" id="add" type="submit">Load repository</button>
    </form>
    <p class="err" id="err"></p>
  </div>
  ${credit ? `<a class="credit" href="${credit.url}" target="_blank" rel="noreferrer">Photo — ${credit.photographer.replace(/</g, '&lt;')}</a>` : ''}
</header>

<main class="wrap">
  <div class="secthead">
    <h2>Your repositories</h2>
    <span class="said" id="count"></span>
  </div>
  <div id="list"><p class="empty">Loading…</p></div>

  <footer>
    <div class="notegrid">
      <div><b>Loading is not building.</b> A repository you add sits there until you ask for a
        tour. The first build reads the tree and writes an explanation for every stop — minutes,
        not seconds.</div>
      <div><b>Then it stays cheap.</b> Every file and every explanation is cached by content, so
        a rebuild after an edit costs one file's worth of work.</div>
      <div><b>Refresh means refresh.</b> Open a tour and reload it whenever — the server re-reads
        the repository, so what you are looking at is the code as it is now.</div>
    </div>
  </footer>
</main>

<script>
var timers = {};
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function ago(iso) {
  if (!iso) return '';
  var m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  var h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  var d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

function card(r) {
  var dot, state;
  if (r.running)      { dot = 'work'; state = r.resumed ? 'resuming the build' : 'building'; }
  else if (!r.built)  { dot = 'idle'; state = 'no tour yet'; }
  else if (r.current) { dot = 'ok';   state = 'up to date'; }
  else                { dot = 'warn'; state = 'repo has changed'; }

  var meta = r.built
    ? '<span>' + r.built.stops + ' stops</span><span>' + r.built.files.length + ' files</span><span>built ' + esc(ago(r.built.builtAt)) + '</span>'
    : '<span>nothing built yet</span>';

  var actions = r.built
    ? '<a class="btn primary" href="/r?path=' + encodeURIComponent(r.path) + '">Open tour</a>' +
      '<button class="btn" data-act="rebuild">' + (r.current ? 'Rebuild' : 'Rebuild for the new code') + '</button>'
    : r.running
      ? '<a class="btn primary" href="/r?path=' + encodeURIComponent(r.path) + '">Watch it build</a>'
      : '<button class="btn primary" data-act="build">Build the tour</button>';

  return '<article class="card" data-p="' + esc(r.path) + '">' +
    '<div class="cardtop">' +
      '<div class="ident">' +
        '<h3>' + esc(r.name) + '</h3>' +
        '<div class="pth">' + esc(r.path) + '</div>' +
      '</div>' +
      '<div class="status"><i class="dot ' + dot + '"></i>' + state + '</div>' +
    '</div>' +
    '<div class="meta">' + meta + '</div>' +
    '<div class="actions">' + actions +
      '<span class="spacer"></span>' +
      '<button class="btn ghost" data-act="remove" title="Remove from this list">Remove</button>' +
    '</div>' +
    '<pre class="log" data-log></pre>' +
  '</article>';
}

function poll(p, el) {
  clearInterval(timers[p]);
  timers[p] = setInterval(function () {
    fetch('/api/job?path=' + encodeURIComponent(p)).then(function (r) { return r.json(); }).then(function (j) {
      el.textContent = (j.lines || []).join('\\n');
      if (j.state !== 'running') { clearInterval(timers[p]); refresh(); }
    });
  }, 900);
}

function refresh() {
  fetch('/api/repos').then(function (r) { return r.json(); }).then(function (d) {
    var list = document.getElementById('list');
    document.getElementById('count').textContent =
      d.repos.length ? d.repos.length + (d.repos.length === 1 ? ' loaded' : ' loaded') : '';
    if (!d.repos.length) {
      list.innerHTML =
        '<div class="empty-card">' +
          '<h3>Nothing loaded yet</h3>' +
          '<p>Paste the path to a repository above — anything with source in it. It does not have to ' +
          'be a git repository, though churn is one of the signals used to work out what matters, so ' +
          'one with history gets a better tour.</p>' +
          '<p class="said">Nothing is built until you ask for it.</p>' +
        '</div>';
      return;
    }
    list.innerHTML = d.repos.map(card).join('');
    d.repos.forEach(function (r) {
      if (r.running) poll(r.path, list.querySelector('[data-p="' + CSS.escape(r.path) + '"] [data-log]'));
    });
  });
}

function add() {
  var p = document.getElementById('p').value.trim();
  if (!p) return;
  document.getElementById('err').textContent = '';
  fetch('/api/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { document.getElementById('err').textContent = d.error; return; }
      document.getElementById('p').value = '';
      refresh();
    });
}
document.getElementById('add').addEventListener('click', add);
document.getElementById('addform').addEventListener('submit', add);

document.getElementById('list').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-act]');
  if (!btn) return;
  var p = btn.closest('.card').getAttribute('data-p');
  var act = btn.getAttribute('data-act');
  if (act !== 'remove') { btn.disabled = true; btn.textContent = 'Starting…'; }
  fetch('/api/' + (act === 'remove' ? 'remove' : act === 'build' ? 'build' : 'rebuild'),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
    .then(refresh);
});

refresh();
setInterval(refresh, 4000);
</script>
</body></html>`;
}

function building(repoPath: string, lines: string[]): string {
  const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>building ${esc(path.basename(repoPath))} — repo-tour</title><style>${SHELL_STYLE}</style><script>${skinScript()}</script></head>
<body>${navBar('building')}<div class="buildwrap">
<h1><span class="spin"></span>Reading ${esc(path.basename(repoPath))}</h1>
<div class="sub">
  This is not fast, and is not meant to be. <b>You can leave this page</b> — the build keeps
  running on the server, and it will be waiting whenever you come back. Closing the tab is
  fine too.
</div>
<div class="log" id="log">${lines.map(esc).join('\n')}</div>
<div class="elapsed" id="elapsed"></div>
<footer>
  <a href="/">← All repositories</a> — the list there shows progress for every repo that is building.
</footer>
</div>
<script>
// Poll rather than reload. A hard reload every couple of seconds can fire mid-click and
// throw away a navigation the reader just started — the exact opposite of being free to
// leave. This updates in place, and only navigates once the build is actually done.
var path = ${JSON.stringify(repoPath)};
var started = Date.now();
var log = document.getElementById('log');
var elapsed = document.getElementById('elapsed');

setInterval(function () {
  var s = Math.round((Date.now() - started) / 1000);
  elapsed.textContent = s < 60 ? s + 's so far' : Math.floor(s / 60) + 'm ' + (s % 60) + 's so far';
}, 1000);

function tick() {
  fetch('/api/job?path=' + encodeURIComponent(path), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.lines && j.lines.length) log.textContent = j.lines.join('\\n');
      if (j.state === 'done') { location.replace('/r?path=' + encodeURIComponent(path)); return; }
      if (j.state === 'failed') {
        log.textContent = (j.lines || []).join('\\n') + '\\n\\nThat build failed. Go back and try Rebuild.';
        return;
      }
      setTimeout(tick, 1200);
    })
    .catch(function () { setTimeout(tick, 2500); });
}
tick();
</script>
</body></html>`;
}

/**
 * A repository that is loaded but has never been built.
 *
 * It offers the build rather than starting one. The estimate is deliberately vague and
 * deliberately present: someone about to spend minutes deserves to know that is the shape
 * of it before they press the button, not after.
 */
function notBuilt(repoPath: string): string {
  const esc = (x: string): string => x.replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(path.basename(repoPath))} — not built yet</title><style>${SHELL_STYLE}</style>
<script>${skinScript()}</script></head>
<body>${navBar('building')}<div class="buildwrap">
<h1>${esc(path.basename(repoPath))} has no tour yet</h1>
<div class="sub">
  Loading a repository and building its tour are separate decisions, so nothing has run.
  Building reads the whole tree and writes an explanation for each stop — minutes, not
  seconds, and it spends tokens the first time. Everything it works out is cached, so later
  builds cost only what actually changed. You can leave the page while it runs.
</div>
<div class="row" style="margin-top:18px">
  <button class="btn primary" id="go" type="button">Build the tour</button>
  <a class="btn" href="/">← All repositories</a>
</div>
</div>
<script>
document.getElementById('go').addEventListener('click', function () {
  var p = ${JSON.stringify(repoPath)};
  this.disabled = true; this.textContent = 'Starting…';
  fetch('/api/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })
    .then(function () { location.replace('/r?path=' + encodeURIComponent(p)); });
});
</script>
</body></html>`;
}

function notFound(repoPath: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>not loaded — repo-tour</title>
<style>${SHELL_STYLE}</style><script>${skinScript()}</script></head>
<body>${navBar('building')}<div class="wrap">
<h1>That repository is not loaded</h1>
<div class="sub"><code>${repoPath.replace(/</g, '&lt;')}</code> is not in the list.</div>
<footer><a href="/">← load it from the home page</a></footer>
</div></body></html>`;
}
