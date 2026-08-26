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
import { baseCss, alternateCss, skinPicker, skinScript } from './skins.js';

export interface RepoViewOptions {
  steps: Array<CodeStep & { interpreted?: boolean }>;
  /** when present, the tour opens with the system diagram */
  architecture?: Architecture;
  itinerary: string[];
  /** cap on embedded file count and total bytes, so the page stays one openable file */
  maxFiles?: number;
  maxBytes?: number;
  /**
   * Set when the app is serving this page rather than exporting it to a file.
   *
   * Two things follow: there is somewhere to go BACK to, and the page can notice when the
   * server it came from has restarted — which is what a static export can never do.
   */
  servedBy?: { homeUrl: string };
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

/**
 * Reload when the server that served this page restarts WHILE IT IS OPEN.
 *
 * The baseline is fetched on load rather than baked in at render time, and that is not a
 * detail. Rendered pages are cached to disk, so a page built by one server run is later
 * served by another — a baked-in id is stale the moment that happens, the very first poll
 * disagrees, and the page reloads in a two-second loop. Every click then looks like it
 * throws you back to the start of the tour, because the page really is restarting under you.
 *
 * Reading the baseline at load makes the page self-calibrating: it compares against the
 * server it is actually talking to, cached or not.
 *
 * The poll fails silently and often — while the server is down mid-restart every request
 * errors — so a failure simply tries again.
 */
function liveReloadScript(): string {
  return `
(function () {
  var mine = null;
  function poll() {
    fetch('/api/version', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (v) {
        if (!v || !v.bootId) return;
        if (mine === null) { mine = v.bootId; return; }  // first answer sets the baseline
        if (v.bootId !== mine) location.reload();
      })
      .catch(function () { /* restarting; try again next tick */ });
  }
  poll();
  setInterval(poll, 2000);
})();
`;
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
      // Scroll the TREE, never the page.
      //
      // scrollIntoView walks every scrollable ancestor, so keeping the selected row in
      // view also scrolled the document — the page opened 58px down with the header, the
      // stop counts and the snapshot line already tucked under the sticky bar. The button
      // looked buried no matter where it was put, because the page had moved, not the
      // button. Doing the arithmetic by hand touches one element and nothing else.
      var on = treeEl.querySelector('.row.on');
      if (on) {
        var boxT = treeEl.getBoundingClientRect();
        var boxR = on.getBoundingClientRect();
        if (boxR.top < boxT.top) treeEl.scrollTop -= (boxT.top - boxR.top);
        else if (boxR.bottom > boxT.bottom) treeEl.scrollTop += (boxR.bottom - boxT.bottom);
      }
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
    visibleLines: function () {
      var rows = codeEl.querySelectorAll('tr[id^="L"]');
      if (!rows.length) return { from: 1, to: 1 };
      var top = codeEl.scrollTop, bottom = top + codeEl.clientHeight;
      var first = null, last = null;
      for (var i = 0; i < rows.length; i++) {
        var y = rows[i].offsetTop;
        if (y >= top && y <= bottom) { if (first === null) first = i + 1; last = i + 1; }
      }
      return { from: first || 1, to: last || Math.min(rows.length, 40) };
    },
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

  /**
   * What a note would attach to right now, if the reader has not picked lines themselves.
   *
   * Requiring a line click first made Save silently do nothing — you typed a thought, hit
   * the button, and the only feedback was a small grey hint. A note about "this file" is a
   * perfectly good note; the anchor should default to something true rather than nothing.
   */
  function implicitAnchor() {
    var t = window.__tour && window.__tour.step();
    if (t && t.file) {
      return { file: t.file, startLine: t.startLine, endLine: t.endLine,
               stopIndex: window.__tour.index(), stopTitle: t.title, explanation: t.text };
    }
    var f = window.__repo && window.__repo.current();
    if (!f) return null;
    var vis = window.__repo.visibleLines();
    return { file: f, startLine: vis.from, endLine: vis.to, stopIndex: -1, stopTitle: null, explanation: null };
  }

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function showAnchor() {
    if (!anchor) {
      el.what.textContent = 'nothing selected';
      el.what.classList.add('a-none');
      el.from.textContent = '';
      var implied = implicitAnchor();
      el.hint.textContent = implied
        ? 'a note will attach to ' + implied.file.split('/').pop() + ' unless you pick lines'
        : 'open a file, or click a line number, to anchor a note';
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

  document.getElementById('nhere').addEventListener('click', function () {
    var a = implicitAnchor();
    if (!a) { el.hint.textContent = 'open a file first'; return; }
    anchor = a; showAnchor(); el.text.focus();
  });

  el.save.addEventListener('click', function () {
    var body = el.text.value.trim();
    if (!body) { el.text.focus(); el.hint.textContent = 'write something first'; return; }
    if (!anchor) anchor = implicitAnchor();
    if (!anchor) { el.hint.textContent = 'open a file first, then this can attach to something'; return; }
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
    anchor = null;
    window.__repo.clearSel();
    showAnchor();
    el.hint.textContent = 'saved';
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
    /**
     * The tour moved, so an anchor from wherever you were before no longer describes what
     * you are looking at. Dropping it means a note taken mid-tour records the STOP — which
     * is the whole point of the provenance — instead of silently reusing a stale pick.
     */
    followStop: function () {
      anchor = null;
      if (window.__repo) window.__repo.clearSel();
      showAnchor();
    },
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
  var btn = document.getElementById('startbig');
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

  window.__tour = { step: function () { return null; }, index: function () { return -1; } };
  if (!defs.length || !btn) return;

  var el = {
    step: document.getElementById('gstep'), title: document.getElementById('gtitle'),
    where: document.getElementById('gwhere'), text: document.getElementById('gtext'),
    bar: document.getElementById('gbar'), src: document.getElementById('gsrc'),
    back: document.getElementById('gback'), next: document.getElementById('gnext'),
    end: document.getElementById('gend'), skip: document.getElementById('gskip')
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
    if (window.__notes && window.__notes.followStop) window.__notes.followStop();
    var ci = chapterAt(n);
    var ch = chapters[ci];
    head.style.display = '';
    document.getElementById('cnum').textContent = 'Ch ' + (ci + 1) + '/' + chapters.length;
    document.getElementById('cname').textContent = ch.title;
    toc.innerHTML = tocHtml(ci);
    el.step.textContent = 'Stop ' + (n - ch.from + 1) + ' of ' + (ch.to - ch.from + 1) +
      '  \u00b7  ' + (n + 1) + '/' + defs.length + ' overall';
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
    el.next.textContent = n === defs.length - 1 ? 'Finish' : (n === ch.to ? 'Next chapter' : 'Next');
    el.skip.style.display = ci === chapters.length - 1 ? 'none' : '';
  }

  var idle = document.getElementById('gidle');
  var body = document.getElementById('gbody');

  // ---- chapters: consecutive stops sharing a chapter key
  var chapters = [];
  defs.forEach(function (s, n) {
    var ch = s.chapter || { key: '@flat', title: 'The tour', subtitle: '' };
    var last = chapters[chapters.length - 1];
    if (!last || last.key !== ch.key) chapters.push({ key: ch.key, title: ch.title, subtitle: ch.subtitle, from: n, to: n });
    else last.to = n;
  });
  function chapterAt(n) {
    for (var c = 0; c < chapters.length; c++) if (n >= chapters[c].from && n <= chapters[c].to) return c;
    return 0;
  }

  var head = document.getElementById('chaphead');
  var toc = document.getElementById('toc');
  var caret = document.getElementById('caret');

  function tocHtml(current) {
    return chapters.map(function (c, ci) {
      var count = c.to - c.from + 1;
      var cls = ci === current ? 'on' : (current > -1 && ci < current ? 'done' : '');
      return '<button type="button" data-ch="' + ci + '" class="' + cls + '">' +
        '<span class="n">' + (ci + 1) + '</span>' +
        '<span class="t">' + esc(c.title) + (c.subtitle ? ' <span class="s">' + esc(c.subtitle) + '</span>' : '') + '</span>' +
        '<span class="c">' + count + '</span>' +
      '</button>';
    }).join('');
  }
  function esc(x) { return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  document.getElementById('chapcount').textContent = chapters.length + ' chapters';
  document.getElementById('idletoc').innerHTML = tocHtml(-1);
  document.getElementById('idletoc').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ch]');
    if (b) startAt(chapters[Number(b.getAttribute('data-ch'))].from);
  });

  head.addEventListener('click', function () {
    var hidden = toc.classList.toggle('hide');
    caret.textContent = hidden ? '\u25be' : '\u25b4';
  });
  toc.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ch]');
    if (!b) return;
    toc.classList.add('hide');
    caret.textContent = '\u25be';
    show(chapters[Number(b.getAttribute('data-ch'))].from);
  });

