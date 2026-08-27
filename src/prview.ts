/**
 * The pull-request page.
 *
 * T-5 and T-8 rendered a PR tour through `renderRepoView`, which made it the repository page
 * with different stops in the sidebar. That one decision produced most of what Evan found
 * wrong with it: the file tree was the whole repo, the code panel showed whole files with
 * nothing marked, there was no PR to link to, and a stop could only point at a file.
 *
 * So a PR gets its own page. Three panels, laid out like the repo view so it reads as the
 * same product:
 *
 *   FILES    only what this PR touches, with +n/−n and what kind of change it is
 *   DIFF     the actual change, lines marked — "we absolutely need the diffs so that we
 *            know what is happening"
 *   TOUR     what the change MEANS, in the order meaning moved
 *
 * The ordering is still by meaning: that is the product. What changed is that the score is
 * now a chip in the corner of a stop rather than the first thing it says.
 */

import { baseCss, alternateCss, skinPicker, skinScript } from './skins.js';
import type { CodeStep } from './codetour.js';
import type { FileDelta } from './delta.js';
import type { RippleResult } from './delta.js';
import type { FileDiff, DiffLineKind } from './diff.js';
import type { PrRefs } from './pr.js';
import type { Adjudication } from './adjudicate.js';
import { band } from './prtour.js';
import { HIGHLIGHTER } from './repoview.js';
import { askPanelScript, askPanelHtml, ASK_CSS } from './askpanel.js';
import { notesPanelScript, notesPanelHtml, notesKey, NOTES_CSS } from './notes.js';

export interface PrViewOptions {
  refs: PrRefs;
  /** the repository's name — the notes storage key hangs off it */
  repoName?: string;
  /** the digest's own reading of each changed file, for the Ask panel's context */
  meanings?: Map<string, string>;
  /** who imports each changed file, likewise */
  importers?: Map<string, string[]>;
  deltas: FileDelta[];
  diffs: Map<string, FileDiff>;
  steps: CodeStep[];
  ripple: RippleResult;
  verdicts: Map<string, Adjudication>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const KIND_LABEL: Record<string, string> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed',
};

/** The change kind in words, from the model's judgement rather than the number. */
function kindWord(v: Adjudication | undefined, d: FileDelta): string {
  if (d.status === 'A') return 'new file';
  if (d.status === 'D') return 'deleted';
  switch (v?.kind) {
    case 'refactor': return 'refactor';
    case 'behaviour': return 'behaviour';
    case 'surface': return 'public surface';
    case 'new': return 'new purpose';
    case 'removed': return 'removed';
    default: return KIND_LABEL[d.status] ?? 'changed';
  }
}

function fileRow(d: FileDelta, diff: FileDiff | undefined, v: Adjudication | undefined): string {
  return `<button class="prfile" data-file="${esc(d.path)}" type="button">
    <span class="pfname">${esc(d.path)}</span>
    <span class="pfmeta">
      <span class="chip">${esc(kindWord(v, d))}</span>
      <span class="pfnum"><i class="add">+${diff?.added ?? 0}</i> <i class="del">−${diff?.removed ?? 0}</i></span>
    </span>
  </button>`;
}

/**
 * The diff as data, not as markup.
 *
 * Rendered on the client so it can go through the SAME syntax highlighter the repo page's
 * code panel uses. A diff in plain grey next to a coloured file browser is the seam Evan
 * spotted — the tour and the code have to look like one product, not two.
 */
interface DiffPayload {
  lang: string | null;
  rows: Array<{ k: DiffLineKind | 'hh'; o: number | null; n: number | null; t: string }>;
}

function diffPayload(diff: FileDiff | undefined, lang: string | null): DiffPayload | null {
  if (!diff || diff.empty) return null;
  const rows: DiffPayload['rows'] = [];
  for (const h of diff.hunks) {
    rows.push({ k: 'hh', o: null, n: null, t: `@@ ${h.oldStart} → ${h.newStart} @@ ${h.header}` });
    for (const l of h.lines) rows.push({ k: l.kind, o: l.oldNo, n: l.newNo, t: l.text });
  }
  return { lang, rows };
}

