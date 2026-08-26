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
import type { Architecture } from './architecture.js';

export interface RepoViewOptions {
  steps: Array<CodeStep & { interpreted?: boolean }>;
  /** when present, the tour opens with the system diagram */
  architecture?: Architecture;
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


/**
 * The system diagram.
 *
 * Rows are layers of the import graph: the pieces nothing imports sit at the top (the ways
 * in), the pieces everything leans on sit at the bottom. That is the one thing a folder
 * listing can never show you, so it is the thing the picture is built around.
 *
 * Drawn as inline SVG with a viewBox, so it scales to the pane and needs no library.
 */
function architectureSvg(arch: Architecture): string {
  if (arch.subsystems.length < 2) return '';
  const W = 1000;
  const ROW = 132;
  const BOX_H = 74;
  const byPath = new Map(arch.subsystems.map((s) => [s.path, s] as const));

  const pos = new Map<string, { x: number; y: number; w: number }>();
  arch.layers.forEach((row, li) => {
    const n = row.length;
    const gap = 22;
    const w = Math.max(120, Math.min(230, (W - 60 - gap * (n - 1)) / n));
    const total = n * w + gap * (n - 1);
    let x = (W - total) / 2;
    for (const p of row) {
      pos.set(p, { x, y: 30 + li * ROW, w });
      x += w + gap;
    }
  });

  const H = 30 + arch.layers.length * ROW;
  const parts: string[] = [];

  parts.push(
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`,
  );

  // edges first, so boxes sit on top of them
  for (const e of arch.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const ax = a.x + a.w / 2;
    const bx = b.x + b.w / 2;
    const sameRow = a.y === b.y;
    const ay = sameRow ? a.y + BOX_H / 2 : a.y + BOX_H;
    const by = sameRow ? b.y + BOX_H / 2 : b.y;
    const midY = sameRow ? ay - 46 : (ay + by) / 2;
    // A straight vertical line between two boxes in the same column passes behind every
    // box between them and reads as an arrow going *through* things. Bow it out sideways.
    const column = Math.abs(ax - bx) < 4;
    const bow = column ? Math.max(a.w, b.w) / 2 + 34 : 0;
    const d = sameRow
      ? `M ${ax} ${ay} C ${ax - 40} ${midY}, ${bx + 40} ${midY}, ${bx} ${by}`
      : `M ${ax} ${ay} C ${ax + bow} ${midY}, ${bx + bow} ${midY}, ${bx} ${by}`;
    const weight = Math.min(4, 1 + Math.log2(e.count));
    parts.push(
      `<g class="edge" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}">` +
      `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${weight.toFixed(1)}" marker-end="url(#ah)"/>` +
      `<text x="${((ax + bx) / 2 + bow * 0.75).toFixed(0)}" y="${(midY - 4).toFixed(0)}" text-anchor="middle" class="ecount">${e.count}</text>` +
      `</g>`,
    );
  }

  for (const [p, box] of pos) {
    const s = byPath.get(p)!;
    const label = p.split('/').slice(-1)[0] || p;
    const sub = `${s.fileCount} files · ${s.loc.toLocaleString()} loc`;
    parts.push(
      `<g class="node" data-part="${escapeHtml(p)}">` +
      `<rect x="${box.x.toFixed(0)}" y="${box.y}" width="${box.w.toFixed(0)}" height="${BOX_H}" rx="8"/>` +
      `<text x="${(box.x + box.w / 2).toFixed(0)}" y="${box.y + 28}" text-anchor="middle" class="nlabel">${escapeHtml(label)}</text>` +
      `<text x="${(box.x + box.w / 2).toFixed(0)}" y="${box.y + 47}" text-anchor="middle" class="nsub">${escapeHtml(sub)}</text>` +
      (s.kind === 'repo'
        ? `<text x="${(box.x + box.w / 2).toFixed(0)}" y="${box.y + 63}" text-anchor="middle" class="nsub">own repo</text>`
        : '') +
      `</g>`,
    );
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="archsvg" role="img" aria-label="System diagram">${parts.join('')}</svg>`;
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
  display:grid; grid-template-columns:270px minmax(0,1fr) 400px; gap:16px;
  padding:16px 20px 40px; align-items:start;
}
@media (max-width:1240px) { .layout { grid-template-columns:minmax(0,1fr) 380px; } .layout .files { display:none; } }
@media (max-width:900px) {
  .layout { grid-template-columns:minmax(0,1fr); }
  .tree { max-height:220px; }
  .layout .files { display:block; }
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
.bar.snapshot { padding:7px 20px; background:var(--canvas); }
.bar.snapshot b { color:var(--ink); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.bar.snapshot code { background:var(--chip); padding:1px 6px; border-radius:4px; font-size:11px; }

/* The side column is DOCKED, not floating. An explanation worth reading needs a column,
   not a tooltip — and a docked panel leaves the code fully visible beside it. */
#side { position:sticky; top:96px; }
.tabsrow { display:flex; border-bottom:1px solid var(--line); }
.stab {
  font:inherit; font-size:13px; font-weight:500; padding:10px 14px; cursor:pointer;
  background:transparent; border:0; border-bottom:2px solid transparent; color:var(--muted);
}
.stab.on { color:var(--ink); font-weight:600; border-bottom-color:#fd8c73; }
.stab .pill {
  display:inline-block; min-width:18px; padding:0 5px; margin-left:5px; border-radius:9px;
  background:var(--chip); color:var(--ink); font-size:11px; font-weight:600;
}
#guide, #notes { display:none; }
#guide.on, #notes.on { display:block; }
#guide .gidle { padding:20px 18px; color:var(--muted); font-size:13px; line-height:1.6; }
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

/* The system diagram. Rows are layers of the import graph: ways in at the top, the things
   everything leans on at the bottom — the one thing a folder listing can never show. */
#archpanel { display:none; }
#archpanel.on { display:block; }
.archwrap { padding:18px 16px; overflow:auto; max-height:calc(100vh - 210px); color:var(--muted); }
.archsvg { width:100%; height:auto; display:block; }
.archsvg .node rect { fill:var(--chip); stroke:var(--line); stroke-width:1.5; cursor:pointer; transition:opacity .2s, stroke .2s; }
.archsvg .node:hover rect { stroke:var(--accent); }
.archsvg .nlabel { fill:var(--ink); font:600 14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.archsvg .nsub { fill:var(--muted); font:11px -apple-system,system-ui,sans-serif; }
.archsvg .ecount { fill:var(--muted); font:10px -apple-system,system-ui,sans-serif; }
.archsvg .edge { color:var(--muted); opacity:.55; }
.archsvg.focused .node { opacity:.32; }
.archsvg.focused .node.on { opacity:1; }
.archsvg.focused .node.on rect { stroke:var(--accent); stroke-width:2.5; }
.archsvg.focused .edge { opacity:.12; }
.archsvg.focused .edge.on { opacity:1; color:var(--accent); }
.archnote { font-size:12px; margin-top:12px; }

/* Notes. Every note remembers the stop that provoked it — that provenance is the whole
   point: a review comment that can say WHICH explanation prompted the question is a
   different kind of comment from "looks good to me". */
#notes .nbody { padding:14px 16px 16px; }
.anchor {
  font-size:12px; padding:8px 10px; border:1px solid var(--line); border-radius:6px;
  background:var(--canvas); margin-bottom:10px; display:flex; gap:8px; align-items:baseline;
}
.anchor .a-what { flex:1; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--ink); }
.anchor .a-none { color:var(--muted); font-style:italic; font-family:inherit; }
.anchor .a-from { color:var(--muted); }
#ntext {
  width:100%; min-height:88px; resize:vertical; font:inherit; font-size:13px; line-height:1.55;
  padding:9px 11px; border-radius:6px; border:1px solid var(--line);
  background:var(--bg); color:var(--ink);
}
.nrow { display:flex; gap:8px; align-items:center; margin-top:9px; flex-wrap:wrap; }
.nrow .spacer { flex:1; }
.nlist { margin-top:16px; border-top:1px solid var(--line); max-height:44vh; overflow:auto; }
.note { padding:11px 0; border-bottom:1px solid var(--line); }
.note:last-child { border-bottom:0; }
.note .prov { font-size:11px; color:var(--muted); margin-bottom:5px; }
.note .prov b { color:var(--accent); font-weight:600; cursor:pointer; }
.note .prov b:hover { text-decoration:underline; }
.note .staleflag { color:var(--warn); }
.note .quote {
  font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--muted);
  border-left:2px solid var(--line); padding-left:8px; margin:0 0 6px; white-space:pre-wrap;
  overflow:hidden; text-overflow:ellipsis;
}
.note .body { font-size:13px; line-height:1.55; white-space:pre-wrap; }
.note .del { float:right; cursor:pointer; color:var(--muted); font-size:14px; line-height:1; border:0; background:none; }
.note .del:hover { color:#cf222e; }
.nempty { color:var(--muted); font-size:13px; line-height:1.6; padding:14px 0 4px; }

/* Clicking a line number anchors a note to it; shift-click extends the range. */
td.gut { cursor:pointer; }
td.gut:hover { color:var(--accent); text-decoration:underline; }
tr.sel td.gut { background:var(--accent); color:#fff; }
tr.sel td.ln { background:color-mix(in srgb, var(--accent) 12%, transparent); }
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

  // Clicking a line number anchors a note to it; shift-click extends the range.
  var selFrom = null, selTo = null;
  function paintSel() {
    var was = codeEl.querySelectorAll('tr.sel');
    for (var i = 0; i < was.length; i++) was[i].classList.remove('sel');
    if (selFrom == null) return;
    for (var L = Math.min(selFrom, selTo); L <= Math.max(selFrom, selTo); L++) {
      var tr = document.getElementById('L' + L);
      if (tr) tr.classList.add('sel');
    }
  }
  codeEl.addEventListener('click', function (e) {
    var gut = e.target.closest('td.gut');
    if (!gut) return;
    var line = Number(gut.textContent.trim());
    if (!line) return;
    if (e.shiftKey && selFrom != null) selTo = line;
    else { selFrom = line; selTo = line; }
    paintSel();
    window.__notes.anchorFromSelection(current, Math.min(selFrom, selTo), Math.max(selFrom, selTo));
  });
  function clearSel() { selFrom = null; selTo = null; paintSel(); }

  window.__repo = {
    open: open, mark: mark, clearSel: clearSel,
    current: function () { return current; },
    lineText: function (file, from, to) {
      var f = byPath[file];
      if (!f) return '';
      return f.text.split(/\\r?\\n/).slice(from - 1, Math.min(to, from + 2)).join('\\n');
    }
  };
  open(D.start);
})();
`;


const NOTES = `
(function () {
  var R = window.__REPO__ || {};
  var repo = R.repo || { name: 'repo', head: null };
  // Keyed to the REPO, not the commit. Notes are review material: losing them because a
  // new tour was generated would defeat the point. Each note records the commit it was
  // taken at instead, so one from older code is labelled rather than silently trusted.
  var KEY = 'repotour:notes:' + repo.name;

  var el = {
    what: document.getElementById('a-what'), from: document.getElementById('a-from'),
    text: document.getElementById('ntext'), save: document.getElementById('nsave'),
    clear: document.getElementById('nclear'), list: document.getElementById('nlist'),
    count: document.getElementById('ncount'), hint: document.getElementById('nhint'),
    copy: document.getElementById('ncopy'), dl: document.getElementById('ndl'), dlj: document.getElementById('ndlj')
  };

  var notes = [];
  // localStorage can throw outright (private windows, blocked site data). Notes are worth
  // keeping but never worth breaking the page for.
  try { notes = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { notes = []; }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch (e) {} }

  var anchor = null;

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function showAnchor() {
    if (!anchor) {
      el.what.textContent = 'nothing selected';
      el.what.classList.add('a-none');
      el.from.textContent = '';
      el.hint.textContent = 'click a line number to anchor';
      return;
    }
    el.what.classList.remove('a-none');
    el.what.textContent = anchor.file + ':' + anchor.startLine +
      (anchor.endLine !== anchor.startLine ? '\\u2013' + anchor.endLine : '');
    el.from.textContent = anchor.stopTitle ? 'from stop ' + (anchor.stopIndex + 1) + ' \\u00b7 ' + anchor.stopTitle : '';
    el.hint.textContent = anchor.stopTitle ? 'this note will remember the stop' : 'shift-click a line number to extend';
  }

  function render() {
    el.count.textContent = String(notes.length);
    if (!notes.length) {
      el.list.innerHTML = '<div class="nempty">No notes yet. Click a line number to anchor one, ' +
        'or press <b>+ Note on this stop</b> during the tour \\u2014 the note remembers which ' +
        'explanation prompted it, which is what makes the review afterwards worth reading.</div>';
      return;
    }
    el.list.innerHTML = notes.map(function (nt, i) {
      var range = nt.startLine + (nt.endLine !== nt.startLine ? '\\u2013' + nt.endLine : '');
      var stale = nt.head && repo.head && nt.head !== repo.head;
      var prov = '<b data-jump="' + i + '">' + esc(nt.file) + ':' + range + '</b>' +
        (nt.stopTitle ? ' \\u00b7 from stop ' + (nt.stopIndex + 1) + ', ' + esc(nt.stopTitle) : ' \\u00b7 while browsing') +
        (stale ? ' \\u00b7 <span class="staleflag">taken at ' + esc(nt.head.slice(0, 8)) + ', code has moved</span>' : '');
      return '<div class="note">' +
        '<button class="del" data-del="' + i + '" title="delete">\\u00d7</button>' +
        '<div class="prov">' + prov + '</div>' +
        (nt.quote ? '<div class="quote">' + esc(nt.quote) + '</div>' : '') +
        '<div class="body">' + esc(nt.body) + '</div>' +
        '</div>';
    }).join('');
  }

  function markdown() {
    var out = ['# Review notes \\u2014 ' + repo.name +
      (repo.head ? ' @ ' + repo.head.slice(0, 10) : '') + '', ''];
    var byFile = {};
    notes.forEach(function (nt) { (byFile[nt.file] = byFile[nt.file] || []).push(nt); });
    Object.keys(byFile).sort().forEach(function (f) {
      out.push('## ' + f, '');
      byFile[f].sort(function (a, b) { return a.startLine - b.startLine; }).forEach(function (nt) {
        var range = 'L' + nt.startLine + (nt.endLine !== nt.startLine ? '-L' + nt.endLine : '');
        out.push('### ' + range + (nt.stopTitle ? '  \\u2014 prompted by tour stop ' + (nt.stopIndex + 1) + ', ' + nt.stopTitle : '') +
          (nt.head && repo.head && nt.head !== repo.head ? '  \\u2014 taken at ' + nt.head.slice(0, 8) + ', code has moved since' : ''));
        if (nt.explanation) out.push('', '> The tour said: ' + nt.explanation);
        if (nt.quote) out.push('', '\\u0060\\u0060\\u0060', nt.quote, '\\u0060\\u0060\\u0060');
        out.push('', nt.body, '');
      });
    });
    return out.join('\\n');
  }

  function refreshDownloads() {
    try {
      var md = new Blob([markdown()], { type: 'text/markdown' });
      el.dl.href = URL.createObjectURL(md);
      el.dl.download = repo.name + '-review-notes.md';
      var js = new Blob([JSON.stringify({ repo: repo, notes: notes }, null, 2)], { type: 'application/json' });
      el.dlj.href = URL.createObjectURL(js);
      el.dlj.download = repo.name + '-review-notes.json';
    } catch (e) {}
  }

  el.save.addEventListener('click', function () {
    var body = el.text.value.trim();
    if (!body) { el.text.focus(); return; }
    if (!anchor) { el.hint.textContent = 'anchor it first \\u2014 click a line number'; return; }
    notes.push({
      id: String(notes.length + 1) + '-' + anchor.startLine,
      file: anchor.file, startLine: anchor.startLine, endLine: anchor.endLine,
      stopIndex: anchor.stopIndex, stopTitle: anchor.stopTitle || null,
      explanation: anchor.explanation || null,
      head: repo.head || null,
      quote: window.__repo.lineText(anchor.file, anchor.startLine, anchor.endLine),
      body: body
    });
    el.text.value = '';
    persist(); render(); refreshDownloads();
  });

  el.clear.addEventListener('click', function () {
    anchor = null; window.__repo.clearSel(); showAnchor();
  });

  el.list.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (del) { notes.splice(Number(del.getAttribute('data-del')), 1); persist(); render(); refreshDownloads(); return; }
    var jump = e.target.closest('[data-jump]');
    if (jump) {
      var nt = notes[Number(jump.getAttribute('data-jump'))];
      if (nt) window.__repo.open(nt.file, { from: nt.startLine, to: nt.endLine });
    }
  });

  el.copy.addEventListener('click', function () {
    var md = markdown();
    var done = function () { el.copy.textContent = 'Copied'; setTimeout(function () { el.copy.textContent = 'Copy as Markdown'; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(md).then(done, done);
    else { el.text.value = md; done(); }
  });

  window.__notes = {
    anchorFromSelection: function (file, from, to) {
      anchor = { file: file, startLine: from, endLine: to, stopIndex: -1, stopTitle: null, explanation: null };
      showAnchor();
      openPane('notes');
      el.text.focus();
    },
    anchorFromStop: function (step, index) {
      if (!step.file) return; // an architecture stop has no lines to anchor to
      anchor = {
        file: step.file, startLine: step.startLine, endLine: step.endLine,
        stopIndex: index, stopTitle: step.title, explanation: step.text
      };
      showAnchor();
      openPane('notes');
      el.text.focus();
    }
  };

  render(); showAnchor(); refreshDownloads();
})();
`;

const TOUR_BOOTSTRAP = `
(function () {
  var defs = window.__STEPS__ || [];
  var layout = document.querySelector('.layout');
  var btn = document.getElementById('start');
  if (!layout) return;

  // --- tabs (available whether or not a tour is running)
  var panes = { guide: document.getElementById('guide'), notes: document.getElementById('notes') };
  var tabs = { guide: document.getElementById('tab-guide'), notes: document.getElementById('tab-notes') };
  window.openPane = function (name) {
    for (var k in panes) {
      panes[k].classList.toggle('on', k === name);
      tabs[k].classList.toggle('on', k === name);
    }
  };
  tabs.guide.addEventListener('click', function () { window.openPane('guide'); });
  tabs.notes.addEventListener('click', function () { window.openPane('notes'); });

  if (!defs.length || !btn) return;

  var el = {
    step: document.getElementById('gstep'), title: document.getElementById('gtitle'),
    where: document.getElementById('gwhere'), text: document.getElementById('gtext'),
    bar: document.getElementById('gbar'), src: document.getElementById('gsrc'),
    back: document.getElementById('gback'), next: document.getElementById('gnext'),
    end: document.getElementById('gend')
  };
  var i = -1;

  var codePanel = document.getElementById('codepanel');
  var archPanel = document.getElementById('archpanel');
  var svg = document.querySelector('.archsvg');

  function focusPart(part) {
    if (!svg) return;
    var nodes = svg.querySelectorAll('.node');
    var edges = svg.querySelectorAll('.edge');
    svg.classList.toggle('focused', !!part);
    for (var a = 0; a < nodes.length; a++) {
      nodes[a].classList.toggle('on', nodes[a].getAttribute('data-part') === part);
    }
    for (var b = 0; b < edges.length; b++) {
      var e = edges[b];
      e.classList.toggle('on', !!part && (e.getAttribute('data-from') === part || e.getAttribute('data-to') === part));
    }
  }

  // Clicking a box on the diagram drops you into that part's most-weighted file.
  if (svg) {
    svg.addEventListener('click', function (ev) {
      var g = ev.target.closest('.node');
      if (!g) return;
      var f = (window.__TOPFILE__ || {})[g.getAttribute('data-part')];
      if (f) { archPanel.classList.remove('on'); codePanel.style.display = ''; window.__repo.open(f); }
    });
  }

  function show(n) {
    if (n < 0 || n >= defs.length) return;
    i = n;
    var s = defs[n];
    if (s.architecture) {
      archPanel.classList.add('on');
      codePanel.style.display = 'none';
      focusPart(s.architecture.part);
    } else {
      archPanel.classList.remove('on');
      codePanel.style.display = '';
      window.__repo.open(s.file, { from: s.startLine, to: s.endLine });
    }
    el.step.textContent = 'Stop ' + (n + 1) + ' of ' + defs.length;
    el.title.textContent = s.title;
    el.where.textContent = s.architecture
      ? (s.architecture.part ? 'a part of the system' : 'the system as a whole')
      : s.file + '  ·  lines ' + s.startLine + '\u2013' + s.endLine;
    el.text.textContent = s.text;
    el.text.classList.toggle('plain', !s.interpreted);
    el.src.textContent = s.interpreted
      ? (s.architecture ? 'Written by reading the parts and how they import each other.' : 'Written by reading these lines.')
      : 'Structural facts only \u2014 this stop was not interpreted.';
    el.bar.style.width = Math.round(((n + 1) / defs.length) * 100) + '%';
    el.back.disabled = n === 0;
    el.next.textContent = n === defs.length - 1 ? 'Finish' : 'Next';
  }

  var idle = document.getElementById('gidle');
  var body = document.getElementById('gbody');

  function start() {
    layout.classList.add('touring');
    idle.style.display = 'none';
    body.style.display = '';
    window.openPane('guide');
    show(0);
  }
  function stop() {
    layout.classList.remove('touring');
    idle.style.display = '';
    body.style.display = 'none';
    archPanel.classList.remove('on');
    codePanel.style.display = '';
    focusPart(null);
    var hits = document.querySelectorAll('tr.hit');
    for (var k = 0; k < hits.length; k++) hits[k].classList.remove('hit');
    i = -1;
  }

  btn.addEventListener('click', start);
  document.getElementById('gnote').addEventListener('click', function () {
    window.__notes.anchorFromStop(defs[i], i);
  });
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
  const start = opts.steps.find((s) => s.file)?.file ?? embedded[0]?.path ?? '';
  const archSvg = opts.architecture ? architectureSvg(opts.architecture) : '';
  const archStops = opts.steps.filter((s) => s.architecture).length;
  const generatedAt = m.generatedAt;
  const topFileOf: Record<string, string> = {};
  for (const sub of opts.architecture?.subsystems ?? []) {
    if (sub.topFiles[0]) topFileOf[sub.path] = sub.topFiles[0].path;
  }
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
  <span class="said">${archStops > 0
    ? `${opts.steps.length} stops — ${archStops} on how the system fits together, then ${opts.steps.length - archStops} through the ${opts.itinerary.length} files that carry it.`
    : `${opts.steps.length} stops through ${opts.itinerary.length} ${opts.itinerary.length === 1 ? 'file' : 'files'} — the ones that actually carry this repo.`}</span>
  <span class="said">·</span>
  <span class="said">${shown.toLocaleString()} of ${total.toLocaleString()} files browsable here; generated, vendored and binary content is left out.</span>
</div>
<div class="bar snapshot">
  <span class="said">
    A snapshot of <b>${repo?.head ? escapeHtml(repo.head.slice(0, 10)) : 'an uncommitted tree'}</b>${repo?.branch ? ` on ${escapeHtml(repo.branch)}` : ''},
    taken ${escapeHtml(generatedAt.slice(0, 16).replace('T', ' '))}. Refreshing this page will never pick up new code —
    it does not look at the repository again. Re-run <code>repo-tour tour</code> for a fresh one.
  </span>
</div>

<div class="layout">
  <div class="panel files">
    <h3>Files</h3>
    <div class="tree" id="tree"></div>
  </div>
  <div>
  <div class="panel" id="codepanel">
    <div class="filehead">
      <span class="crumb" id="crumb"></span>
      <span class="filemeta" id="filemeta"></span>
    </div>
    <div class="code" id="code"><div class="empty">Pick a file.</div></div>
  </div>
  <div class="panel" id="archpanel">
    <h3>How this system fits together</h3>
    <div class="archwrap">
      ${archSvg}
      <div class="archnote">Rows run from the parts nothing imports, at the top, down to the ones everything leans on. Arrow labels count the imports crossing each boundary. Click any box to open its most-weighted file.</div>
    </div>
  </div>
  </div>

  <div class="panel" id="side">
    <div class="tabsrow">
      <button class="stab on" id="tab-guide" data-pane="guide" type="button">The tour</button>
      <button class="stab" id="tab-notes" data-pane="notes" type="button">Notes<span class="pill" id="ncount">0</span></button>
    </div>

  <div id="guide" class="on">
    <div class="gidle" id="gidle">
      Press <b>Take the tour</b> to be walked through this repository — the system first,
      then the code. Or browse the tree yourself; the tour will wait.
    </div>
    <div class="gbody" id="gbody" style="display:none">
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
      <div class="nrow"><button class="btn" id="gnote" type="button">+ Note on this stop</button></div>
    </div>
  </div>

  <div id="notes">
    <div class="nbody">
      <div class="anchor">
        <span class="a-what a-none" id="a-what">nothing selected</span>
        <span class="a-from" id="a-from"></span>
      </div>
      <textarea id="ntext" placeholder="What did this make you think? A question, a doubt, something to check in review…"></textarea>
      <div class="nrow">
        <button class="btn primary" id="nsave" type="button">Save note</button>
        <button class="btn" id="nclear" type="button">Clear anchor</button>
        <span class="spacer"></span>
        <span class="said" id="nhint">click a line number to anchor</span>
      </div>
      <div class="nlist" id="nlist"></div>
      <div class="nrow">
        <button class="btn" id="ncopy" type="button">Copy as Markdown</button>
        <a class="btn" id="ndl" download="">Download .md</a>
        <a class="btn" id="ndlj" download="">.json</a>
      </div>
    </div>
  </div>
  </div>
</div>

<script>window.__REPO__ = ${embedJson({ files: embedded, start, repo: { name: repoName, head: repo?.head ?? null, branch: repo?.branch ?? null } })};</script>
<script>window.__STEPS__ = ${embedJson(opts.steps)};</script>
<script>window.__TOPFILE__ = ${embedJson(topFileOf)};</script>
<script>${HIGHLIGHTER}</script>
<script>${APP}</script>
<script>${TOUR_BOOTSTRAP}</script>
<script>${NOTES}</script>
</body>
</html>`;
}
