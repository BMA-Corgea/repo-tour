/**
 * T-18 — what actually reaches the two pages (AC8, AC10, AC11).
 *
 * The panels are browser scripts built as strings, so what can be asserted here is what each
 * page HANDS OVER: the context keys, the transcript key, the note fields, the offline words.
 * That is enough to catch the failure that matters — a change landing on one surface and not
 * the other, which is exactly what Q8 ("both, in this one piece of work") was answered to
 * avoid, and what the notes panel's recorded duplication makes easy to do by accident.
 *
 * ⚠ READ THIS BEFORE ADDING AN ASSERTION HERE ⚠
 *
 * A tour of THIS repository embeds THIS repository's source, and `test/panels.test.ts` is one
 * of the files it embeds. So `expect(repoHtml).toContain('<some literal>')` finds its own
 * source text and passes no matter what `src/repoview.ts` does. The first version of this file
 * did exactly that: the auto-review deleted `window.__openCitation`, the `source:` hand-off,
 * `window.__keepNote` and the `*Asked:*` export line out of `src/repoview.ts`, and all 21 tests
 * here still passed — AC1, AC8, AC9 and AC10's repo-tour half had no effective test at all.
 *
 * So: NEVER assert against `repoHtml` whole. Assert against `scripts(repoHtml)` — the page's
 * own `<script>` bodies with every embedded source file stripped out — or against the parsed
 * `window.__REPO__` payload. `sabotage()` below is the proof the guard works: it deletes a
 * feature and asserts the test that claims it goes red.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/digest.js';
import { buildCodeTour } from '../src/codetour.js';
import { renderRepoView } from '../src/repoview.js';
import { renderPrView } from '../src/prview.js';
import { parseUnified } from '../src/diff.js';
import { noteFromExchange } from '../src/notes.js';
import { askPanelScript } from '../src/askpanel.js';
import { SOURCE_BUDGET } from '../src/ask.js';
import type { FileDelta } from '../src/delta.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const prRefs = {
  number: 3, url: 'https://github.com/o/r/pull/3',
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), forkSha: null,
  baseLabel: 'main', headLabel: 'feature', baseAhead: 0,
  prose: { title: 'A change', body: null, commits: [], issues: [], source: 'github' as const },
};
const prDelta: FileDelta = {
  path: 'src/rank.ts', status: 'M', linesChanged: 2, meaningDelta: 0.6,
  surface: { added: [], removed: [], changed: [] }, interpreted: true, reason: 'r', basis: 'adjudicated',
};

function renderPr(repoPath?: string): string {
  return renderPrView({
    refs: prRefs, repoName: 'repo-tour', repoPath,
    deltas: [prDelta],
    diffs: new Map([['src/rank.ts', parseUnified('src/rank.ts', '@@ -22,1 +22,1 @@\n-  test: 0.5,\n+  test: 0.05,')]]),
    steps: [], ripple: { reinterpret: [], structuralOnly: [], reachable: 0 },
    verdicts: new Map([['src/rank.ts', {
      changed: true, magnitude: 0.6, kind: 'behaviour' as const, source: 'model' as const,
      headline: 'h', narrative: 'The multiplier drops to 0.05.',
    }]]),
    meanings: new Map([['src/rank.ts', 'Scores every file.']]),
    importers: new Map([['src/rank.ts', ['src/digest.ts']]]),
  });
}

/**
 * The page's own script bodies, with the embedded repository source removed.
 *
 * `window.__REPO__` carries every toured file's text, and on a tour of this repository that
 * includes this test file. Dropping that one assignment leaves the page's REAL client code —
 * which is the only thing an assertion about `src/repoview.ts` should ever be matching.
 */
function scripts(html: string): string {
  return html
    .replace(/<script>window\.__REPO__ = \{[\s\S]*?\};<\/script>/, '')
    .replace(/<script>window\.__STEPS__ = [\s\S]*?;<\/script>/, '')
    .replace(/<script>window\.__TOPFILE__ = [\s\S]*?;<\/script>/, '');
}

/**
 * Render the repo view once per case, each with one of T-18's features cut out of its source,
 * and hand the pages back for THIS file's own `scripts()` to judge.
 *
 * Two deliberate choices. It runs in a CHILD PROCESS because the point is a genuinely fresh
 * module graph — vitest's loader refuses a cache-busted dynamic import, and an in-process
 * re-import would hand back the module it already had and quietly prove nothing, which is the
 * exact class of mistake this block exists to catch. And it returns the raw pages rather than
 * a verdict, so the stripping under test is the real `scripts()` above and not a copy of it
 * that could drift away from it.
 */
function sabotagedPages(cases: Array<{ file: string; remove: string }>): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-sabotage-'));
  const script = path.join(dir, 'run.mts');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = ${JSON.stringify(root)};
