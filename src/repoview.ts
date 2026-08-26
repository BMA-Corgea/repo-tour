/**
 * The repo page — a browsable, GitHub-shaped view of a repository, with the tour
 * played over the ACTUAL CODE.
 *
 * This replaces the metrics dashboard as the product surface. Score, churn and in-degree
 * still decide the itinerary, but they are not on the screen: a person reading a repo for
 * the first time wants the code and a guide, not the guide's scoring rubric.
 *
 * Self-contained: the file tree, the file contents, the highlighter and the tour engine
 * are all inlined. It opens offline, from a file:// URL, with no network at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DigestResult } from './digest.js';
import type { CodeStep } from './codetour.js';

export interface RepoViewOptions {
  steps: Array<CodeStep & { interpreted?: boolean }>;
  itinerary: string[];
  /** cap on embedded file count and total bytes, so the page stays one openable file */
  maxFiles?: number;
  maxBytes?: number;
}

interface EmbeddedFile {
  path: string;
  text: string;
  language: string | null;
  loc: number;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function readAsset(name: string): string {
  return fs.readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');
}

const STYLE = `
:root {
  --bg:#ffffff; --canvas:#f6f8fa; --ink:#1f2328; --muted:#59636e; --line:#d1d9e0;
  --accent:#0969da; --hl:#fff8c5; --hl-line:#eed888; --chip:#eaeef2;
  --kw:#cf222e; --str:#0a3069; --com:#59636e; --num:#0550ae; --fn:#8250df; --dec:#953800;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0d1117; --canvas:#010409; --ink:#e6edf3; --muted:#9198a1; --line:#3d444d;
    --accent:#4493f8; --hl:#3a2d0b; --hl-line:#9e7b0d; --chip:#212830;
    --kw:#ff7b72; --str:#a5d6ff; --com:#9198a1; --num:#79c0ff; --fn:#d2a8ff; --dec:#ffa657;
  }
}
:root[data-theme="dark"] {
  --bg:#0d1117; --canvas:#010409; --ink:#e6edf3; --muted:#9198a1; --line:#3d444d;
  --accent:#4493f8; --hl:#3a2d0b; --hl-line:#9e7b0d; --chip:#212830;
  --kw:#ff7b72; --str:#a5d6ff; --com:#9198a1; --num:#79c0ff; --fn:#d2a8ff; --dec:#ffa657;
}
* { box-sizing:border-box; }
html,body { height:100%; }
body {
  margin:0; background:var(--canvas); color:var(--ink);
  font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Noto Sans, Helvetica, Arial, sans-serif;
}
.topbar {
  background:var(--bg); border-bottom:1px solid var(--line); padding:14px 20px 0;
  position:sticky; top:0; z-index:5;
}
.repoline { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.repoline .owner { color:var(--accent); font-size:19px; }
.repoline .sep { color:var(--muted); font-size:19px; }
.repoline .name { color:var(--accent); font-size:19px; font-weight:600; }
.chip {
  font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid var(--line);
  color:var(--muted); background:transparent;
}
.tabs { display:flex; gap:18px; margin-top:14px; }
.tab { padding:8px 2px 10px; font-size:14px; color:var(--ink); border-bottom:2px solid transparent; }
.tab.on { border-bottom-color:#fd8c73; font-weight:600; }
.tab.off { color:var(--muted); }
.layout {
  display:grid; grid-template-columns:270px minmax(0,1fr); gap:16px;
  padding:16px 20px 40px; align-items:start;
}
.layout.touring { grid-template-columns:270px minmax(0,1fr) 400px; }
@media (max-width:1200px) { .layout.touring { grid-template-columns:minmax(0,1fr) 380px; } .layout.touring .files { display:none; } }
@media (max-width:900px) {
  .layout, .layout.touring { grid-template-columns:minmax(0,1fr); }
  .tree { max-height:220px; }
  .layout.touring .files { display:block; }
}
.panel { background:var(--bg); border:1px solid var(--line); border-radius:6px; overflow:hidden; }
.panel > h3 {
  margin:0; padding:9px 14px; font-size:13px; font-weight:600;
  border-bottom:1px solid var(--line); background:var(--bg);
}
.tree { max-height:calc(100vh - 190px); overflow:auto; padding:6px 0; }
.tree .row {
  display:flex; align-items:center; gap:7px; padding:3px 12px; cursor:pointer;
  font-size:13px; white-space:nowrap; color:var(--ink);
}
.tree .row:hover { background:var(--chip); }
.tree .row.on { background:var(--chip); font-weight:600; }
.tree .row.dim { color:var(--muted); cursor:default; }
.tree .row.dim:hover { background:transparent; }
.tree .ic { width:14px; text-align:center; color:var(--muted); flex:none; }
.filehead {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  padding:9px 14px; border-bottom:1px solid var(--line); background:var(--bg); flex-wrap:wrap;
}
.crumb { font-size:14px; }
.crumb b { font-weight:600; }
.crumb .d { color:var(--accent); }
.filemeta { color:var(--muted); font-size:12px; }
.code { overflow:auto; max-height:calc(100vh - 210px); position:relative; background:var(--bg); }
table.src { border-collapse:collapse; width:100%; font:12px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
table.src td { padding:0; vertical-align:top; }
td.gut {
  width:1%; min-width:52px; text-align:right; padding:0 12px 0 14px; color:var(--muted);
  user-select:none; position:sticky; left:0; background:var(--bg); border-right:1px solid transparent;
}
td.ln { padding-right:20px; white-space:pre; }
tr.hit td.gut { background:var(--hl); border-right-color:var(--hl-line); color:var(--ink); }
tr.hit td.ln { background:var(--hl); }
.k{color:var(--kw)} .s{color:var(--str)} .c{color:var(--com);font-style:italic}
.n{color:var(--num)} .f{color:var(--fn)} .d{color:var(--dec)}
.empty { padding:40px 16px; text-align:center; color:var(--muted); font-size:13px; }
#range { position:absolute; pointer-events:none; left:0; right:0; z-index:1; }
.bar { display:flex; gap:8px; align-items:center; padding:10px 20px; background:var(--bg); border-bottom:1px solid var(--line); flex-wrap:wrap; }
.btn {
  font:inherit; font-size:13px; font-weight:500; padding:5px 14px; border-radius:6px; cursor:pointer;
  border:1px solid var(--line); background:var(--chip); color:var(--ink);
}
.btn.primary { background:#1f883d; border-color:#1f883d; color:#fff; }
.btn:hover { filter:brightness(1.06); }
.said { color:var(--muted); font-size:12px; }

/* The guide is DOCKED, not floating. An explanation worth reading needs a column, not a
   tooltip — and a docked panel leaves the code fully visible and scrollable beside it. */
#guide { display:none; position:sticky; top:96px; }
.layout.touring #guide { display:block; }
#guide .gbody { padding:16px 18px 18px; }
#guide .gstep { font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--muted); font-weight:600; }
#guide h2 {
  margin:6px 0 4px; font-size:17px; font-weight:600; letter-spacing:-0.01em;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
#guide .gwhere { font-size:12px; color:var(--muted); margin-bottom:12px; }
#guide .gtext { font-size:14px; line-height:1.65; white-space:pre-wrap; }
#guide .gtext.plain { color:var(--muted); font-style:italic; }
#guide .gnav { display:flex; gap:8px; align-items:center; margin-top:18px; padding-top:14px; border-top:1px solid var(--line); }
#guide .gnav .spacer { flex:1; }
#guide .gsrc { margin-top:12px; font-size:11px; color:var(--muted); }
.progress { height:3px; background:var(--line); border-radius:2px; overflow:hidden; margin-top:10px; }
.progress i { display:block; height:100%; background:var(--accent); transition:width .25s ease; }
`;

const HIGHLIGHTER = `
var KW = {
  python: /\\b(False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|self|cls)\\b/g,
  js: /\\b(abstract|any|as|async|await|boolean|break|case|catch|class|const|constructor|continue|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|null|number|of|private|protected|public|readonly|return|set|static|string|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|yield)\\b/g
};
function tokenize(text, lang) {
  var py = lang === 'python';
  var kw = py ? KW.python : KW.js;
  // order matters: comments and strings win over everything
  var re = py
    ? /(#[^\\n]*)|("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*')|(@[A-Za-z_][\\w.]*)|(\\b\\d[\\d_.]*\\b)|((?:def|class)\\s+)([A-Za-z_]\\w*)/g
    : /(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\\\\\`])*\`)|(@[A-Za-z_][\\w.]*)|(\\b\\d[\\d_.]*\\b)|((?:function|class|interface|type)\\s+)([A-Za-z_$][\\w$]*)/g;
  var out = '', last = 0, m;
  function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function plain(s){
    return esc(s).replace(kw, function(w){ return '<span class="k">' + w + '</span>'; });
  }
  while ((m = re.exec(text)) !== null) {
    out += plain(text.slice(last, m.index));
    if (m[1]) out += '<span class="c">' + esc(m[1]) + '</span>';
    else if (m[2]) out += '<span class="s">' + esc(m[2]) + '</span>';
    else if (m[3]) out += '<span class="d">' + esc(m[3]) + '</span>';
    else if (m[4]) out += '<span class="n">' + esc(m[4]) + '</span>';
    else if (m[5]) out += plain(m[5]) + '<span class="f">' + esc(m[6]) + '</span>';
    last = re.lastIndex;
  }
  out += plain(text.slice(last));
  return out;
}
// Close and reopen spans at every newline so splitting into <tr> rows cannot break the HTML.
function highlightLines(text, lang) {
  var html = tokenize(text, lang);
  var openClass = null, out = [], buf = '';
  var re = /(<span class="(\\w)">)|(<\\/span>)|(\\n)|([^<\\n]+|<)/g, m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) { openClass = m[2]; buf += m[1]; }
    else if (m[3]) { openClass = null; buf += m[3]; }
    else if (m[4]) {
      if (openClass) buf += '</span>';
      out.push(buf);
      buf = openClass ? '<span class="' + openClass + '">' : '';
    } else buf += m[5];
  }
  out.push(buf);
  return out;
}
`;

const APP = `
(function () {
  var D = window.__REPO__;
  var files = D.files;
  var byPath = {};
  for (var i = 0; i < files.length; i++) byPath[files[i].path] = files[i];

  var treeEl = document.getElementById('tree');
  var codeEl = document.getElementById('code');
  var crumbEl = document.getElementById('crumb');
  var metaEl = document.getElementById('filemeta');
  var rangeEl = document.getElementById('range');
  var current = null;

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ---- tree
  var dirs = {};
  files.forEach(function (f) {
    var parts = f.path.split('/');
    for (var i = 0; i < parts.length - 1; i++) {
      var d = parts.slice(0, i + 1).join('/');
      dirs[d] = true;
    }
  });
  var nodes = Object.keys(dirs).map(function (d) { return { p: d, dir: true }; })
    .concat(files.map(function (f) { return { p: f.path, dir: false }; }));
  nodes.sort(function (a, b) {
    var A = a.p.split('/'), B = b.p.split('/');
    for (var i = 0; i < Math.max(A.length, B.length); i++) {
      var x = A[i], y = B[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (x !== y) {
        var xd = i < A.length - 1 || a.dir, yd = i < B.length - 1 || b.dir;
        if (xd !== yd) return xd ? -1 : 1;
        return x < y ? -1 : 1;
      }
    }
    return 0;
  });
  treeEl.innerHTML = nodes.map(function (nd) {
    var depth = nd.p.split('/').length - 1;
    var name = nd.p.split('/').pop();
    var pad = 12 + depth * 14;
    if (nd.dir) {
      return '<div class="row dim" style="padding-left:' + pad + 'px"><span class="ic">▸</span>' + esc(name) + '</div>';
    }
    return '<div class="row" data-p="' + esc(nd.p) + '" style="padding-left:' + pad + 'px"><span class="ic">·</span>' + esc(name) + '</div>';
  }).join('');

  treeEl.addEventListener('click', function (e) {
    var row = e.target.closest('.row[data-p]');
    if (row) open(row.getAttribute('data-p'));
  });

  // ---- file rendering
  function open(p, opts) {
    var f = byPath[p];
    if (!f) return;
    if (current !== p) {
      current = p;
      var lang = f.language === 'python' ? 'python' : 'js';
      var lines = highlightLines(f.text, lang);
      var rows = '';
      for (var i = 0; i < lines.length; i++) {
        rows += '<tr id="L' + (i + 1) + '"><td class="gut">' + (i + 1) + '</td><td class="ln">' + (lines[i] || ' ') + '</td></tr>';
      }
      codeEl.innerHTML = '<div id="range"></div><table class="src"><tbody>' + rows + '</tbody></table>';
      rangeEl = document.getElementById('range');

      var parts = p.split('/');
      crumbEl.innerHTML = parts.map(function (s, i) {
        return i === parts.length - 1 ? '<b>' + esc(s) + '</b>' : '<span class="d">' + esc(s) + '</span>';
      }).join(' / ');
      metaEl.textContent = f.loc.toLocaleString() + ' lines' + (f.language ? ' · ' + f.language : '');

      var rows2 = treeEl.querySelectorAll('.row');
      for (var j = 0; j < rows2.length; j++) rows2[j].classList.toggle('on', rows2[j].getAttribute('data-p') === p);
      var on = treeEl.querySelector('.row.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
    if (opts && opts.from) mark(opts.from, opts.to);
  }

  function mark(from, to) {
    var hits = codeEl.querySelectorAll('tr.hit');
    for (var i = 0; i < hits.length; i++) hits[i].classList.remove('hit');
    var first = null, last = null;
    for (var L = from; L <= to; L++) {
      var tr = document.getElementById('L' + L);
      if (!tr) continue;
      tr.classList.add('hit');
      if (!first) first = tr;
      last = tr;
    }
    if (!first) return null;
    // Park an invisible element exactly over the range for the tour to spotlight.
    var top = first.offsetTop, bottom = last.offsetTop + last.offsetHeight;
    rangeEl.style.top = top + 'px';
    rangeEl.style.height = (bottom - top) + 'px';
    codeEl.scrollTop = Math.max(0, top - Math.min(140, codeEl.clientHeight / 3));
    return rangeEl;
  }

  window.__repo = { open: open, mark: mark };
  open(D.start);
})();
`;

const TOUR_BOOTSTRAP = `
(function () {
  var defs = window.__STEPS__ || [];
  var layout = document.querySelector('.layout');
  var btn = document.getElementById('start');
  if (!defs.length || !layout || !btn) return;

  var el = {
    step: document.getElementById('gstep'), title: document.getElementById('gtitle'),
    where: document.getElementById('gwhere'), text: document.getElementById('gtext'),
    bar: document.getElementById('gbar'), src: document.getElementById('gsrc'),
    back: document.getElementById('gback'), next: document.getElementById('gnext'),
    end: document.getElementById('gend')
  };
  var i = -1;

  function show(n) {
    if (n < 0 || n >= defs.length) return;
    i = n;
    var s = defs[n];
    window.__repo.open(s.file, { from: s.startLine, to: s.endLine });
    el.step.textContent = 'Stop ' + (n + 1) + ' of ' + defs.length;
    el.title.textContent = s.title;
    el.where.textContent = s.file + '  ·  lines ' + s.startLine + '\u2013' + s.endLine;
    el.text.textContent = s.text;
    el.text.classList.toggle('plain', !s.interpreted);
    el.src.textContent = s.interpreted
      ? 'Written by reading these lines.'
      : 'Structural facts only \u2014 this stop was not interpreted.';
    el.bar.style.width = Math.round(((n + 1) / defs.length) * 100) + '%';
    el.back.disabled = n === 0;
    el.next.textContent = n === defs.length - 1 ? 'Finish' : 'Next';
  }

  function start() { layout.classList.add('touring'); show(0); }
  function stop() {
    layout.classList.remove('touring');
    var hits = document.querySelectorAll('tr.hit');
    for (var k = 0; k < hits.length; k++) hits[k].classList.remove('hit');
    i = -1;
  }

  btn.addEventListener('click', start);
  el.next.addEventListener('click', function () { i === defs.length - 1 ? stop() : show(i + 1); });
  el.back.addEventListener('click', function () { show(i - 1); });
  el.end.addEventListener('click', stop);
  document.addEventListener('keydown', function (e) {
    if (i < 0) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); i === defs.length - 1 ? stop() : show(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(i - 1); }
    else if (e.key === 'Escape') stop();
  });
})();
`;

export function renderRepoView(result: DigestResult, opts: RepoViewOptions): string {
  const m = result.manifest;
  const root = m.root;
  const repoName = path.basename(root) || root;
  const maxFiles = opts.maxFiles ?? 160;
  const maxBytes = opts.maxBytes ?? 3_500_000;

  const fileByPath = new Map(result.inventory.files.map((f) => [f.path, f] as const));
  const rankOrder = result.ranked.map((r) => r.path);

  // Tooling state is not the repo. A person reading autoSQL for the first time does not
  // want .autodev tickets or editor config in the tree — those are about the process that
  // built the code, not the code.
  const TOOL_DIRS = ['.autodev/', '.claude/', '.github/', '.vscode/', '.idea/', '.pytest_cache/'];
  const isToolNoise = (p: string): boolean => TOOL_DIRS.some((d) => p.startsWith(d) || p.includes(`/${d}`));

  // Itinerary first (the tour cannot work without them), then the rest of the readable
  // tree in rank order until the caps bite.
  const wanted: string[] = [...opts.itinerary];
  for (const p of rankOrder) {
    if (wanted.length >= maxFiles) break;
    if (wanted.includes(p)) continue;
    const f = fileByPath.get(p);
    if (!f || f.binary || f.loc <= 0) continue;
    if (f.classification === 'generated' || f.classification === 'vendored' || f.classification === 'lockfile') continue;
    if (f.bytes > 400_000) continue;
    if (isToolNoise(p)) continue;
    wanted.push(p);
  }

  const embedded: EmbeddedFile[] = [];
  let bytes = 0;
  for (const p of wanted) {
    const f = fileByPath.get(p);
    if (!f) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(root, p), 'utf8'); } catch { continue; }
    if (bytes + text.length > maxBytes && !opts.itinerary.includes(p)) continue;
    bytes += text.length;
    embedded.push({ path: p, text, language: f.language, loc: f.loc });
  }

  const repo = m.repos.find((r) => r.root === '');
  const start = opts.steps[0]?.file ?? embedded[0]?.path ?? '';
  const shown = embedded.length;
  const total = result.inventory.files.length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(repoName)} — repo-tour</title>
