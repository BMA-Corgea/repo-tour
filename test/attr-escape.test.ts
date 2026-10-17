/**
 * T-36 — a file name must not run script on repo-tour's pages.
 *
 * The pages inline their client JavaScript as template literals, and several of those scripts
 * had a local `esc()` that escaped `& < >` but NOT `"`. Two of them build double-quoted HTML
 * attributes out of a file name the reader does not control: the repo page's tree row
 * (`data-p="…"`, `src/repoview.ts`) and the digest view's file row (`data-tour-path="…"`,
 * `src/view.ts`). A name carrying a `"` closed the attribute and the rest became live markup —
 * on hover, the planted handler ran. The Ask panel's citation link (`data-file="…"`,
 * `src/askpanel.ts`) has the same escaper and the same absence, reached by a cited file name.
 *
 * These run the real page scripts the way the browser does (as `test/askpanel-drop.test.ts`
 * and `test/iterative-walks.test.ts` do) and assert the planted handler can never leave the
 * attribute it is trapped in. The RED-before-green cases (repo page, digest view, Ask panel)
 * fail on main, each with its own message; the PR page and the library are server-rendered
 * through `"`-escaping helpers already, so they ride along as regression guards (green on
 * main too). The owner's layer — the same plant driven in headless Chromium — is recorded in
 * `.autodev/evidence/T-36/`.
 *
 * The attack string lives only here, as a fixture, never in a commit message.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

import { digest } from '../src/digest.js';
import { buildCodeTour } from '../src/codetour.js';
import { HIGHLIGHTER, renderRepoView } from '../src/repoview.js';
import { renderView } from '../src/view.js';
import { renderPrView } from '../src/prview.js';
import { renderLibrary, type TourRecord } from '../src/library.js';
import { askPanelScript } from '../src/askpanel.js';
import { parseUnified } from '../src/diff.js';
import type { FileDelta } from '../src/delta.js';

/** The review's plant: a name built to break out of a double-quoted attribute and run a handler. */
const QUOTE = 'src/q" data-x="1" onmouseover="window.__pwnedQuote=1" z=".js';
/** A single quote — harmless in a double-quoted attribute, but AC1 wants it escaped too. */
const TICK = "src/it's-here.js";

/** A would-be live handler only ever appears as `onmouseover="` when a `"` broke the attribute open. */
const RAW_HANDLER = 'onmouseover="';
const RAW_SECOND_ATTR = 'data-x="';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rt-t36-'));
}