/**
 * The PR page's own rules — and ONLY the ones the repo page does not already have.
 *
 * Evan, on the first cut: *"It's very hard to read and I'm not convinced the style follows
 * through entirely."* He was right, and the cause was that this file invented its own colour
 * tokens (`--panel`, `--hover`, `--fg`) with DARK fallbacks. None of them exist in any skin,
 * so every one fell back — dark panels dropped onto a light theme, grey text on cream.
 *
 * The house tokens are `--bg --canvas --ink --muted --line --accent --chip --hl --hl-line`
 * plus the syntax colours, and the house components are `.layout`, `.panel > h3`,
 * `.tree .row`, `.code`, `table.src`, `.chip`. This page uses those and adds nothing that
 * duplicates them. The two genuinely new things are the diff's add/delete tinting and the
 * stop list, and the tinting is defined as tokens so a skin can own it.
 */
const VIEW_CSS = `
:root { --add-bg:#e6ffec; --add-ink:#1a7f37; --del-bg:#ffebe9; --del-ink:#cf222e; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) { --add-bg:#12261e; --add-ink:#3fb950; --del-bg:#25171c; --del-ink:#f85149; }
}
:root[data-theme="dark"] { --add-bg:#12261e; --add-ink:#3fb950; --del-bg:#25171c; --del-ink:#f85149; }

.prfiles { max-height:calc(100vh - 190px); overflow:auto; padding:6px 0; }
.prfile {
  display:block; width:100%; text-align:left; background:none; border:0;
  padding:7px 14px; cursor:pointer; color:var(--ink); font:inherit;
}
.prfile:hover { background:var(--chip); }
.prfile.on { background:var(--chip); font-weight:600; }
.pfname { display:block; font-size:13px; word-break:break-all; }
.pfmeta { display:flex; gap:8px; align-items:center; margin-top:3px; font-size:11px; font-weight:400; }
.pfnum .add { color:var(--add-ink); font-style:normal; }
.pfnum .del { color:var(--del-ink); font-style:normal; }

.diffbody { overflow:auto; max-height:calc(100vh - 210px); background:var(--bg); }
table.diff { border-collapse:collapse; width:100%; font:12px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
table.diff td { padding:0; vertical-align:top; }
table.diff td.gut {
  width:1%; min-width:44px; text-align:right; padding:0 10px; color:var(--muted);
  user-select:none; font-variant-numeric:tabular-nums;
}
table.diff td.sg { width:1%; padding:0 6px; color:var(--muted); user-select:none; text-align:center; }
table.diff td.tx { padding-right:14px; white-space:pre; }
table.diff tr.add { background:var(--add-bg); }
table.diff tr.del { background:var(--del-bg); }
table.diff tr.add td.sg { color:var(--add-ink); }
table.diff tr.del td.sg { color:var(--del-ink); }
table.diff tr.hh td { background:var(--chip); color:var(--muted); padding:3px 12px; font-size:11px; white-space:pre; }

.stops { max-height:calc(100vh - 190px); overflow:auto; }
.stop { padding:12px 14px; border-bottom:1px solid var(--line); cursor:pointer; }
.stop:last-child { border-bottom:0; }
.stop:hover { background:var(--chip); }
.stop.on { background:var(--chip); }
.stop h4 { margin:0 0 7px; font-size:13px; font-weight:600; }
.stop .chip { float:right; margin:0 0 6px 8px; }
.stop .body { font-size:13px; line-height:1.6; color:var(--ink); }
.stop .more {
  margin-top:9px; font-size:12px; background:none; border:0; padding:0;
  color:var(--accent); cursor:pointer; text-decoration:underline;
}
.stop .detail {
  margin-top:8px; font-size:12px; color:var(--muted); white-space:pre-wrap; display:none;
  border-left:2px solid var(--line); padding-left:10px;
}
.nodiff { padding:18px 14px; color:var(--muted); font-size:13px; }
`;

