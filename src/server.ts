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
import { surveyProviders, resolveChoice, providerById, killLlmChildren, runLlm, type LlmChoice } from './llm.js';
import { buildAskPrompt, trimMessages, type AskContext } from './ask.js';
import { listPrs, PrResolutionError, type PrListResult } from './pr.js';
import { NoCheckpointError } from './checkpoint.js';
import { runPrFlow } from './prflow.js';

export interface LoadedRepo {
  path: string;
  name: string;
  addedAt: string;
}

interface Rendered {
  fingerprint: string;
  /** which version of the RENDERER produced this page — see presentationVersion() */
  presentation: string;
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
  if (!best) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${best.fp}.json`), 'utf8')) as RenderedMeta;
    const html = fs.readFileSync(path.join(dir, `${best.fp}.html`), 'utf8');
    return { ...meta, html };
  } catch { return null; }
}

function readRendered(repoPath: string, fp: string): Rendered | null {
  const dir = renderedDir(repoPath);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${fp}.json`), 'utf8')) as RenderedMeta;
    if (meta.presentation !== presentationVersion()) return null;
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

/**
 * A hash of everything that decides how a page LOOKS, as opposed to what it says.
 *
 * Rendered pages are cached to disk with their CSS and scripts inlined, because a tour has
 * to open from `file://` with no network. That means a page carries the presentation it was
 * built with, forever: adding two skins changed nothing about any tour already on disk —
 * neither their CSS nor their options were in those files, so the picker could not offer
 * what was not there.
 *
 * Hashing the renderer's own inputs makes that automatic. Change a skin, edit the view, and
 * every cached page stops matching without anyone having to remember to invalidate it.
 *
 * Re-rendering is cheap: the digest is incremental and every explanation is already cached
 * by content hash, so a presentation change costs a render, not a re-read and not a token.
 */
/**
 * Held briefly, never for the life of the process.
 *
 * Memoising it forever was the same mistake as baking the boot id into a cached page: a
 * running server could not notice its own skins changing, so editing one changed nothing
 * until a restart. A couple of seconds is long enough to keep the four-second poll from
 * re-reading ten small files, and short enough that a saved stylesheet lands immediately.
 */
let presentationCache: { value: string; at: number } | null = null;
const PRESENTATION_TTL_MS = 2000;