  function startAt(n) {
    layout.classList.add('touring');
    idle.style.display = 'none';
    body.style.display = '';
    window.openPane('guide');
    show(n);
  }
  function start() { startAt(0); }
  function stop() {
    layout.classList.remove('touring');
    idle.style.display = '';
    body.style.display = 'none';
    archPanel.classList.remove('on');
    codePanel.style.display = '';
    head.style.display = 'none';
    toc.classList.add('hide');
    focusPart(null);
    var hits = document.querySelectorAll('tr.hit');
    for (var k = 0; k < hits.length; k++) hits[k].classList.remove('hit');
    i = -1;
  }

  window.__tour = { step: function () { return i >= 0 ? defs[i] : null; }, index: function () { return i; } };

  btn.addEventListener('click', start);
  document.getElementById('gnote').addEventListener('click', function () {
    window.__notes.anchorFromStop(defs[i], i);
  });
  el.next.addEventListener('click', function () { i === defs.length - 1 ? stop() : show(i + 1); });
  el.back.addEventListener('click', function () { show(i - 1); });
  el.end.addEventListener('click', stop);
  el.skip.addEventListener('click', function () {
    var next = chapters[chapterAt(i) + 1];
    if (next) show(next.from); else stop();
  });
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
<style>${baseCss()}</style>
<style>${alternateCss()}</style>
<script>${skinScript()}</script>
${opts.servedBy ? `<script>${liveReloadScript()}</script>` : ''}
</head>
<body>

<div class="topbar">
  <div class="repoline">
    ${opts.servedBy ? `<a class="btn back" href="${opts.servedBy.homeUrl}">← All repositories</a>` : ''}
    <span class="owner">${escapeHtml(path.basename(path.dirname(root)) || 'local')}</span>
    <span class="sep">/</span>
    <span class="name">${escapeHtml(repoName)}</span>
    <span class="chip">${repo?.branch ? escapeHtml(repo.branch) : 'no branch'}</span>
    <span class="chip">${repo ? repo.commitCount.toLocaleString() : 0} commits</span>
    <span class="grow"></span>
    ${skinPicker()}
  </div>
  <div class="tabs">
    <span class="tab on">Code</span>
    <span class="tab off">Issues</span>
    <span class="tab off">Pull requests</span>
    <span class="tab off">Actions</span>
  </div>
</div>

<div class="bar">
  <span class="said">${archStops > 0
    ? `${opts.steps.length} stops — ${archStops} on how the system fits together, then ${opts.steps.length - archStops} through the ${opts.itinerary.length} files that carry it.`
    : `${opts.steps.length} stops through ${opts.itinerary.length} ${opts.itinerary.length === 1 ? 'file' : 'files'} — the ones that actually carry this repo.`}</span>
  <span class="said">·</span>
  <span class="said">${shown.toLocaleString()} of ${total.toLocaleString()} files browsable here; generated, vendored and binary content is left out.</span>
</div>
<div class="bar snapshot">
  <span class="said">
    A snapshot of <b>${repo?.head ? escapeHtml(repo.head.slice(0, 10)) : 'an uncommitted tree'}</b>${repo?.branch ? ` on ${escapeHtml(repo.branch)}` : ''},
    taken ${escapeHtml(generatedAt.slice(0, 16).replace('T', ' '))}. This file is frozen — refreshing it will never show new code,
    new chapters, or anything else, because it does not look at the repository again and its features are baked in.
    Re-run <code>repo-tour tour</code> for a new file, or <code>./start.sh</code> to run the app, where a refresh really does re-read the repo.
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
    <button class="chaphead" id="chaphead" type="button" style="display:none">
      <span class="cnum" id="cnum"></span>
      <span class="cname" id="cname"></span>
      <span class="caret" id="caret">▾</span>
    </button>
    <div class="toc hide" id="toc"></div>
    <div class="gidle" id="gidle">
      <button class="btn primary bigstart" id="startbig" type="button">▶ Take the tour</button>
      <div class="tocnote" style="padding:10px 0">
        <b id="chapcount">chapters</b> — start at the beginning with the button above, or pick
        any chapter below to start there. Browsing the tree yourself works too; the tour waits.
      </div>
      <div class="toc" id="idletoc"></div>
      <div class="buildstamp">build ${escapeHtml(generatedAt.slice(0, 16).replace('T', ' '))}</div>
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
        <button class="btn" id="gskip" type="button">Skip chapter</button>
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
      <div class="nrow" style="margin:0 0 9px">
        <button class="btn" id="nhere" type="button">Anchor to what I'm looking at</button>
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