export function renderPrView(opts: PrViewOptions): string {
  const { refs, deltas, diffs, verdicts } = opts;
  const title = refs.prose.title ?? `${refs.headLabel} → ${refs.baseLabel}`;

  const langOf = (p: string): string | null => {
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx' || ext === 'mjs') return 'ts';
    if (ext === 'py') return 'py';
    return null;
  };

  const repoName = opts.repoName ?? 'repo';

  // Exactly what the notes and Ask panels are allowed to know: per file, what the tour is
  // saying about it, what the digest worked out it is for, and who imports it. Assembled
  // here rather than re-derived in the browser so the page and the assistant cannot
  // disagree about what is on screen.
  const meta = {
    repo: repoName,
    pr: refs.number,
    title: refs.prose.title,
    body: refs.prose.body,
    head: refs.headSha,
    headLabel: refs.headLabel,
    baseLabel: refs.baseLabel,
    files: Object.fromEntries(deltas.map((d, i) => [d.path, {
      index: i,
      title: d.path,
      narrative: verdicts.get(d.path)?.narrative ?? d.reason,
      meaning: opts.meanings?.get(d.path) ?? null,
      importers: opts.importers?.get(d.path) ?? [],
    }])),
  };

  const files = deltas.map((d) => fileRow(d, diffs.get(d.path), verdicts.get(d.path))).join('\n');

  const payload: Record<string, DiffPayload | null> = {};
  for (const d of deltas) payload[d.path] = diffPayload(diffs.get(d.path), langOf(d.path));

  // A stop leads with the NARRATIVE — what this PR proposes to change about code that
  // already does something. The band is a chip in the corner. It decides the ORDER these
  // appear in and it is not allowed to be the first thing any of them says.
  const stops = deltas.map((d, i) => {
    const v = verdicts.get(d.path);
    const diff = diffs.get(d.path);
    const surface = [
      d.surface.added.map((x) => `+${x}`).join(' '),
      d.surface.removed.map((x) => `−${x}`).join(' '),
      d.surface.changed.map((x) => `~${x}`).join(' '),
    ].filter(Boolean).join('  ');
    const detail = [
      `${KIND_LABEL[d.status] ?? 'changed'} · +${diff?.added ?? 0} −${diff?.removed ?? 0}`,
      surface ? `Public surface: ${surface}` : 'Public surface unchanged.',
      `Ranked ${i + 1} of ${deltas.length} by how far the meaning moved (${d.meaningDelta.toFixed(2)}).`,
    ].join('\n');
    return `<div class="stop" data-file="${esc(d.path)}">
      <span class="chip">${esc(band(d.meaningDelta))}</span>
      <h4>${esc(d.path)}</h4>
      <div class="body">${esc(v?.narrative ?? d.reason)}</div>
      <button class="more" type="button">Show the detail</button>
      <div class="detail">${esc(detail)}</div>
    </div>`;
  }).join('\n');

  const rip = opts.ripple;
  const rippleStop = rip.reinterpret.length || rip.structuralOnly.length
    ? `<div class="stop">
         <h4>Code this PR does not touch</h4>
         <div class="body">${esc(
           `${rip.reinterpret.length} file${rip.reinterpret.length === 1 ? '' : 's'} import something this PR changed, without changing a character` +
           (rip.reinterpret.length ? `: ${rip.reinterpret.join(', ')}.` : '.') +
           (rip.structuralOnly.length ? ` A further ${rip.structuralOnly.length} sit beyond that and were not re-read.` : ''),
         )}</div>
       </div>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — pull request</title>
<style>${baseCss()}</style><style>${alternateCss()}</style><style>${VIEW_CSS}</style>
<style>${NOTES_CSS}</style><style>${ASK_CSS}</style><style>${PANE_CSS}</style>
<script>${skinScript()}</script></head>
<body>

<div class="topbar">
  <div class="repoline">
    <span class="name">${esc(title)}</span>
    ${refs.number ? `<span class="chip">#${refs.number}</span>` : ''}
    <span class="sep">${esc(refs.headLabel)} → ${esc(refs.baseLabel)}</span>
    <span class="grow"></span>
    ${refs.url ? `<a class="btn" href="${esc(refs.url)}" target="_blank" rel="noreferrer noopener">View on GitHub ↗</a>` : ''}
    ${skinPicker()}
  </div>
  <div class="tabs">
    <span class="tab on">Files changed</span>
  </div>
</div>

<div class="layout">
  <div class="panel">
    <h3>Files <span class="chip">${deltas.length}</span></h3>
    <div class="prfiles">${files || '<div class="nodiff">Nothing changed between these two commits.</div>'}</div>
  </div>
  <div class="panel">
    <div class="filehead"><span class="crumb" id="dhead"></span><span class="chip" id="dcount"></span></div>
    <div class="diffbody" id="diffbody"></div>
  </div>
  <div class="panel rightcol">
    <div class="tabsrow">
      <button class="stab on" data-pane="stops" type="button">What this changes</button>
      <button class="stab" data-pane="notes" type="button">Notes<span class="chip" id="ncount">0</span></button>
      <button class="stab" data-pane="ask" type="button">Ask</button>
    </div>
    <div class="pane on" id="pane-stops"><div class="stops">${stops}${rippleStop}</div></div>
    <div class="pane" id="pane-notes">${notesPanelHtml()}</div>
    <div class="pane" id="pane-ask">${askPanelHtml()}</div>
  </div>
</div>

<script>${HIGHLIGHTER}</script>
<script>
(function () {
  var DIFFS = ${embedJson(payload)};
  var body = document.getElementById('diffbody');
  var head = document.getElementById('dhead');
  var count = document.getElementById('dcount');

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function render(file) {
    var d = DIFFS[file];
    head.textContent = file;
    if (!d) {
      count.textContent = '';
      body.innerHTML = '<div class="nodiff">No textual change to show — a rename, a mode change, or a binary file.</div>';
      return;
    }
    // Highlight the whole side at once so multi-line tokens (block comments, template
    // strings) stay correctly coloured, then take the lines back apart.
    var texts = d.rows.map(function (r) { return r.t; });
    var painted = d.lang ? highlightLines(texts.join('\\n'), d.lang) : null;

    var out = ['<table class="diff">'];
    var add = 0, del = 0;
    for (var i = 0; i < d.rows.length; i++) {
      var r = d.rows[i];
      if (r.k === 'hh') {
        out.push('<tr class="hh"><td colspan="4">' + esc(r.t) + '</td></tr>');
        continue;
      }
      if (r.k === 'add') add++;
      if (r.k === 'del') del++;
      var sign = r.k === 'add' ? '+' : r.k === 'del' ? '\\u2212' : ' ';
      var text = painted && painted[i] !== undefined ? painted[i] : esc(r.t);
      out.push(
        '<tr class="' + r.k + '">' +
        '<td class="gut">' + (r.o === null ? '' : r.o) + '</td>' +
        '<td class="gut">' + (r.n === null ? '' : r.n) + '</td>' +
        '<td class="sg">' + sign + '</td>' +
        '<td class="tx">' + text + '</td>' +
        '</tr>'
      );
    }
    out.push('</table>');
    body.innerHTML = out.join('');
    count.textContent = '+' + add + ' \\u2212' + del;
  }

  function select(file) {
    render(file);
    Array.prototype.forEach.call(document.querySelectorAll('.prfile'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-file') === file);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.stop'), function (s) {
      s.classList.toggle('on', s.getAttribute('data-file') === file);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.prfile'), function (b) {
    b.addEventListener('click', function () { select(b.getAttribute('data-file')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.stop'), function (s) {
    s.addEventListener('click', function (e) {
      if (e.target && e.target.classList.contains('more')) return;
      var f = s.getAttribute('data-file');
      if (f) select(f);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.stop .more'), function (btn) {
    btn.addEventListener('click', function () {
      var d = btn.parentNode.querySelector('.detail');
      var open = d.style.display === 'block';
      d.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'Show the detail' : 'Hide the detail';
    });
  });

  var first = document.querySelector('.prfile');
  if (first) select(first.getAttribute('data-file'));

  // ---- what the notes and Ask panels are allowed to know about this page
  var META = ${embedJson(meta)};

  function currentFile() {
    var on = document.querySelector('.prfile.on');
    return on ? on.getAttribute('data-file') : (first ? first.getAttribute('data-file') : null);
  }

  function visibleRange(file) {
    var d = DIFFS[file];
    if (!d) return { from: 1, to: 1 };
    var lines = d.rows.filter(function (r) { return r.k !== 'hh' && r.n !== null; });
    if (!lines.length) return { from: 1, to: 1 };
    return { from: lines[0].n, to: lines[lines.length - 1].n };
  }

  /**
   * A note on a PR attaches to the CHANGED lines of the file being read, and carries the
   * narrative that was on screen. Without that last part a note records what someone
   * flagged but not what they were being told when they flagged it, which is most of what
   * makes it worth reading a week later.
   */
  window.__noteAnchor = function () {
    var f = currentFile();
    if (!f) return null;
    var r = visibleRange(f);
    var m = META.files[f] || {};
    var d = DIFFS[f];
    var quote = d ? d.rows.filter(function (x) { return x.k === 'add' || x.k === 'del'; })
      .slice(0, 12).map(function (x) { return (x.k === 'add' ? '+' : '-') + x.t; }).join('\\n') : '';
    return {
      file: f, startLine: r.from, endLine: r.to,
      stopIndex: m.index === undefined ? -1 : m.index,
      stopTitle: m.title || null,
      explanation: m.narrative || null,
      head: META.head || null,
      quote: quote
    };
  };

  window.__noteSubject = function () {
    return (META.pr ? '#' + META.pr + ' ' : '') + (META.title || '');
  };

  window.__askContext = function () {
    var f = currentFile();
    var m = f ? (META.files[f] || {}) : {};
    var d = f ? DIFFS[f] : null;
    var diffText = d ? d.rows.map(function (r) {
      if (r.k === 'hh') return r.t;
      return (r.k === 'add' ? '+' : r.k === 'del' ? '-' : ' ') + r.t;
    }).join('\\n') : '';
    return {
      repo: META.repo,
      pr: { number: META.pr, title: META.title, body: META.body, head: META.headLabel, base: META.baseLabel },
      file: f,
      fileMeaning: m.meaning || null,
      stopTitle: m.title || null,
      stopText: m.narrative || null,
      diff: diffText,
      importers: m.importers || []
    };
  };

  // ---- panes
  Array.prototype.forEach.call(document.querySelectorAll('.stab'), function (b) {
    b.addEventListener('click', function () {
      var want = b.getAttribute('data-pane');
      Array.prototype.forEach.call(document.querySelectorAll('.stab'), function (x) {
        x.classList.toggle('on', x === b);
      });
      Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) {
        p.classList.toggle('on', p.id === 'pane-' + want);
      });
      if (window.__notesChanged) window.__notesChanged();
    });
  });
})();
</script>
<script>${notesPanelScript(notesKey(repoName, refs.number))}</script>
<script>${askPanelScript(notesKey(repoName, refs.number))}</script>
</body></html>`;
}

/** Panes and the tab strip — the right column carries three things now, not one. */
export const PANE_CSS = `
.rightcol { display:flex; flex-direction:column; max-height:calc(100vh - 150px); }
.rightcol .tabsrow { display:flex; gap:0; border-bottom:1px solid var(--line); flex:none; }
.rightcol .stab {
  background:none; border:0; border-bottom:2px solid transparent; padding:9px 12px;
  font:inherit; font-size:12.5px; color:var(--muted); cursor:pointer;
}
.rightcol .stab.on { color:var(--ink); border-bottom-color:#fd8c73; font-weight:600; }
.rightcol .stab .chip { margin-left:6px; }
.rightcol .pane { display:none; min-height:0; flex:1 1 auto; }
.rightcol .pane.on { display:flex; flex-direction:column; }
.rightcol .pane .stops { flex:1 1 auto; overflow:auto; max-height:none; }
`;