function presentationVersion(): string {
  if (presentationCache && Date.now() - presentationCache.at < PRESENTATION_TTL_MS) {
    return presentationCache.value;
  }
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const h = createHash('sha256');

  const feed = (file: string): void => {
    try { h.update(fs.readFileSync(file)); } catch { /* absent input is itself a state */ }
  };

  // the skins and the vendored tour assets
  for (const dir of [path.join(root, 'assets', 'skins'), path.join(root, 'assets')]) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir).sort(); } catch { continue; }
    for (const f of entries) {
      if (!/\.(css|js)$/.test(f)) continue;
      feed(path.join(dir, f));
    }
  }
  // and the modules that build the page. Absent in a compiled install, which is fine: the
  // assets alone still catch every skin change.
  for (const f of ['repoview.ts', 'skins.ts', 'codetour.ts', 'architecture.ts', 'interpret.ts']) {
    feed(path.join(root, 'src', f));
  }

  presentationCache = { value: h.digest('hex').slice(0, 12), at: Date.now() };
  return presentationCache.value;
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
  /** which model writes the explanations; overrides the stored choice when given */
  llm?: Partial<LlmChoice>;
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
  private readonly interpret: boolean;
  /**
   * Which model writes the explanations.
   *
   * A property of the APP, not of a browser tab: it decides what a build costs and where the
   * source of somebody's private repository is sent, so it is stored on the server beside
   * the loaded-repo list rather than in localStorage.
   */
  private choice: LlmChoice;

  constructor(private opts: ServerOptions = {}) {
    this.statePath = opts.statePath
      ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'loaded.json');
    this.interpret = opts.interpret !== false;
    this.choice = resolveChoice(opts.llm ?? this.loadChoice());
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

  private choicePath(): string {
    return path.join(path.dirname(this.statePath), 'llm.json');
  }

  private loadChoice(): Partial<LlmChoice> | null {
    try { return JSON.parse(fs.readFileSync(this.choicePath(), 'utf8')) as Partial<LlmChoice>; }
    catch { return null; }
  }

  getChoice(): LlmChoice { return this.choice; }

  setChoice(next: Partial<LlmChoice>): LlmChoice {
    this.choice = resolveChoice(next);
    try {
      fs.mkdirSync(path.dirname(this.choicePath()), { recursive: true });
      fs.writeFileSync(this.choicePath(), JSON.stringify(this.choice, null, 2));
    } catch { /* an unwritable setting lasts this run, which is better than refusing it */ }
    return this.choice;
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
    const io = {
      provider: this.choice.provider, model: this.choice.model,
      cachedOnly: !this.interpret, onProgress: onLine,
    };

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
      presentation: presentationVersion(),
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

  /**
   * Finished PR tours, keyed `<repo>#pr-<n>`, newest last. Cleared on restart, like jobs.
   *
   * BOUNDED. Each rendered tour embeds the source it walks and runs close to a megabyte;
   * an unbounded map would let a session spent browsing pull requests grow the server's
   * memory without limit and without anything to show for it. Rebuilding an evicted tour
   * costs no tokens — every interpretation and verdict behind it is cached by content — so
   * the cheapest thing to throw away is the render.
   */
  private prTours = new Map<string, { html: string }>();
  private static readonly PR_TOUR_KEEP = 8;

  /**
   * Build one PR tour in the background.
   *
   * Deliberately NOT keyed by repo path alone: a person can be reading a repo tour while a
   * PR tour builds, and one job slot per repository would have them evict each other.
   */
  private startPrJob(repoPath: string, n: number): Job {
    const key = `${repoPath}#pr-${n}`;
    const running = this.jobs.get(key);
    if (running?.state === 'running') return running;

    const job: Job = { repo: key, state: 'running', lines: [`reading PR #${n}`], startedAt: Date.now() };
    this.jobs.set(key, job);

    void runPrFlow(repoPath, { pr: n, onProgress: (line) => job.lines.push(line) })
      .then((result) => {
        this.prTours.set(key, { html: result.html });
        while (this.prTours.size > RepoTourServer.PR_TOUR_KEEP) {
          const oldest = this.prTours.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.prTours.delete(oldest);
        }
        job.state = 'done';
        job.lines.push('ready');
      })
      .catch((e: unknown) => {
        job.state = 'failed';
        // A resolution failure or a missing checkpoint carries a message written for a
        // person and naming the remedy. Show THAT, not a stack.
        job.lines.push(
          e instanceof PrResolutionError || e instanceof NoCheckpointError
            ? e.message
            : e instanceof Error ? e.message : String(e),
        );
      });

    return job;
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

      if (route === '/api/llm') {
        return this.json(res, 200, { chosen: this.choice, providers: await surveyProviders() });
      }

      if (route === '/api/llm-set' && req.method === 'POST') {
        const body = JSON.parse(await this.readBody(req)) as Partial<LlmChoice>;
        if (body.provider && !providerById(body.provider)) {
          return this.json(res, 400, { error: `no such provider: ${body.provider}` });
        }
        return this.json(res, 200, { chosen: this.setChoice(body) });
      }

      if (route === '/api/repos') return this.json(res, 200, { repos: this.listRepos() });

      /**
       * The Ask panel.
       *
       * Everything the reader can see is sent UP from the page rather than reassembled
       * here: the page already holds the file, the diff, the stop and the notes, and the
       * notes in particular live in the reader's own browser and the server has never seen
       * them. Rebuilding that state server-side would mean either duplicating it or
       * persisting notes somewhere they were never promised to go.
       */
      if (route === '/api/ask' && req.method === 'POST') {
        let payload: { messages?: unknown; context?: AskContext };
        try {
          payload = JSON.parse(await this.readBody(req)) as typeof payload;
        } catch {
          return this.json(res, 400, { error: 'invalid JSON' });
        }
        const messages = trimMessages(payload.messages);
        if (!messages.length) return this.json(res, 400, { error: 'ask something first' });

        const prompt = buildAskPrompt(messages, payload.context ?? {});
        try {
          const reply = await runLlm(prompt, this.choice, process.cwd());
          const text = reply.text.trim();
          if (!text) return this.json(res, 502, { error: 'the model returned nothing' });
          return this.json(res, 200, { reply: text, model: this.choice.model, provider: this.choice.provider });
        } catch (e) {
          // The provider's own words. "Could not launch the claude CLI" tells the reader
          // what to fix; "request failed" tells them nothing.
          return this.json(res, 502, { error: e instanceof Error ? e.message.split('\n')[0] : String(e) });
        }
      }

      /**
       * What the Pull requests tab asks, on load.
       *
       * Fetched rather than baked into the page: a count rendered at build time is a lie
       * within the hour, and blocking the page render on a network call to GitHub would
       * make every repo page as slow as the slowest `gh`.
       */
      if (route === '/api/prs') {
        const p = url.searchParams.get('path') ?? '';
        if (!this.repos.some((r) => r.path === p)) return this.json(res, 404, { error: 'not loaded' });
        const listed = await listPrs(p);
        const building = [...this.jobs.entries()]
          .filter(([k, j]) => k.startsWith(`${p}#pr-`) && j.state === 'running')
          .map(([k]) => Number(k.split('#pr-')[1]))
          .filter((n) => Number.isInteger(n));
        return this.json(res, 200, listed.ok
          ? { ok: true, count: listed.prs.length, building }
          : { ok: false, reason: listed.reason, building });
      }

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
      // ---- pull requests, in the app rather than on a file path
      //
      // T-8: the repo page has always had a "Pull requests" tab and it was a dead span.
      // A PR tour spends model calls, so it gets the same treatment a repo tour gets —
      // a background job and the building page — rather than holding a request open.
      if (route === '/prs') {
        const p = url.searchParams.get('path') ?? '';
        if (!this.repos.some((r) => r.path === p)) return this.html(res, 404, notFound(p));
        return this.html(res, 200, prList(p, await listPrs(p)));
      }

      if (route === '/pr') {
        const p = url.searchParams.get('path') ?? '';
        const n = Number(url.searchParams.get('n') ?? NaN);
        if (!this.repos.some((r) => r.path === p)) return this.html(res, 404, notFound(p));
        if (!Number.isInteger(n) || n <= 0) return this.html(res, 404, notFound(p));

        const key = `${p}#pr-${n}`;
        const done = this.prTours.get(key);
        if (done?.html) return this.html(res, 200, done.html);

        const job = this.jobs.get(key);
        if (job?.state === 'running') {
          return this.html(res, 200, building(
            `PR #${n}`, job.lines, key,
            `/pr?path=${encodeURIComponent(p)}&n=${n}`,
          ));
        }
        if (job?.state === 'failed') return this.html(res, 200, prFailed(p, n, job.lines));

        this.startPrJob(p, n);
        return this.html(res, 200, building(
          `PR #${n}`, [`reading PR #${n}`], key,
          `/pr?path=${encodeURIComponent(p)}&n=${n}`,
        ));
      }

      if (route === '/r') {
        const p = url.searchParams.get('path') ?? '';
        if (!this.repos.some((r) => r.path === p)) return this.html(res, 404, notFound(p));
        const job = this.jobs.get(p);
        const fp = fingerprint(p);
        const cached = this.lookup(p, fp);

        if (cached) {
          // T-8: the cache is keyed on the TREE, so a page whose code has not changed was
          // served forever even after the renderer changed underneath it. That is how a new
          // control can ship and stay invisible: the reader updates, their fingerprint still
          // matches, and they keep getting the page that predates the feature.
          //
          // Re-render behind them on a presentation change and serve the current copy now.
          // It costs no tokens — interpretation is cached by content — and the freshness
          // chip already offers the result when it lands.
          if (cached.presentation !== presentationVersion() && job?.state !== 'running') {
            this.startJob(p);
          }
          return this.html(res, 200, cached.html);
        }

        // The tree has moved since the last build. Serve that build anyway — it is still the
        // truth about the commit it describes, and making it unreachable turns every edit
        // into a wait before anything can be read. The page carries a quiet marker instead.
        const older = newestRendered(p);
        if (older) {
          // The renderer itself has moved on (a new skin, a changed view). That is the app
          // updating rather than the reader's code changing, and re-rendering costs no
          // tokens — so start it behind them and let the chip offer the result.
          if (older.presentation !== presentationVersion() && job?.state !== 'running') this.startJob(p);
          return this.html(res, 200, older.html);
        }

        if (job?.state === 'running') {
          return this.html(res, 200, building(path.basename(p), job.lines, p, `/r?path=${encodeURIComponent(p)}`));
        }
        return this.html(res, 200, notBuilt(p));
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      this.json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  /**
   * Start listening, and be able to STOP.
   *
   * Stopping cleanly is not a nicety here: the app restarts itself on every source change,
   * so a process that will not exit means the supervisor force-kills it and nothing comes
   * back listening — which looks exactly like the app breaking. Two things hold it open and
   * both are tracked:
   *
   *   · KEEP-ALIVE SOCKETS. `server.close()` stops accepting new connections and then waits
   *     for existing ones to finish. The pages poll every two seconds over keep-alive, so
   *     "existing" means "forever". They have to be destroyed, not waited on.
   *   · IN-FLIGHT MODEL CALLS. An interpretation can run for minutes; those children are
   *     killed, and the build resumes from its marker on the next boot.
   */
  listen(): Promise<{ port: number; close: () => Promise<void> }> {
    const port = this.opts.port ?? 7788;
    const server = http.createServer((req, res) => { void this.handler(req, res); });
    const sockets = new Set<import('node:net').Socket>();
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });

    const close = (): Promise<void> => new Promise((done) => {
      killLlmChildren();
      server.close(() => done());
      for (const s of sockets) s.destroy();
      sockets.clear();
      // A socket that will not die must not hold the whole app hostage.
      setTimeout(done, 1500).unref();
    });

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      // Loopback only. This serves the contents of your repositories; it has no business
      // listening on anything reachable from outside this machine.
      // Report the port actually bound, not the one asked for: port 0 means "anything
      // free", and answering 0 tells the caller nothing it can connect to.
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        resolve({ port: typeof addr === 'object' && addr ? addr.port : port, close });
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
/* AGPL section 13: a program people interact with over a network should offer them its
   source. This IS a network-interactive program, so the offer belongs in the interface
   rather than only in a file nobody opens. */
.src{font-size:12px;color:var(--muted);text-decoration:none}
.src:hover{color:var(--accent)}
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

/* ── who writes the explanations ─────────────────────────────────────────────────────────── */
.llm{margin-bottom:34px}
.llmgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}
.prov{
  border:1px solid var(--line);border-radius:10px;padding:13px 15px;background:var(--bg);
  cursor:pointer;transition:border-color .14s ease
}
.prov:hover{border-color:var(--btn-edge-hover)}
.prov.on{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.prov.off{opacity:.55;cursor:default}
.prov.off:hover{border-color:var(--line)}
.prov .ptop{display:flex;align-items:center;gap:8px}
.prov h4{margin:0;font-size:14px;font-weight:600;flex:1}
.prov .pnote{color:var(--muted);font-size:12px;line-height:1.6;margin:6px 0 0}
.prov .pdetail{
  color:var(--muted);font-size:11px;margin-top:7px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all
}
.prov select{margin-top:9px;width:100%;font-size:12px}
.llmnote{margin-top:12px;line-height:1.7;max-width:74ch}
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
  <a class="src" href="https://github.com/BMA-Corgea/repo-tour" target="_blank" rel="noreferrer"
     title="repo-tour is free software under the AGPL. This is its source.">Source</a>
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
  <section class="llm" id="llm">
    <div class="secthead">
      <h2>Who writes the explanations</h2>
      <span class="said" id="llmnow"></span>
    </div>
    <div class="llmgrid" id="llmgrid"></div>
    <p class="said llmnote">
      Everything else about a tour is worked out on this machine by parsers and git. This one
      stage reads your source and writes prose about it, so it is the only place a choice of
      model matters — for what a build costs, for how good the explanations are, and for where
      the code goes. Work already explained by one model is kept, so switching back finds it.
    </p>
  </section>

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

function llmCard(p, chosen) {
  var usable = p.availability.ok;
  var picked = p.id === chosen.provider;
  var models = p.models.map(function (m) {
    return '<option value="' + esc(m) + '"' + (picked && m === chosen.model ? ' selected' : '') + '>' + esc(m) + '</option>';
  }).join('');
  return '<div class="prov ' + (picked ? 'on ' : '') + (usable ? '' : 'off') + '" data-prov="' + esc(p.id) + '">' +
    '<div class="ptop"><h4>' + esc(p.label) + '</h4>' +
      (usable ? (picked ? '<span class="tag ok">in use</span>' : '') : '<span class="tag">unavailable</span>') +
    '</div>' +
    '<p class="pnote">' + esc(p.note) + '</p>' +
    '<div class="pdetail">' + esc(p.availability.detail) + '</div>' +
    (usable && p.models.length > 1 ? '<select data-model>' + models + '</select>' : '') +
  '</div>';
}

function refreshLlm() {
  fetch('/api/llm').then(function (r) { return r.json(); }).then(function (d) {
    document.getElementById('llmnow').textContent = d.chosen.provider + ' · ' + d.chosen.model;
    document.getElementById('llmgrid').innerHTML =
      d.providers.map(function (p) { return llmCard(p, d.chosen); }).join('');
  });
}

document.getElementById('llmgrid').addEventListener('change', function (e) {
  var sel = e.target.closest('[data-model]');
  if (!sel) return;
  var card = sel.closest('.prov');
  fetch('/api/llm-set', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: card.getAttribute('data-prov'), model: sel.value }) })
    .then(refreshLlm);
});

