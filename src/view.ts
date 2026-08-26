/**
 * Acceptance criterion 8 — a local, self-contained HTML view of the digest.
 *
 * This is the criterion the other eight are judged through: criteria 1-7 prove the
 * machinery works, but only a human reading this page can tell whether the digest is any
 * GOOD. So it optimizes for being argued with — every score shows its components, every
 * classification shows the signal that produced it, and anything the page leaves out says
 * so on the page rather than quietly disappearing.
 *
 * Self-contained means self-contained: no CDN, no fonts, no fetch. One file, opens offline.
 */

import fs from 'node:fs';
import type { DigestResult } from './digest.js';
import type { FileExtract, RankedFile } from './types.js';
import type { TourStep } from './tour.js';

export interface ViewOptions {
  /** how many ranked files to embed; the page states what it dropped */
  maxRows?: number;
  /** when given, the guided tour engine is inlined and these steps are played */
  tour?: TourStep[];
}

/** The tour engine ships in assets/ and is INLINED — the page must open with no network. */
function readAsset(name: string): string {
  return fs.readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');
}

const TOUR_BOOTSTRAP = `
(function () {
  var defs = window.__TOUR__ || [];
  if (!defs.length || !window.Tour) return;

  function filterTo(p) {
    var q = document.getElementById('q');
    if (!q) return;
    q.value = p;
    q.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function rowFor(p) {
    var rows = document.querySelectorAll('tr.f');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-tour-path') === p) return rows[i];
    }
    return null;
  }

  var steps = defs.map(function (s) {
    var step = { target: s.target, title: s.title, text: s.text, placement: s.placement };
    if (s.filterTo || s.expand) {
      step.beforeShow = function (api) {
        if (s.filterTo) filterTo(s.filterTo);
        return api.wait(80).then(function () {
          if (!s.expand || !s.filterTo) return;
          var row = rowFor(s.filterTo);
          if (!row) return;
          var nxt = row.nextElementSibling;
          if (nxt && nxt.classList.contains('detail')) return; // already open
          row.click();
          return api.wait(60);
        });
      };
    }
    return step;
  });

  var cfg = {
    storageKey: 'repo_tour_demo_done',
    narrator: { name: 'repo-tour' },
    steps: steps,
    finishLabel: 'Done',
    onFinish: function () { filterTo(''); },
    onSkip: function () { filterTo(''); },
  };

  var replay = document.getElementById('replay');
  if (replay) replay.addEventListener('click', function () { window.Tour.replay(cfg); });
  window.Tour.start(cfg);
})();
`;

