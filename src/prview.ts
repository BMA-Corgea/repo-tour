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
import type { FileDiff } from './diff.js';
import type { PrRefs } from './pr.js';
import type { Adjudication } from './adjudicate.js';
import { band } from './prtour.js';

export interface PrViewOptions {
  refs: PrRefs;
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
  const b = band(d.meaningDelta);
  return `<button class="prfile" data-file="${esc(d.path)}" type="button">
    <span class="pfname">${esc(d.path)}</span>
    <span class="pfmeta">
      <span class="pfkind k-${b}">${esc(kindWord(v, d))}</span>
      <span class="pfnum"><i class="add">+${diff?.added ?? 0}</i> <i class="del">−${diff?.removed ?? 0}</i></span>
    </span>
  </button>`;
}

function diffHtml(diff: FileDiff | undefined): string {
  if (!diff || diff.empty) {
    return `<div class="nodiff">No textual change to show — this is a rename, a mode change, or a binary file.</div>`;
  }
  const parts: string[] = [];
  for (const h of diff.hunks) {
    parts.push(`<div class="hunkhead">@@ ${h.oldStart} → ${h.newStart} @@ ${esc(h.header)}</div>`);
    for (const l of h.lines) {
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
      parts.push(
        `<div class="dl ${l.kind}">` +
        `<span class="ln old">${l.oldNo ?? ''}</span>` +
        `<span class="ln new">${l.newNo ?? ''}</span>` +
        `<span class="sg">${sign}</span>` +
        `<span class="tx">${esc(l.text)}</span>` +
        `</div>`,
      );
    }
  }
  return parts.join('\n');
}

const VIEW_CSS = `
.prwrap { display:grid; grid-template-columns: 300px minmax(0,1fr) 420px; gap:14px; padding:14px; align-items:start; }
.panel { background:var(--panel,#141821); border:1px solid var(--line,#2a2f3a); border-radius:10px; overflow:hidden; }
.phead { padding:10px 12px; border-bottom:1px solid var(--line,#2a2f3a); font-weight:600; display:flex; gap:8px; align-items:baseline; }
.phead .sub { font-weight:400; opacity:.6; font-size:12px; }
.prfile { display:block; width:100%; text-align:left; background:none; border:0; border-bottom:1px solid var(--line,#2a2f3a);
          padding:9px 12px; cursor:pointer; color:inherit; font:inherit; }
.prfile:hover, .prfile.on { background:var(--hover,#1b2030); }
.pfname { display:block; font-size:12.5px; word-break:break-all; }
.pfmeta { display:flex; gap:8px; align-items:center; margin-top:4px; font-size:11px; }
.pfkind { padding:1px 6px; border-radius:999px; border:1px solid var(--line,#2a2f3a); opacity:.85; }
.pfkind.k-moved { border-color:#c2703c; color:#e08a4e; }
.pfkind.k-shifted { border-color:#7a6a3a; color:#b79a4e; }
.pfkind.k-steady { opacity:.5; }
.pfnum .add { color:#4ea86a; font-style:normal; }
.pfnum .del { color:#c2554e; font-style:normal; }
.diffbody { max-height:calc(100vh - 190px); overflow:auto; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
.hunkhead { padding:4px 10px; background:var(--hover,#1b2030); opacity:.7; position:sticky; top:0; font-size:11px; }
.dl { display:flex; white-space:pre; }
.dl .ln { width:44px; flex:none; text-align:right; padding-right:8px; opacity:.35; user-select:none; }
.dl .sg { width:14px; flex:none; text-align:center; opacity:.6; user-select:none; }
.dl .tx { flex:1; padding-right:12px; }
.dl.add { background:rgba(78,168,106,.13); }
.dl.del { background:rgba(194,85,78,.13); }
.dl.add .sg { color:#4ea86a; opacity:1; }
.dl.del .sg { color:#c2554e; opacity:1; }
.nodiff { padding:16px; opacity:.6; font-size:13px; }
.prhead { padding:12px 16px; border-bottom:1px solid var(--line,#2a2f3a); display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
.prhead h1 { font-size:16px; margin:0; }
.prhead .num { opacity:.55; }
.prhead a.out { margin-left:auto; font-size:12px; }
.stop { padding:12px 14px; border-bottom:1px solid var(--line,#2a2f3a); }
.stop.on { background:var(--hover,#1b2030); }
.stop h3 { margin:0 0 6px; font-size:13.5px; }
.stop .body { font-size:13px; line-height:1.6; white-space:pre-wrap; }
.stop .chip { float:right; margin-left:8px; font-size:10.5px; padding:1px 6px; border-radius:999px;
              border:1px solid var(--line,#2a2f3a); opacity:.55; }
.stop .more { margin-top:8px; font-size:11px; opacity:.8; background:none; border:0; color:inherit;
              cursor:pointer; text-decoration:underline; padding:0; }
.stop .detail { margin-top:8px; font-size:12px; opacity:.85; white-space:pre-wrap; display:none; }
`;