document.getElementById('llmgrid').addEventListener('click', function (e) {
  var card = e.target.closest('.prov');
  if (!card || card.classList.contains('off') || e.target.closest('[data-model]')) return;
  var sel = card.querySelector('[data-model]');
  fetch('/api/llm-set', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: card.getAttribute('data-prov'), model: sel ? sel.value : undefined }) })
    .then(refreshLlm);
});

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
refreshLlm();
setInterval(refresh, 4000);
</script>
</body></html>`;
}

/**
 * The "this is being read" page.
 *
 * Three things it needs, and they are NOT the same string — which is the bug this signature
 * exists to prevent. A PR build was rendered with `building(\`${repo} — PR #3\`, …)`, so the
 * page polled `/api/job?path=<that decorated label>`, matched no job, read back `idle`
 * forever, and hung. Leaving and returning worked, because the route checks the finished
 * tour directly — which is exactly what the owner saw.
 *
 *   label    what the reader is told is being read
 *   jobKey   the key the job is actually stored under
 *   doneUrl  where to go when it finishes — a PR tour is not at /r
 */
function building(label: string, lines: string[], jobKey: string, doneUrl: string): string {
  const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>building ${esc(label)} — repo-tour</title><style>${SHELL_STYLE}</style><script>${skinScript()}</script></head>
<body>${navBar('building')}<div class="buildwrap">
<h1><span class="spin"></span>Reading ${esc(label)}</h1>
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
var jobKey = ${JSON.stringify(jobKey)};
var doneUrl = ${JSON.stringify(doneUrl)};
var started = Date.now();
var log = document.getElementById('log');
var elapsed = document.getElementById('elapsed');

setInterval(function () {
  var s = Math.round((Date.now() - started) / 1000);
  elapsed.textContent = s < 60 ? s + 's so far' : Math.floor(s / 60) + 'm ' + (s % 60) + 's so far';
}, 1000);

function tick() {
  fetch('/api/job?path=' + encodeURIComponent(jobKey), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.lines && j.lines.length) log.textContent = j.lines.join('\\n');
      if (j.state === 'done') { location.replace(doneUrl); return; }
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

/**
 * The pull-request list — what the tab now opens.
 *
 * The three ways this can be empty are kept distinct on the page (no open PRs / no gh /
 * gh cannot answer), because an empty list and a broken tool look identical otherwise, and
 * "your repo is quiet" is a bad thing to tell someone whose tooling is misconfigured.
 */
function prList(repoPath: string, result: PrListResult): string {
  const esc = (x: string): string => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const name = path.basename(repoPath);
  const back = `/r?path=${encodeURIComponent(repoPath)}`;

  const body = !result.ok
    ? `<div class="sub"><b>${esc(result.reason)}.</b><br>${esc(result.remedy)}</div>`
    : result.prs.length === 0
      ? `<div class="sub">No open pull requests on this repository right now.</div>`
      : `<div class="sub">Pick one. A tour reads both sides of the change and works out what
           actually moved in MEANING, not just what moved in lines — so it takes a few
           minutes the first time and you can leave the page while it runs.</div>
         <ul class="prlist">${result.prs.map((p) => `
           <li>
             <a href="/pr?path=${encodeURIComponent(repoPath)}&amp;n=${p.number}">
               <span class="prnum">#${p.number}</span>
               <span class="prtitle">${esc(p.title)}${p.draft ? ' <em>(draft)</em>' : ''}</span>
             </a>
             <div class="prmeta">${esc(p.author)} · <code>${esc(p.headRefName)}</code></div>
           </li>`).join('')}</ul>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} — pull requests</title><style>${SHELL_STYLE}</style>
<style>
  .prlist { list-style:none; padding:0; margin:18px 0 0; }
  .prlist li { padding:12px 0; border-bottom:1px solid var(--line,#2a2f3a); }
  .prlist a { text-decoration:none; display:flex; gap:10px; align-items:baseline; }
  .prnum { opacity:.6; font-variant-numeric:tabular-nums; }
  .prtitle { font-weight:600; }
  .prmeta { opacity:.6; font-size:12px; margin-top:4px; }
</style>
<script>${skinScript()}</script></head>
<body>${navBar('building')}<div class="buildwrap">
<h1>Pull requests — ${esc(name)}</h1>
${body}
<footer style="margin-top:24px"><a href="${back}">← back to ${esc(name)}</a> · <a href="/">All repositories</a></footer>
</div></body></html>`;
}

/** A PR tour that could not be built — showing the reason it gave, which names a remedy. */
function prFailed(repoPath: string, n: number, lines: string[]): string {
  const esc = (x: string): string => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const why = lines[lines.length - 1] ?? 'no reason recorded';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PR #${n} — could not build</title><style>${SHELL_STYLE}</style>
<script>${skinScript()}</script></head>
<body>${navBar('building')}<div class="buildwrap">
<h1>PR #${n} could not be toured</h1>
<div class="log">${esc(why)}</div>
<footer style="margin-top:24px">
  <a href="/prs?path=${encodeURIComponent(repoPath)}">← pull requests</a> ·
  <a href="/r?path=${encodeURIComponent(repoPath)}">${esc(path.basename(repoPath))}</a>
</footer>
</div></body></html>`;
}

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