<style>${STYLE}</style>
</head>
<body>

<div class="topbar">
  <div class="repoline">
    <span class="owner">${escapeHtml(path.basename(path.dirname(root)) || 'local')}</span>
    <span class="sep">/</span>
    <span class="name">${escapeHtml(repoName)}</span>
    <span class="chip">${repo?.branch ? escapeHtml(repo.branch) : 'no branch'}</span>
    <span class="chip">${repo ? repo.commitCount.toLocaleString() : 0} commits</span>
  </div>
  <div class="tabs">
    <span class="tab on">Code</span>
    <span class="tab off">Issues</span>
    <span class="tab off">Pull requests</span>
    <span class="tab off">Actions</span>
  </div>
</div>

<div class="bar">
  <button id="start" class="btn primary" type="button">▶ Take the tour</button>
  <span class="said">${opts.steps.length} stops through ${opts.itinerary.length} ${opts.itinerary.length === 1 ? 'file' : 'files'} — the ones that actually carry this repo.</span>
  <span class="said">·</span>
  <span class="said">${shown.toLocaleString()} of ${total.toLocaleString()} files browsable here; generated, vendored and binary content is left out.</span>
</div>

<div class="layout">
  <div class="panel files">
    <h3>Files</h3>
    <div class="tree" id="tree"></div>
  </div>
  <div class="panel">
    <div class="filehead">
      <span class="crumb" id="crumb"></span>
      <span class="filemeta" id="filemeta"></span>
    </div>
    <div class="code" id="code"><div class="empty">Pick a file.</div></div>
  </div>

  <div class="panel" id="guide">
    <h3>The tour</h3>
    <div class="gbody">
      <div class="gstep" id="gstep"></div>
      <h2 id="gtitle"></h2>
      <div class="gwhere" id="gwhere"></div>
      <div class="gtext" id="gtext"></div>
      <div class="progress"><i id="gbar"></i></div>
      <div class="gnav">
        <button class="btn" id="gback" type="button">Back</button>
        <button class="btn primary" id="gnext" type="button">Next</button>
        <span class="spacer"></span>
        <button class="btn" id="gend" type="button">End tour</button>
      </div>
      <div class="gsrc" id="gsrc"></div>
    </div>
  </div>
</div>

<script>window.__REPO__ = ${embedJson({ files: embedded, start })};</script>
<script>window.__STEPS__ = ${embedJson(opts.steps)};</script>
<script>${HIGHLIGHTER}</script>
<script>${APP}</script>
<script>${TOUR_BOOTSTRAP}</script>
</body>
</html>`;
}