export function renderPrView(opts: PrViewOptions): string {
  const { refs, deltas, diffs, verdicts } = opts;
  const title = refs.prose.title ?? `${refs.headLabel} → ${refs.baseLabel}`;
  const url = refs.url ?? null;

  const files = deltas.map((d) => fileRow(d, diffs.get(d.path), verdicts.get(d.path))).join('\n');
  const diffPayload: Record<string, string> = {};
  for (const d of deltas) diffPayload[d.path] = diffHtml(diffs.get(d.path));

  // A stop leads with the NARRATIVE — what this PR proposes to change about code that
  // already does something. The score is a chip in the corner. It decides the ORDER of
  // these stops and it is not allowed to be the first thing any of them says.
  const stops = deltas.map((d, i) => {
    const v = verdicts.get(d.path);
    const b = band(d.meaningDelta);
    const narrative = v?.narrative ?? d.reason;
    const detail = [
      `${KIND_LABEL[d.status] ?? 'changed'} · +${diffs.get(d.path)?.added ?? 0} −${diffs.get(d.path)?.removed ?? 0}`,
      d.surface.added.length || d.surface.removed.length || d.surface.changed.length
        ? `Public surface: ${[
            d.surface.added.map((x) => `+${x}`).join(' '),
            d.surface.removed.map((x) => `−${x}`).join(' '),
            d.surface.changed.map((x) => `~${x}`).join(' '),
          ].filter(Boolean).join('  ')}`
        : 'Public surface unchanged.',
      `Ranked ${i + 1} of ${deltas.length} by how far the meaning moved (${d.meaningDelta.toFixed(2)}, ${b}).`,
    ].join('\n');
    return `<div class="stop" data-file="${esc(d.path)}" data-i="${i}">
      <span class="chip">${esc(b)}</span>
      <h3>${esc(d.path)}</h3>
      <div class="body">${esc(narrative)}</div>
      <button class="more" type="button">Show the detail</button>
      <div class="detail">${esc(detail)}</div>
    </div>`;
  }).join('\n');

  const rip = opts.ripple;
  const rippleBlock = rip.reinterpret.length || rip.structuralOnly.length
    ? `<div class="stop">
         <h3>Code this PR does not touch</h3>
         <div class="body">${esc(
           `${rip.reinterpret.length} file${rip.reinterpret.length === 1 ? '' : 's'} import something this PR changed, without changing a character themselves` +
           (rip.reinterpret.length ? `: ${rip.reinterpret.join(', ')}.` : '.') +
           (rip.structuralOnly.length
             ? ` A further ${rip.structuralOnly.length} sit beyond that and were not re-read.`
             : ''),
         )}</div>
       </div>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — pull request</title>
<style>${baseCss()}</style><style>${alternateCss()}</style><style>${VIEW_CSS}</style>
<script>${skinScript()}</script></head>
<body>
<div class="prhead">
  <h1>${esc(title)}</h1>
  ${refs.number ? `<span class="num">#${refs.number}</span>` : ''}
  <span class="sub">${esc(refs.headLabel)} → ${esc(refs.baseLabel)}</span>
  ${url ? `<a class="out" href="${esc(url)}" target="_blank" rel="noreferrer noopener">view on GitHub ↗</a>` : ''}
  ${skinPicker()}
</div>
<div class="prwrap">
  <div class="panel">
    <div class="phead">Files <span class="sub">${deltas.length} changed</span></div>
    ${files || '<div class="nodiff">Nothing changed between these two commits.</div>'}
  </div>
  <div class="panel">
    <div class="phead" id="dhead">the diff</div>
    <div class="diffbody" id="diffbody"></div>
  </div>
  <div class="panel">
    <div class="phead">What this changes <span class="sub">in the order meaning moved</span></div>
    <div id="stops">${stops}${rippleBlock}</div>
  </div>
</div>
<script>
(function () {
  var DIFFS = ${embedJson(diffPayload)};
  var body = document.getElementById('diffbody');
  var head = document.getElementById('dhead');

  function show(file) {
    body.innerHTML = DIFFS[file] || '<div class="nodiff">No diff for this file.</div>';
    head.textContent = file;
    Array.prototype.forEach.call(document.querySelectorAll('.prfile'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-file') === file);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.stop'), function (s) {
      s.classList.toggle('on', s.getAttribute('data-file') === file);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.prfile'), function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-file')); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.stop'), function (s) {
    s.addEventListener('click', function (e) {
      if (e.target && e.target.classList.contains('more')) return;
      var f = s.getAttribute('data-file');
      if (f) { show(f); s.scrollIntoView({ block: 'nearest' }); }
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
  if (first) show(first.getAttribute('data-file'));
})();
</script>
</body></html>`;
}
