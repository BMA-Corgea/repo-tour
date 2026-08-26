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

  listRepos(): Array<LoadedRepo & { built: RenderedMeta | null; current: boolean; running: boolean }> {
    return this.repos.map((r) => {
      const fp = fingerprint(r.path);
      const built = this.lookup(r.path, fp) ?? this.cache.get(r.path) ?? null;
      const meta = built ? (({ html, ...rest }) => rest)(built) : null;
      return {
        ...r,
        built: meta,
        current: meta !== null && meta.fingerprint === fp,
        running: this.jobs.get(r.path)?.state === 'running',
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
      servedBy: { homeUrl: '/', bootId: this.bootId },
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

    void this.build(repoPath, (line) => { job.lines.push(line); })
      .then(() => { job.state = 'done'; job.lines.push('ready'); })
      .catch((e: unknown) => {
        job.state = 'failed';
        job.lines.push(e instanceof Error ? e.message : String(e));
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
        if (job?.state === 'running') return this.html(res, 200, building(p, job.lines));

        // Built before, but the tree has moved: rebuild on the refresh, as asked.
        if (hasAnyBuild(p)) {
          this.startJob(p);
          return this.html(res, 200, building(p, ['the repository has changed — rebuilding…']));
        }

        // Never built: wait to be asked.
        return this.html(res, 200, notBuilt(p));
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      this.json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  listen(): Promise<{ port: number; close: () => void }> {
    const port = this.opts.port ?? 7777;
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
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>repo-tour</title><style>${SHELL_STYLE}</style><script>${skinScript()}</script></head>
<body>${navBar('home')}<div class="wrap">
<h1>repo-tour</h1>
<div class="sub">Load a repository and it stays loaded. Open its tour and refresh whenever you like — the page re-reads the repo, so what you see is the code as it is now.</div>

<div class="addbar">
  <input type="text" id="p" placeholder="/path/to/a/repository" spellcheck="false">
  <button class="btn primary" id="add" type="button">Load repository</button>
</div>
<div class="err" id="err"></div>
<div id="list"><p class="empty">Loading…</p></div>

<footer>
  Repositories stay loaded between restarts. Opening a tour rebuilds it only when the repo
  has actually moved — HEAD or the working tree — and a rebuild reuses every unchanged file
  and every already-written explanation, so an edit costs one file's worth of work.
</footer>
</div>
<script>
var timers = {};
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function card(r){
  var state = r.running ? '<span class="tag">building…</span>'
    : r.built ? (r.current ? '<span class="tag ok">up to date</span>' : '<span class="tag stale">repo has changed</span>')
    : '<span class="tag">not built yet</span>';
  var meta = r.built ? '<span class="tag">' + r.built.stops + ' stops</span><span class="tag">' + r.built.files.length + ' files</span>' : '';
  return '<div class="card" data-p="' + esc(r.path) + '">' +
    '<div class="top"><span class="nm">' + esc(r.name) + '</span>' + state + meta + '</div>' +
    '<div class="pth">' + esc(r.path) + '</div>' +
    '<div class="row">' +
      (r.built
        ? '<a class="btn primary" href="/r?path=' + encodeURIComponent(r.path) + '">Open tour</a>' +
          '<button class="btn" data-act="rebuild">' + (r.current ? 'Rebuild' : 'Rebuild \u2014 repo has changed') + '</button>'
        : r.running
          ? '<a class="btn primary" href="/r?path=' + encodeURIComponent(r.path) + '">Watch it build</a>'
          : '<button class="btn primary" data-act="build">Build the tour</button>') +
      '<span class="spacer"></span>' +
      '<button class="btn" data-act="remove">Remove</button>' +
    '</div>' +
    '<div class="log" data-log></div>' +
  '</div>';
}

function poll(p, el){
  clearInterval(timers[p]);
  timers[p] = setInterval(function(){
    fetch('/api/job?path=' + encodeURIComponent(p)).then(function(r){return r.json();}).then(function(j){
      el.textContent = (j.lines || []).join('\\n');
      if (j.state !== 'running') { clearInterval(timers[p]); refresh(); }
    });
  }, 900);
}

function refresh(){
  fetch('/api/repos').then(function(r){return r.json();}).then(function(d){
    var list = document.getElementById('list');
    if (!d.repos.length) { list.innerHTML = '<p class="empty">No repositories loaded yet. Paste a path above.</p>'; return; }
    list.innerHTML = d.repos.map(card).join('');
    d.repos.forEach(function(r){
      if (r.running) poll(r.path, list.querySelector('[data-p="' + CSS.escape(r.path) + '"] [data-log]'));
    });
  });
}

document.getElementById('add').addEventListener('click', function(){
  var p = document.getElementById('p').value.trim();
  if (!p) return;
  document.getElementById('err').textContent = '';
  fetch('/api/add', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({path:p})})
    .then(function(r){return r.json();})
    .then(function(d){
      if (d.error) { document.getElementById('err').textContent = d.error; return; }
      document.getElementById('p').value = '';
      refresh();
    });
});
document.getElementById('p').addEventListener('keydown', function(e){ if (e.key === 'Enter') document.getElementById('add').click(); });

document.getElementById('list').addEventListener('click', function(e){
  var btn = e.target.closest('[data-act]');
  if (!btn) return;
  var p = btn.closest('.card').getAttribute('data-p');
  var act = btn.getAttribute('data-act');
  if (act !== 'remove') { btn.disabled = true; btn.textContent = 'Starting…'; }
  fetch('/api/' + (act === 'remove' ? 'remove' : act === 'build' ? 'build' : 'rebuild'),
    {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({path:p})})
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