const DIR = ${JSON.stringify(dir)};
const CASES = ${JSON.stringify(cases)};
const { digest } = await import(pathToFileURL(path.join(ROOT, 'src/digest.ts')).href);
const { buildCodeTour } = await import(pathToFileURL(path.join(ROOT, 'src/codetour.ts')).href);
for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i]!;
  const abs = path.join(ROOT, c.file);
  const original = fs.readFileSync(abs, 'utf8');
  if (!original.includes(c.remove)) throw new Error('not present in ' + c.file + ': ' + c.remove);
  fs.writeFileSync(abs, original.replace(c.remove, ''));
  try {
    const mod: any = await import(pathToFileURL(path.join(ROOT, 'src/repoview.ts')).href + '?s=' + i);
    const r = await digest(ROOT, { write: false });
    const plan = buildCodeTour(r, { maxFiles: 3, perFile: 2 });
    fs.writeFileSync(path.join(DIR, i + '.html'),
      mod.renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary }));
  } finally {
    fs.writeFileSync(abs, original);
  }
}
`, 'utf8');
  try {
    execFileSync('npx', ['tsx', script], { cwd: root, encoding: 'utf8', timeout: 300_000 });
    return cases.map((_, i) => fs.readFileSync(path.join(dir, `${i}.html`), 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let repoHtml: string;
let servedHtml: string;

beforeAll(async () => {
  const r = await digest(root, { write: false });
  const plan = buildCodeTour(r, { maxFiles: 3, perFile: 2 });
  repoHtml = renderRepoView(r, { steps: plan.steps, itinerary: plan.itinerary });
  servedHtml = renderRepoView(r, {
    steps: plan.steps,
    itinerary: plan.itinerary,
    servedBy: { homeUrl: '/', repoPath: '/tmp/whatever', builtAt: new Date().toISOString() },
  });
}, 120_000);

describe('the repo tour hands over what T-18 promised', () => {
  it('sends the source of the file on screen, not only a description of it', () => {
    // The assertion the auto-review's sabotage exposed: the old text matched nothing the page
    // emits — only this test file's own copy of it, embedded in the tour. The real line is an
    // assignment, and it clips to SOURCE_BUDGET.
    expect(scripts(repoHtml)).toContain(`source = R.files[i].text.slice(0, ${SOURCE_BUDGET});`);
    expect(scripts(repoHtml)).toContain('sourceFullLength: fullLength');
  });

  it('sends the stop index, so a message can be stamped with where it was asked', () => {
    expect(scripts(repoHtml)).toContain('stopIndex: window.__tour ? window.__tour.index() : -1');
    // Regression guard, found by driving the real page: the falsy-zero form reports stop
    // ZERO — the opening stop, where most readers ask their first question — as "not
    // touring". Built by concatenation because a tour of THIS repository embeds this test
    // file, so a guard written as one literal would find itself and fail forever.
    expect(scripts(repoHtml)).not.toContain(`window.__tour.index()${')'} || -1`);
  });

  it('carries the repository overview and the whole stop list in its payload', () => {
    const payload = JSON.parse(/window\.__REPO__ = (\{.*?\});<\/script>/s.exec(repoHtml)![1]!) as {
      stops: Array<{ index: number; title: string }>;
      overview: string | null;
      repoPath: string | null;
    };
    expect(Array.isArray(payload.stops)).toBe(true);
    expect(payload.stops.length).toBeGreaterThan(0);
    expect(payload.stops[0]).toHaveProperty('title');
    // no architecture was interpreted for this render, and null is the honest value
    expect(payload.overview).toBeNull();
  });

  it('sends a repo path only when a server is behind the page', () => {
    // An exported page has no server, so there is nothing to fetch from and it must not
    // claim otherwise — that is how the refusal in askStream stays truthful.
    const exported = JSON.parse(/window\.__REPO__ = (\{.*?\});<\/script>/s.exec(repoHtml)![1]!) as { repoPath: string | null };
    const served = JSON.parse(/window\.__REPO__ = (\{.*?\});<\/script>/s.exec(servedHtml)![1]!) as { repoPath: string | null };
    expect(exported.repoPath).toBeNull();
    expect(served.repoPath).toBe('/tmp/whatever');
  });

  it('keeps its transcript beside its notes, both scoped to the repository', () => {
    // Asserted against the EMITTED declarations, not the page as a whole: a tour of this
    // repository embeds this repository's own source, so the raw HTML contains every string
    // literal in src/ — including the PR page's keys. Matching the rendered form is the only
    // way to test a self-hosting tour and mean it.
    expect(scripts(repoHtml)).toContain(`var CHAT_KEY = "repotour:chat:${path.basename(root)}";`);
    expect(scripts(repoHtml)).toContain(`var NOTES_KEY = "repotour:notes:${path.basename(root)}";`);
    expect(scripts(repoHtml)).not.toMatch(/var CHAT_KEY = "[^"]*#pr-/);
  });

  it('can open a file at a cited line', () => {
    expect(scripts(repoHtml)).toContain('window.__openCitation');
    expect(scripts(repoHtml)).toContain('window.__repo.mark(line, line)');
  });

  it('tells a reader who opened it from disk exactly what to run (AC11)', () => {
    const hintOf = (html: string): string => /var OFFLINE_HINT = ("(?:[^"\\]|\\.)*");/.exec(html)![1]!;
    const exported = JSON.parse(hintOf(repoHtml)) as string;
    expect(exported).toContain('opened as a saved file');
    expect(exported).toContain('repo-tour serve');
    // The AC's own words: "names the command WITH THE REPO PATH in it". Asserting only the
    // command was asserting the implementation — the first version passed while the message
    // still said "add this repository", which is the copy the AC was written to replace.
    expect(exported).toContain(root);
    expect(exported).toContain('will still be here');
    // a served page says something different — the server stopped, not "you saved this"
    const served = JSON.parse(hintOf(servedHtml)) as string;
    expect(served).not.toContain('opened as a saved file');
    expect(served).toContain('may have stopped');
    expect(served).toContain(root);
  });
});

describe('the pull request page hands over the same things (AC10)', () => {
  it('carries the checkout root, so the tutor can read past the diff', () => {
    const html = renderPr('/tmp/checkout');
    expect(html).toContain('"repoPath":"/tmp/checkout"');
    expect(html).toContain('repoPath: META.repoPath');
  });

  it('is null-safe when no root was passed', () => {
    expect(renderPr()).toContain('"repoPath":null');
  });

  it('stamps the stop and carries the stop list', () => {
    const html = renderPr('/tmp/checkout');
    expect(html).toContain('stopIndex: m.index === undefined ? -1 : m.index');
    expect(html).toContain('stops: META.stops');
  });

  it('keys its transcript to the pull request, not just the repository', () => {
    const html = renderPr();
    expect(html).toContain('repotour:chat:repo-tour#pr-3');
    expect(html).toContain('repotour:notes:repo-tour#pr-3');
  });

  it('can jump to a cited file', () => {
    expect(renderPr()).toContain('window.__openCitation');
  });

  it('names the checkout in its offline message too (AC11)', () => {
    const hintOf = (html: string): string => /var OFFLINE_HINT = ("(?:[^"\\]|\\.)*");/.exec(html)![1]!;
    expect(JSON.parse(hintOf(renderPr('/tmp/checkout'))) as string).toContain('/tmp/checkout');
    // and stays sane when there is no root to name
    expect(JSON.parse(hintOf(renderPr())) as string).toContain('repo-tour serve');
  });
});

describe('an answer can become a note, on both surfaces (AC8)', () => {
  it('the canonical record carries every provenance field plus the question', () => {
    const record = noteFromExchange({
      file: 'src/rank.ts', startLine: 20, endLine: 24,
      stopIndex: 2, stopTitle: 'The ranker', explanation: 'what the tour said',
      head: 'abc123', quote: 'const x = 1;',
    }, 'why is this damped?', 'Because tests would otherwise win the itinerary.', 1000);

    expect(record).toEqual({
      id: '1000-20', file: 'src/rank.ts', startLine: 20, endLine: 24,
      stopIndex: 2, stopTitle: 'The ranker', explanation: 'what the tour said',
      head: 'abc123', quote: 'const x = 1;',
      body: 'Because tests would otherwise win the itinerary.',
      question: 'why is this damped?', source: 'tutor',
    });
  });

  it('both note panels write the same two new fields', () => {
    // The duplication notes.ts has recorded since T-3: two panels, one shape. This is the
    // guard that they did not drift apart while T-18 touched both.
    for (const html of [repoHtml, renderPr()]) {
      expect(scripts(html)).toContain('question: pendingQuestion || undefined');
      expect(scripts(html)).toContain("source: pendingQuestion ? 'tutor' : undefined");
      expect(scripts(html)).toContain('window.__keepNote');
      expect(scripts(html)).toContain('trim it to what matters, then save');
    }
  });

  it('both exports show the question a kept note came from', () => {
    expect(scripts(repoHtml)).toContain("'*Asked:* '");
    expect(scripts(renderPr())).toContain("'*Asked:* '");
  });

  it('a note written before T-18 still renders and still exports', () => {
    // `question` and `source` are optional for exactly one reason: notes already sitting in
    // somebody's browser have neither, and they must keep working. Both panels read them
    // behind a guard, and a typed note writes `undefined`, which JSON.stringify drops.
    for (const html of [scripts(repoHtml), scripts(renderPr())]) {
      expect(html).toMatch(/if \((?:n|nt)\.question\)/);
    }
    // nothing unconditionally dereferences them
    expect(scripts(repoHtml)).not.toMatch(/[^.\w](?:n|nt)\.question\.[a-z]/);
    expect(scripts(repoHtml)).not.toMatch(/[^.\w](?:n|nt)\.source\.[a-z]/);
  });

  it('a typed note cannot inherit a kept answer provenance', () => {
    // Found by the auto-review: pendingQuestion was cleared only on save, so keep → clear →
    // type your own note → save produced a note claiming source:'tutor' under someone else's
    // question. That is precisely the provenance AC8 exists to make trustworthy.
    for (const html of [scripts(repoHtml), scripts(renderPr())]) {
      expect(html).toContain("if (!el.text.value.trim()) pendingQuestion = '';");
    }
    expect(scripts(repoHtml)).toContain("window.__repo.clearSel(); showAnchor();");
  });

  it('the panel offers the keep button and reads the question from the turn above', () => {
    const script = askPanelScript({ notesKey: 'n', chatKey: 'c', offlineHint: 'hint' });
    expect(script).toContain('keep as note');
    expect(script).toContain("rows[j].role === 'user'");
  });
});

describe('the panel script is shared, so both pages get the same behaviour', () => {
  const script = askPanelScript({ notesKey: 'n', chatKey: 'c', offlineHint: 'the hint' });

  it('reads an event stream rather than one blob of JSON', () => {
    expect(script).toContain('getReader()');
    expect(script).toContain("event: (.+)");
    for (const kind of ['fetch', 'delta', 'reset', 'error', 'done']) {
      expect(script).toContain(`kind === '${kind}'`);
    }
  });

  it('shows each lookup as it happens', () => {
    expect(script).toContain("'read ' + data.what");
    expect(script).toContain("'could not '");
  });

  it('offers the whole tour by default, filterable to one stop', () => {
    expect(script).toContain('var showAll = true;');
    expect(script).toContain('showing this stop only');
  });

  it('never opens a sent transcript on an assistant turn', () => {
    expect(script).toContain("while (out.length && out[0].role !== 'user') out.shift();");
  });

  it('uses the offline words it was given', () => {
    expect(script).toContain('the hint');
  });
});

describe('these assertions actually bite (the auto-review proof)', () => {
  // The auto-review deleted four of T-18's repo-tour features and all 21 tests here still
  // passed, because each assertion was finding its own source text inside the toured page.
  // This runs that sabotage as a test: delete the feature, re-render in a fresh process, and
  // require the page to have lost it. If `scripts()` ever stops stripping the embedded
  // source, this is where the next reader finds out.
  const CASES = [
    { ac: 'AC1 — the source hand-off', file: 'src/repoview.ts',
      remove: 'source = R.files[i].text.slice(0, ${SOURCE_BUDGET});',
      gone: `source = R.files[i].text.slice(0, ${SOURCE_BUDGET});` },
    { ac: 'AC9 — the citation click-through', file: 'src/repoview.ts',
      remove: 'window.__openCitation = function (file, line) {',
      gone: 'window.__openCitation = function (file, line) {' },
    { ac: 'AC8 — the keep hook', file: 'src/repoview.ts',
      remove: 'window.__keepNote = function (question, answer) {',
      gone: 'window.__keepNote = function (question, answer) {' },
    { ac: 'AC8 — the question in the export', file: 'src/repoview.ts',
      remove: "if (nt.question) out.push('', '*Asked:* ' + nt.question);",
      gone: "'*Asked:* '" },
  ];

  let broken: string[];
  beforeAll(() => {
    broken = sabotagedPages(CASES.map((c) => ({ file: c.file, remove: c.remove })));
  }, 300_000);

  it('and the trap they guard against is still real', () => {
    // Not every marker self-matches — AC1's does not, because the page renders SOURCE_BUDGET
    // as a number while both this file and repoview.ts carry it as `${…}`. But the keep hook
    // is a plain literal that lives in this test file too, so a sabotaged page still contains
    // it and only `scripts()` can tell. If this ever goes green trivially, the toured file set
    // has changed and every assertion above needs re-examining.
    const keepHook = 'window.__keepNote = function (question, answer) {';
    expect(broken[2]!, 'the raw page should still self-match on a plain literal').toContain(keepHook);
    expect(scripts(broken[2]!)).not.toContain(keepHook);
  });

  for (const [i, c] of CASES.entries()) {
    it(`notices when ${c.ac} is deleted`, () => {
      expect(scripts(broken[i]!), `${c.ac} survived being deleted — that assertion is self-matching`)
        .not.toContain(c.gone);
      // and the healthy page has it, so the check is not vacuous in either direction
      expect(scripts(repoHtml)).toContain(c.gone);
    });
  }
});
