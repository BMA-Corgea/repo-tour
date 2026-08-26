/**
 * Tours as saved entities.
 *
 * A tour was previously a file you generated and then had to remember where you put. That
 * is wrong on two counts: refreshing the page cannot update a static snapshot, so a stale
 * tour looks exactly like a fresh one; and there was no way to hold more than the last one.
 *
 * A tour is now a record — repo, commit, when it was made, what it covers — stored beside
 * the digest that produced it and listed in a registry so every tour on this machine is
 * selectable from one page. Old tours are kept: a tour pinned to an older commit is still
 * the truth about that commit, which is exactly what you want when reviewing what changed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR } from './digest.js';

export interface TourRecord {
  id: string;
  repoName: string;
  /** absolute path of the repository this tours */
  repoPath: string;
  head: string | null;
  branch: string | null;
  generatedAt: string;
  stops: number;
  architectureStops: number;
  files: string[];
  interpreted: boolean;
  /** absolute path of the generated page */
  page: string;
}

export function toursDir(root: string): string {
  return path.join(root, CACHE_DIR, 'tours');
}

/** Registry of every tour made on this machine, so the library spans repositories. */
export function registryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'registry.json');
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

/** Every known tour, newest first, with entries whose pages have vanished dropped. */
export function listTours(): TourRecord[] {
  return readJson<TourRecord[]>(registryPath(), [])
    .filter((t) => fs.existsSync(t.page))
    .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
}

export function findTour(id: string): TourRecord | null {
  const all = listTours();
  return all.find((t) => t.id === id) ?? all.find((t) => t.id.startsWith(id)) ?? null;
}

/** The newest tour of a given repository, if there is one. */
export function newestFor(repoPath: string): TourRecord | null {
  const abs = path.resolve(repoPath);
  return listTours().find((t) => t.repoPath === abs) ?? null;
}