interface Row extends RankedFile {
  language: string | null;
  signals: string[];
  symbols: FileExtract['symbols'];
  importCount: number;
  resolvedImports: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `</script>` inside embedded JSON would close the tag early. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const STYLE = `
:root {
  --bg: #fbfbfa; --panel: #ffffff; --ink: #1a1a19; --muted: #6b6b66;
  --line: #e3e3df; --accent: #2f5d50; --accent-soft: #e8f0ed;
  --warn: #8a5a00; --warn-soft: #fdf3e0; --zero: #a8a8a2;
  --bar: #2f5d50;
}
:root:not([data-theme="light"]) { }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14161a; --panel: #1b1e23; --ink: #e6e6e3; --muted: #9a9a94;
    --line: #2c3037; --accent: #7fc7ae; --accent-soft: #1e2c28;
    --warn: #e0b25f; --warn-soft: #2b2313; --zero: #5c6068;
    --bar: #7fc7ae;
  }
}
:root[data-theme="dark"] {
  --bg: #14161a; --panel: #1b1e23; --ink: #e6e6e3; --muted: #9a9a94;
  --line: #2c3037; --accent: #7fc7ae; --accent-soft: #1e2c28;
  --warn: #e0b25f; --warn-soft: #2b2313; --zero: #5c6068;
  --bar: #7fc7ae;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 32px 20px 80px; }
header h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
header .root { color: var(--muted); font-size: 13px; word-break: break-all; }
.stages { margin: 14px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  font-size: 12px; padding: 3px 9px; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent); border: 1px solid transparent;
}
.chip.off { background: transparent; color: var(--muted); border-color: var(--line); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 22px 0; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.card h3 { margin: 0 0 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 600; }
.big { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
.sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.note {
  background: var(--warn-soft); border: 1px solid var(--line); border-left: 3px solid var(--warn);
  border-radius: 6px; padding: 10px 14px; margin: 16px 0; font-size: 13px; color: var(--ink);
}
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin: 30px 0 10px; font-weight: 600; }
.scroll { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 7px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; position: sticky; top: 0; background: var(--panel); }
th.s { cursor: pointer; user-select: none; }
th.s:hover { color: var(--accent); }
tbody tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: nowrap; }
.tag { font-size: 11px; padding: 1px 7px; border-radius: 4px; background: var(--accent-soft); color: var(--accent); }
.tag.zero { background: transparent; color: var(--zero); border: 1px solid var(--line); }
.meter { display: inline-block; width: 54px; height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; vertical-align: middle; margin-right: 8px; }
.meter i { display: block; height: 100%; background: var(--bar); }
tr.f { cursor: pointer; }
tr.f:hover td { background: var(--accent-soft); }
tr.detail td { white-space: normal; background: var(--bg); }
.det { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; padding: 6px 0 10px; }
.det h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.det ul { margin: 0; padding-left: 16px; font-size: 12px; }
.det li { margin: 2px 0; }
.kind { color: var(--muted); font-size: 11px; }
.controls { display: flex; gap: 10px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
input[type=search], select {
  font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 7px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
}
input[type=search] { min-width: 240px; }
.replay {
  margin-top: 14px; font: inherit; font-size: 12px; padding: 6px 12px; cursor: pointer;
  border-radius: 7px; border: 1px solid var(--line); background: var(--accent-soft); color: var(--accent);
}
.replay:hover { border-color: var(--accent); }
footer { margin-top: 34px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); padding-top: 14px; }
`;

const SCRIPT = `
(function () {
  var rows = window.__DIGEST__.rows;
  var shown = rows.slice();
  var sortKey = 'score', sortDir = -1;
  var tbody = document.getElementById('rows');
  var search = document.getElementById('q');
  var classFilter = document.getElementById('cls');
  var count = document.getElementById('count');

  function meter(v) {
    var pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
    return '<span class="meter"><i style="width:' + pct + '%"></i></span>';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function detailHtml(r) {
    var syms = r.symbols.length
      ? r.symbols.slice(0, 60).map(function (s) {
          return '<li><code>' + esc(s.name) + '</code> <span class="kind">' + s.kind +
            (s.exported ? ' · public' : '') + ' · L' + s.line + '</span></li>';
        }).join('') + (r.symbols.length > 60 ? '<li class="kind">… ' + (r.symbols.length - 60) + ' more not listed</li>' : '')
      : '<li class="kind">none extracted</li>';
    return '<tr class="detail"><td colspan="8"><div class="det">' +
      '<div><h4>Why this score</h4><ul>' +
        '<li>churn ' + r.churn + ' commits → ' + r.components.churn.toFixed(3) + ' × 0.45</li>' +
        '<li>in-degree ' + r.inDegree + ' → ' + r.components.inDegree.toFixed(3) + ' × 0.35</li>' +
        '<li>size ' + (r.loc < 0 ? 'truncated' : r.loc + ' loc') + ' → ' + r.components.size.toFixed(3) + ' × 0.20</li>' +
        '<li>× ' + r.components.multiplier + ' (' + r.classification + ')</li>' +
      '</ul></div>' +
      '<div><h4>Classified by</h4><ul>' + r.signals.map(function (s) {
        return '<li><code>' + esc(s) + '</code></li>'; }).join('') + '</ul></div>' +
      '<div><h4>Symbols (' + r.symbols.length + ')</h4><ul>' + syms + '</ul></div>' +
      '<div><h4>Imports</h4><ul><li>' + r.resolvedImports + ' resolved inside the tree</li>' +
        '<li>' + (r.importCount - r.resolvedImports) + ' left the tree</li></ul></div>' +
      '</div></td></tr>';
  }

  function render() {
    var q = search.value.trim().toLowerCase();
    var cls = classFilter.value;
    shown = rows.filter(function (r) {
      if (cls !== 'all' && r.classification !== cls) return false;
      if (q && r.path.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    shown.sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (typeof x === 'string') return x.localeCompare(y) * sortDir;
      return (x - y) * sortDir;
    });
    count.textContent = shown.length + ' of ' + rows.length + ' embedded files';
    tbody.innerHTML = shown.map(function (r, i) {
      return '<tr class="f" data-i="' + i + '" data-tour-path="' + esc(r.path) + '">' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td class="num">' + meter(r.score) + r.score.toFixed(3) + '</td>' +
        '<td class="num">' + r.churn + '</td>' +
        '<td class="num">' + r.inDegree + '</td>' +
        '<td class="num">' + (r.loc < 0 ? '—' : r.loc) + '</td>' +
        '<td><span class="tag' + (r.score === 0 ? ' zero' : '') + '">' + r.classification + '</span></td>' +
        '<td>' + (r.language || '') + '</td>' +
        '<td class="path">' + esc(r.path) + '</td>' +
      '</tr>';
    }).join('');
  }

  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr.f');
    if (!tr) return;
    var next = tr.nextElementSibling;
    if (next && next.classList.contains('detail')) { next.remove(); return; }
    tr.insertAdjacentHTML('afterend', detailHtml(shown[+tr.dataset.i]));
  });

  Array.prototype.forEach.call(document.querySelectorAll('th.s'), function (th) {
    th.addEventListener('click', function () {
      var k = th.dataset.k;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'path' ? 1 : -1; }
      render();
    });
  });
  search.addEventListener('input', render);
  classFilter.addEventListener('change', render);
  render();
})();
`;

export function renderView(result: DigestResult, opts: ViewOptions = {}): string {
  const maxRows = opts.maxRows ?? 750;
  const m = result.manifest;

  const extractByPath = new Map(result.extracts.map((e) => [e.path, e] as const));
  const fileByPath = new Map(result.inventory.files.map((f) => [f.path, f] as const));

  const rows: Row[] = result.ranked.slice(0, maxRows).map((r) => {
    const ex = extractByPath.get(r.path);
    const file = fileByPath.get(r.path);
    return {
      ...r,
      language: file?.language ?? null,
      signals: file?.signals ?? [],
      symbols: ex?.symbols ?? [],
      importCount: ex?.imports.length ?? 0,
      resolvedImports: ex?.imports.filter((i) => i.resolved !== null).length ?? 0,
    };
  });

  const dropped = result.ranked.length - rows.length;
  const cov = m.graphCoverage;
  const covPct = cov.totalImports === 0 ? 0 : Math.round((cov.resolvedInternal / cov.totalImports) * 100);
  const classes = Object.entries(m.counts.byClassification).sort((a, b) => b[1] - a[1]);
  const wall = m.cost.wallMs < 1000 ? `${m.cost.wallMs}ms` : `${(m.cost.wallMs / 1000).toFixed(1)}s`;

  const repoRows = m.repos
    .map((r) => {
      const label = r.root === '' ? '. (scan root)' : r.root;
      return `<tr><td class="path">${escapeHtml(label)}</td><td class="num">${r.commitCount}</td>` +
        `<td class="mono">${r.head ? escapeHtml(r.head.slice(0, 10)) : '—'}</td>` +
        `<td>${escapeHtml(r.branch ?? '—')}</td><td>${r.pointer ? 'worktree/submodule' : ''}</td></tr>`;
    })
    .join('');

  const classRows = classes
    .map(([k, v]) => {
      const pct = Math.round((v / m.counts.files) * 100);
      return `<tr><td><span class="tag">${escapeHtml(k)}</span></td><td class="num">${v}</td>` +
        `<td class="num">${pct}%</td></tr>`;
    })
    .join('');

  const optionTags = ['all', ...classes.map(([k]) => k)]
    .map((c) => `<option value="${escapeHtml(c)}">${c === 'all' ? 'all classifications' : escapeHtml(c)}</option>`)
    .join('');

  const tourSteps = opts.tour ?? [];
  const tourCss = tourSteps.length ? `<style>${readAsset('tour.css')}</style>` : '';
  const tourJs = tourSteps.length
    ? `<script>window.__TOUR__ = ${embedJson(tourSteps)};</script>\n<script>${readAsset('tour.js')}</script>\n<script>${TOUR_BOOTSTRAP}</script>`
    : '';
  const replayBtn = tourSteps.length
    ? '<button id="replay" class="replay" type="button">Replay the tour</button>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>repo-tour digest — ${escapeHtml(m.root.split('/').pop() ?? m.root)}</title>
<style>${STYLE}</style>
${tourCss}
</head>
<body>
<div class="wrap">

<header id="hdr">
  <h1>repo-tour digest</h1>
  <div class="root">${escapeHtml(m.root)}</div>
  <div class="stages">
    ${m.stagesRun.map((s) => `<span class="chip">${escapeHtml(s)}</span>`).join('')}
    ${m.stagesNotBuilt.map((s) => `<span class="chip off">${escapeHtml(s)} — not built</span>`).join('')}
  </div>
  ${replayBtn}
</header>

<div class="note">
  <strong>Nothing on this page was written by a model.</strong> Stages 1, 2, 3 and 5 are
  deterministic and complete; stage 4 — interpret, the only stage that spends tokens — is
  not built. Every number here was read off a parser or off git.
</div>

<div class="grid" id="cards">
  <div class="card"><h3>Repositories</h3><div class="big">${m.repos.length}</div>
    <div class="sub">discovered structurally, at any depth</div></div>
  <div class="card"><h3>Files</h3><div class="big">${m.counts.files.toLocaleString()}</div>
    <div class="sub">${m.counts.parsed.toLocaleString()} parsed for symbols</div></div>
  <div class="card"><h3>Symbols</h3><div class="big">${m.counts.symbols.toLocaleString()}</div>
    <div class="sub">${m.counts.edges.toLocaleString()} import edges</div></div>
  <div class="card"><h3>Tokens spent</h3><div class="big">0</div>
    <div class="sub">${wall} wall clock · stage 4 not built</div></div>
</div>

<h2>Import graph coverage</h2>
<div class="note" id="coverage">
  <strong>${covPct}%</strong> — ${cov.resolvedInternal.toLocaleString()} of
  ${cov.totalImports.toLocaleString()} imports resolved to a real file inside the tree;
  ${cov.leftTheTree.toLocaleString()} left it.
  ${escapeHtml(cov.note)}
  ${cov.filesWithParseErrors > 0 ? `<br><br>${cov.filesWithParseErrors} file(s) had at least one parse error and should not be trusted downstream.` : ''}
</div>

<h2>Repositories</h2>
<div class="scroll" id="repos"><table>
  <thead><tr><th>Root</th><th class="num">Commits</th><th>HEAD</th><th>Branch</th><th></th></tr></thead>
  <tbody>${repoRows}</tbody>
</table></div>

<h2>Classification</h2>
<div class="scroll" id="classification"><table>
  <thead><tr><th>Class</th><th class="num">Files</th><th class="num">Share</th></tr></thead>
  <tbody>${classRows}</tbody>
</table></div>

<h2>Ranked files</h2>
<div class="controls" id="controls">
  <input type="search" id="q" placeholder="filter by path…" aria-label="filter by path">
  <select id="cls" aria-label="filter by classification">${optionTags}</select>
  <span class="sub" id="count"></span>
</div>
${dropped > 0 ? `<div class="note">Showing the top ${rows.length.toLocaleString()} of
  ${result.ranked.length.toLocaleString()} ranked files. <strong>${dropped.toLocaleString()} rows are not
  embedded</strong> — this page is capped so it stays a single openable file, not because
  those files were ignored. The full ranking is in <code>.repo-tour/ranked.json</code>.</div>` : ''}
<div class="scroll"><table>
  <thead><tr>
    <th class="num">#</th>
    <th class="num s" data-k="score">Score</th>
    <th class="num s" data-k="churn">Churn</th>
    <th class="num s" data-k="inDegree">In</th>
    <th class="num s" data-k="loc">LOC</th>
    <th class="s" data-k="classification">Class</th>
    <th class="s" data-k="language">Lang</th>
    <th class="s" data-k="path">Path</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<div class="sub" style="margin-top:8px">Click any row to see why it scored what it did.</div>

<footer>
  Generated ${escapeHtml(m.generatedAt)} · schema v${m.schemaVersion} ·
  weights: churn 0.45, in-degree 0.35, size 0.20, then × the classification multiplier ·
  ${m.counts.deepSlice.toLocaleString()} files would enter stage 4 when it exists
</footer>

</div>
<script>window.__DIGEST__ = ${embedJson({ rows })};</script>
<script>${SCRIPT}</script>
${tourJs}
</body>
</html>`;
}
