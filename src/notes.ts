/**
 * Notes: the record shape, the storage key, and the export.
 *
 * The repo tour has had a notes panel since T-1's demo rebuild, wired tightly to its own
 * DOM (`window.__repo`, `window.__tour`). The PR page had none. The honest seam between
 * them is not the UI — anchoring a note on a file tree is a genuinely different gesture
 * from anchoring one on a diff — it is the RECORD. That is what gets exported, sent to a
 * reviewer, and read back by the Ask panel, and that is what must never drift.
 *
 * So the shape and the storage rules live here, and each page does its own anchoring.
 *
 * ⚠ Known duplication, recorded rather than hidden: the repo tour still renders notes with
 * its own copy of the list/export code. Lifting that out would mean rewriting a working,
 * tested panel for no change a reader would notice, so it is left alone and the SHAPE is
 * shared instead. If a third surface ever needs notes, lift it then.
 */

/**
 * Keyed to the repository — and to the pull request when there is one.
 *
 * Not to the commit: notes are review material, and losing them because the tour was
 * regenerated would defeat the point. Each note stamps the commit it was taken at instead,
 * so one written against older code is labelled rather than silently trusted.
 */
export function notesKey(repoName: string, pr?: number | null): string {
  return pr ? `repotour:notes:${repoName}#pr-${pr}` : `repotour:notes:${repoName}`;
}

/** The record. Every field here is provenance except `body`, which is the reader's. */
export interface NoteRecord {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  /** which tour stop was on screen; -1 when the reader was browsing rather than touring */
  stopIndex: number;
  stopTitle: string | null;
  /**
   * What the tour was SAYING when the note was written.
   *
   * This is the field that makes a note reviewable a week later: it records not only what
   * the reader flagged but what they were being told at the time. On a PR page it is the
   * file's narrative.
   */
  explanation: string | null;
  /** the commit the note was taken against */
  head: string | null;
  /** the code it is about, quoted, so the note survives the file moving */
  quote: string;
  body: string;
  /**
   * The question that produced this note, when it came out of the Ask panel (T-18 Q6).
   *
   * Optional, and that is not laziness: notes already written and sitting in somebody's
   * browser have neither this nor `source`, and they must keep rendering and keep exporting.
   * Every reader of a note therefore treats both as "might not be there".
   */
  question?: string;
  /** where the note came from; absent means the reader typed it themselves */
  source?: 'tutor';
}

/**
 * The record a kept tutor answer becomes.
 *
 * Q6 was answered "a keep button that drops it into the note box to trim", so the BODY is
 * whatever the reader leaves after trimming — their words, as every note body is. What the
 * exchange contributes is the provenance: the same anchor a hand-written note carries, plus
 * the question, so a week later the note says what was asked as well as what was concluded.
 *
 * This is the canonical shape. The two note panels each build it in their own browser code
 * (the duplication `notes.ts` has recorded since T-3 — lifting a working, tested panel out is
 * a rewrite nobody asked for); `test/notes.test.ts` pins both copies against this one.
 */
export function noteFromExchange(
  anchor: Omit<NoteRecord, 'id' | 'body' | 'question' | 'source'>,
  question: string,
  body: string,
  now = Date.now(),
): NoteRecord {
  return {
    ...anchor,
    id: `${now}-${anchor.startLine}`,
    body,
    question,
    source: 'tutor',
  };
}