/** A repository carrying the hostile names, plus a couple of ordinary files to tour. */
function plantHostileRepo(): string {
  const root = tmp();
  const files: Record<string, string> = {
    'src/app.js': "const u = require('./util');\nfunction start() { return u.helper(); }\nmodule.exports = { start };\n",
    'src/util.js': '/** A helper. */\nfunction helper() { return 1; }\nmodule.exports = { helper };\n',
    [QUOTE]: 'module.exports = { q: 1 };\n',
    [TICK]: 'module.exports = { t: 1 };\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

/** A stub element whose innerHTML is a plain string we can read back, like the other panel tests. */
function el(): Record<string, unknown> {
  return {
    innerHTML: '', textContent: '', scrollTop: 0, value: '', style: {},
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
  };
}

/** Run the repo page's own tree script and return the tree HTML it built. */
function drawRepoTree(html: string): string {
  const data = /window\.__REPO__ = (\{[\s\S]*?\});<\/script>/.exec(html)?.[1];
  const app = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    .find((s) => s.includes('var D = window.__REPO__;'));
  expect(data && app, 'the repo page has no file data or no tree script').toBeTruthy();
  const ids: Record<string, ReturnType<typeof el>> = {
    tree: el(), code: el(), crumb: el(), filemeta: el(), range: el(),
  };
  const sandbox: Record<string, unknown> = { document: { getElementById: (id: string) => ids[id] ?? null }, JSON };
  sandbox['window'] = sandbox;
  sandbox['__REPO__'] = JSON.parse(data!);
  vm.runInNewContext(HIGHLIGHTER, sandbox);
  vm.runInNewContext(app!, sandbox);
  return String(ids['tree']!['innerHTML']);
}

/** Run the digest view's own table script and return the rows HTML it built. */
function drawDigestRows(html: string): string {
  const data = /window\.__DIGEST__ = (\{[\s\S]*?\});<\/script>/.exec(html)?.[1];
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    .find((s) => s.includes('function render()') && s.includes('__DIGEST__'));
  expect(data && script, 'the digest view has no row data or no table script').toBeTruthy();
  const ids: Record<string, ReturnType<typeof el>> = { rows: el(), q: el(), cls: el(), count: el() };
  // The real page's classification <select> defaults to its first option, value="all"; without
  // that the script's own filter drops every row and the table is drawn empty.
  ids['cls']!['value'] = 'all';
  const sandbox: Record<string, unknown> = {
    document: { getElementById: (id: string) => ids[id] ?? null, querySelectorAll: () => [] },
    JSON,
  };
  sandbox['window'] = sandbox;
  sandbox['__DIGEST__'] = JSON.parse(data!);
  vm.runInNewContext(script!, sandbox);
  return String(ids['rows']!['innerHTML']);
}

/** Pull the Ask panel's own `esc` out of its script and run it, as the citation link does. */
function askPanelEsc(): (s: string) => string {
  const src = askPanelScript({ notesKey: 'n', chatKey: 'c', offlineHint: 'o' });
  const m = /function esc\(s\)\s*\{\s*(return [\s\S]*?;)\s*\}/.exec(src);
  expect(m, 'could not find the Ask panel esc()').toBeTruthy();
  return new Function('s', m![1]!) as (s: string) => string;
}

describe('T-36: a file name cannot inject an attribute into a page script (red before green)', () => {
  it('the repo page tree traps a quote inside data-p, so no planted handler becomes live', async () => {
    const root = plantHostileRepo();
    try {
      const r = await digest(root, { write: false });
      const plan = buildCodeTour(r);
      const tree = drawRepoTree(renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary }));

      expect(tree.includes('data-p='), 'the tree did not render the hostile file rows').toBe(true);
      expect(tree, 'a file name broke out of data-p and injected a live onmouseover handler on the repo page')
        .not.toContain(RAW_HANDLER);
      expect(tree, 'a file name injected a second live attribute (data-x) on the repo page')
        .not.toContain(RAW_SECOND_ATTR);
      // Present, but inert: the handler text survives only as entity-escaped content.
      expect(tree, 'the escaped handler text is missing — the name was not rendered at all')
        .toContain('onmouseover=&quot;window.__pwnedQuote=1&quot;');
      // AC1 also asks for the single quote to be escaped.
      expect(tree, "a single quote in a file name is left raw in data-p").toContain('&#39;');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the digest view traps a quote inside data-tour-path, so no planted handler becomes live', async () => {
    const root = plantHostileRepo();
    try {
      const r = await digest(root, { write: false });
      const rows = drawDigestRows(renderView(r));

      expect(rows.includes('data-tour-path='), 'the digest view did not render the hostile file rows').toBe(true);
      expect(rows, 'a file name broke out of data-tour-path and injected a live onmouseover handler on the digest view')
        .not.toContain(RAW_HANDLER);
      expect(rows, 'a file name injected a second live attribute (data-x) on the digest view')
        .not.toContain(RAW_SECOND_ATTR);
      expect(rows, 'the escaped handler text is missing — the name was not rendered at all')
        .toContain('onmouseover=&quot;window.__pwnedQuote=1&quot;');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the Ask panel citation escaper escapes " and \' , so a cited file name cannot break data-file', () => {
    const esc = askPanelEsc();
    const out = esc(QUOTE);
    expect(out, 'the Ask panel esc() leaves a double quote raw, so a cited file name breaks out of data-file')
      .not.toContain('"');
    expect(out).toContain('&quot;');
    expect(esc(TICK), "the Ask panel esc() leaves a single quote raw").toContain('&#39;');
  });
});

describe('T-36: server-rendered surfaces render a hostile name inert (regression guard)', () => {
  it('the PR page escapes a hostile file path in its attributes', () => {
    const delta: FileDelta = {
      path: QUOTE, status: 'M', linesChanged: 1, meaningDelta: 0.6,
      surface: { added: [], removed: [], changed: [] }, interpreted: true, reason: 'r', basis: 'adjudicated',
    };
    const html = renderPrView({
      refs: {
        number: 3, url: 'https://github.com/o/r/pull/3', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
        forkSha: null, baseLabel: 'main', headLabel: 'feature', baseAhead: 0,
        prose: { title: QUOTE, body: null, commits: [], issues: [], source: 'github' as const },
      },
      repoName: QUOTE, deltas: [delta], diffs: new Map(), steps: [],
      ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
      verdicts: new Map(), meanings: new Map(), importers: new Map(),
    });
    expect(html, 'a hostile file path broke out of an attribute on the PR page').not.toContain(RAW_HANDLER);
    expect(html).toContain('&quot;');
  });

  it('the library escapes a hostile repo/branch/file name in its attributes', () => {
    const rec: TourRecord = {
      id: 'abc0123456', repoName: QUOTE, repoPath: '/x', head: null, branch: QUOTE,
      generatedAt: new Date().toISOString(), stops: 1, architectureStops: 0, files: [QUOTE],
      interpreted: true, page: '/tmp/x/index.html',
    };
    const html = renderLibrary([rec], { '/x': null }, Date.now());
    expect(html, 'a hostile name broke out of an attribute on the library page').not.toContain(RAW_HANDLER);
    expect(html).toContain('&quot;');
  });
});