function register(record: TourRecord): void {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const all = readJson<TourRecord[]>(file, []).filter((t) => t.id !== record.id);
  all.push(record);
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

/**
 * Save a tour and its page.
 *
 * The id is the commit it was taken at, so re-touring the same commit replaces that tour
 * rather than piling up duplicates, while a new commit gets its own entry. An uncommitted
 * tree has no commit to pin to, so it gets a `working` id that is always overwritten —
 * pinning a tour to a dirty tree would be a lie about what it describes.
 */
export function saveTour(
  root: string,
  html: string,
  meta: Omit<TourRecord, 'id' | 'page' | 'generatedAt'>,
  generatedAt: string,
): TourRecord {
  const id = meta.head ? meta.head.slice(0, 10) : 'working';
  const dir = path.join(toursDir(root), id);
  fs.mkdirSync(dir, { recursive: true });

  const page = path.join(dir, 'index.html');
  fs.writeFileSync(page, html);

  const record: TourRecord = { ...meta, id, page, generatedAt };
  fs.writeFileSync(path.join(dir, 'tour.json'), JSON.stringify(record, null, 2));
  register(record);
  return record;
}

// ---------------------------------------------------------------- the library page

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const LIB_STYLE = `
:root {
  --bg:#ffffff; --canvas:#f6f8fa; --ink:#1f2328; --muted:#59636e; --line:#d1d9e0;
  --accent:#0969da; --chip:#eaeef2; --warn:#9a6700; --warn-bg:#fff8c5;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0d1117; --canvas:#010409; --ink:#e6edf3; --muted:#9198a1; --line:#3d444d;
    --accent:#4493f8; --chip:#212830; --warn:#e0b25f; --warn-bg:#2b2313;
  }
}
:root[data-theme="dark"] {
  --bg:#0d1117; --canvas:#010409; --ink:#e6edf3; --muted:#9198a1; --line:#3d444d;
  --accent:#4493f8; --chip:#212830; --warn:#e0b25f; --warn-bg:#2b2313;
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--canvas); color:var(--ink);
  font:14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Noto Sans, Helvetica, Arial, sans-serif;
}
.wrap { max-width:960px; margin:0 auto; padding:40px 20px 80px; }
h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.01em; }
.sub { color:var(--muted); font-size:13px; margin-bottom:26px; }
.repo { margin-bottom:28px; }
.repo h2 {
  font-size:13px; text-transform:uppercase; letter-spacing:0.07em; color:var(--muted);
  margin:0 0 10px; font-weight:600;
}
.card {
  display:block; background:var(--bg); border:1px solid var(--line); border-radius:8px;
  padding:14px 16px; margin-bottom:10px; text-decoration:none; color:inherit;
}
.card:hover { border-color:var(--accent); }
.card .top { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.sha { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-weight:600; color:var(--accent); }
.tag { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
.tag.now { border-color:transparent; background:var(--chip); color:var(--ink); }
.tag.old { background:var(--warn-bg); color:var(--warn); border-color:transparent; }
.meta { color:var(--muted); font-size:12px; margin-top:6px; }
.files { color:var(--muted); font-size:12px; margin-top:6px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.empty { color:var(--muted); }
code { background:var(--chip); padding:1px 6px; border-radius:4px; font-size:12px; }
footer { margin-top:34px; padding-top:16px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
`;

/**
 * Render the library.
 *
 * `currentHeads` maps a repo path to where that repo's HEAD is *now*, so a tour taken at an
 * older commit is labelled as such. A static page cannot know it has gone stale; this is
 * the only place that comparison can honestly be made.
 */
export function renderLibrary(
  tours: TourRecord[],
  currentHeads: Record<string, string | null>,
  now: number,
): string {
  const byRepo = new Map<string, TourRecord[]>();
  for (const t of tours) {
    if (!byRepo.has(t.repoPath)) byRepo.set(t.repoPath, []);
    byRepo.get(t.repoPath)!.push(t);
  }

  const sections = [...byRepo.entries()].map(([repoPath, list]) => {
    const head = currentHeads[repoPath] ?? null;
    const cards = list.map((t) => {
      const isCurrent = t.head !== null && head !== null && t.head === head;
      const label = t.id === 'working'
        ? '<span class="tag old">uncommitted tree</span>'
        : isCurrent
          ? '<span class="tag now">current HEAD</span>'
          : head === null
            ? ''
            : '<span class="tag old">HEAD has moved since</span>';
      return `<a class="card" href="${escapeHtml(t.page)}">
  <div class="top">
    <span class="sha">${escapeHtml(t.id)}</span>
    ${t.branch ? `<span class="tag">${escapeHtml(t.branch)}</span>` : ''}
    ${label}
    ${t.interpreted ? '' : '<span class="tag">not interpreted</span>'}
  </div>
  <div class="meta">${t.stops} stops — ${t.architectureStops} on the system, ${t.stops - t.architectureStops} through ${t.files.length} files · made ${escapeHtml(ago(t.generatedAt, now))}</div>
  <div class="files">${escapeHtml(t.files.slice(0, 5).join('  ·  '))}${t.files.length > 5 ? `  ·  +${t.files.length - 5} more` : ''}</div>
</a>`;
    }).join('\n');

    return `<div class="repo">
  <h2>${escapeHtml(list[0]!.repoName)} <span style="text-transform:none;font-weight:400">— ${escapeHtml(repoPath)}</span></h2>
  ${cards}
</div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>repo-tour — your tours</title>
<style>${LIB_STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>Your tours</h1>
  <div class="sub">Every tour made on this machine. Each one is pinned to the commit it was taken at, so an older tour is still the truth about that commit.</div>
  ${tours.length ? sections : '<p class="empty">No tours yet. Run <code>repo-tour tour &lt;path&gt;</code>.</p>'}
  <footer>
    A tour is a static page: refreshing it will never pick up new code, because it never
    looks at your repository again. Re-run <code>repo-tour tour</code> to make a new one —
    unchanged files are reused from the digest and already-explained code is not paid for
    twice, so it is far cheaper than the first run.
  </footer>
</div>
</body>
</html>`;
}