/** The client-side notes panel for a diff-shaped page. */
export function notesPanelScript(key: string): string {
  return `
(function () {
  var KEY = ${JSON.stringify(key)};
  var el = {
    text: document.getElementById('ntext'), save: document.getElementById('nsave'),
    list: document.getElementById('nlist'), count: document.getElementById('ncount'),
    hint: document.getElementById('nhint'), anchor: document.getElementById('nanchor'),
    md: document.getElementById('nmd'), json: document.getElementById('njson')
  };
  if (!el.text || !el.save) return;

  var notes = [];
  // The question a kept answer came from, held between the Ask panel filling the box and the
  // reader pressing save. Cleared on every save so a typed note never inherits it.
  var pendingQuestion = '';
  try { notes = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { notes = []; }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch (e) {} }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function where(n) {
    return n.file + ':' + n.startLine + (n.endLine !== n.startLine ? '-' + n.endLine : '');
  }

  function render() {
    el.count.textContent = String(notes.length);
    if (!notes.length) {
      el.list.innerHTML = '<div class="nempty">No notes yet. Select lines in the diff, or just write — a note attaches to the file you are reading.</div>';
    } else {
      el.list.innerHTML = notes.map(function (n, i) {
        return '<div class="note">' +
          '<div class="nwhere">' + esc(where(n)) + (n.stopTitle ? ' <span class="nstop">· ' + esc(n.stopTitle) + '</span>' : '') + '</div>' +
          (n.quote ? '<pre class="nquote">' + esc(n.quote) + '</pre>' : '') +
          '<div class="nbody">' + esc(n.body) + '</div>' +
          '<button class="ndel" data-i="' + i + '" type="button">delete</button>' +
        '</div>';
      }).join('');
    }
    Array.prototype.forEach.call(el.list.querySelectorAll('.ndel'), function (b) {
      b.addEventListener('click', function () {
        notes.splice(Number(b.getAttribute('data-i')), 1);
        persist(); render(); refreshLinks();
        if (window.__askRefresh) window.__askRefresh();
      });
    });
    showAnchor();
  }

  function showAnchor() {
    var a = window.__noteAnchor ? window.__noteAnchor() : null;
    el.anchor.textContent = a
      ? 'will attach to ' + where(a)
      : 'open a file to attach a note';
  }

  el.save.addEventListener('click', function () {
    var body = el.text.value.trim();
    if (!body) { el.text.focus(); el.hint.textContent = 'write something first'; return; }
    var a = window.__noteAnchor ? window.__noteAnchor() : null;
    if (!a) { el.hint.textContent = 'open a file first, then this can attach to something'; return; }
    notes.push({
      id: String(Date.now()) + '-' + a.startLine,
      file: a.file, startLine: a.startLine, endLine: a.endLine,
      stopIndex: a.stopIndex, stopTitle: a.stopTitle || null,
      explanation: a.explanation || null,
      head: a.head || null,
      quote: a.quote || '',
      body: body,
      // Set only when the Ask panel handed this over (T-18 Q6). A typed note has neither,
      // and so does every note already sitting in somebody's browser.
      question: pendingQuestion || undefined,
      source: pendingQuestion ? 'tutor' : undefined
    });
    pendingQuestion = '';
    el.text.value = '';
    el.hint.textContent = 'saved';
    persist(); render(); refreshLinks();
    if (window.__askRefresh) window.__askRefresh();
  });

  function toMarkdown() {
    var out = ['# Review notes — ' + (window.__noteSubject ? window.__noteSubject() : 'this change'), ''];
    notes.forEach(function (n, i) {
      out.push('## ' + (i + 1) + '. ' + where(n));
      if (n.stopTitle) out.push('*While reading:* ' + n.stopTitle);
      if (n.question) out.push('*Asked:* ' + n.question);
      if (n.head) out.push('*At commit:* ' + n.head);
      out.push('');
      if (n.quote) out.push('\`\`\`', n.quote, '\`\`\`', '');
      out.push(n.body, '');
      if (n.explanation) out.push('> What the tour said here: ' + n.explanation, '');
    });
    return out.join('\\n');
  }

  function refreshLinks() {
    if (el.md) {
      el.md.href = URL.createObjectURL(new Blob([toMarkdown()], { type: 'text/markdown' }));
      el.md.download = 'review-notes.md';
    }
    if (el.json) {
      el.json.href = URL.createObjectURL(new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' }));
      el.json.download = 'review-notes.json';
    }
  }

  window.__notesChanged = function () { showAnchor(); };

  /**
   * The Ask panel handing an answer over to be kept (T-18 Q6).
   *
   * It PRE-FILLS rather than saving: the reader trims it to the sentence that mattered and
   * presses the same save button they always press. An answer kept whole would land in the
   * exported review notes whole, and export is the point of notes.
   */
  window.__keepNote = function (question, answer) {
    pendingQuestion = question || '';
    el.text.value = answer || '';
    el.hint.textContent = 'trim it to what matters, then save';
    var pane = document.querySelector('[data-pane="notes"]');
    if (pane) pane.click();
    el.text.focus();
  };

  render(); refreshLinks();
})();
`;
}

export function notesPanelHtml(): string {
  return `
<div class="noteswrap">
  <div class="nanchor" id="nanchor"></div>
  <textarea id="ntext" rows="3" placeholder="What did you notice?"></textarea>
  <div class="nrow">
    <button class="btn primary" id="nsave" type="button">Save note</button>
    <span class="nhint" id="nhint"></span>
    <span class="grow"></span>
    <a class="btn" id="nmd" href="#">.md</a>
    <a class="btn" id="njson" href="#">.json</a>
  </div>
  <div class="nlist" id="nlist"></div>
</div>`;
}

export const NOTES_CSS = `
.noteswrap { display:flex; flex-direction:column; height:100%; min-height:0; padding:12px 14px; gap:8px; }
.nanchor { font-size:11px; color:var(--muted); }
.noteswrap textarea {
  resize:vertical; font:13px/1.5 inherit; padding:7px 9px; border-radius:6px;
  border:1px solid var(--line); background:var(--bg); color:var(--ink);
}
.nrow { display:flex; gap:8px; align-items:center; }
.nrow .grow { flex:1 1 auto; }
.nhint { font-size:11px; color:var(--muted); }
.nlist { flex:1 1 auto; overflow:auto; margin-top:4px; display:flex; flex-direction:column; gap:8px; }
.nempty { font-size:12px; color:var(--muted); padding:8px 0; }
.note { border:1px solid var(--line); border-radius:8px; padding:9px 10px; background:var(--bg); }
.nwhere { font-size:11px; color:var(--muted); }
.nstop { font-style:italic; }
.nquote {
  margin:6px 0; padding:6px 8px; overflow:auto; background:var(--chip); border-radius:6px;
  font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.note .nbody { font-size:13px; line-height:1.55; white-space:pre-wrap; }
.ndel { margin-top:6px; font-size:11px; background:none; border:0; padding:0; color:var(--muted);
        cursor:pointer; text-decoration:underline; }
`;
