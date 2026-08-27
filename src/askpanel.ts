/**
 * The Ask panel, as a client script both pages embed.
 *
 * One implementation, because two would drift: the repo tour and the PR page ask the same
 * kind of question and should answer it the same way. Each page supplies a `context()`
 * function returning what is currently on screen; everything else is here.
 *
 * The reader's notes are read straight out of localStorage and sent with every question.
 * That is the whole point of the ticket — an assistant that cannot see what you flagged
 * cannot help you review — and it is also why the notes never need to leave the browser
 * except when the reader asks something.
 */
export function askPanelScript(notesKey: string): string {
  return `
(function () {
  var NOTES_KEY = ${JSON.stringify(notesKey)};
  var log = document.getElementById('asklog');
  var input = document.getElementById('askinput');
  var send = document.getElementById('asksend');
  var note = document.getElementById('asknote');
  if (!log || !input || !send) return;

  var history = [];
  var busy = false;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function bubble(role, text, cls) {
    var d = document.createElement('div');
    d.className = 'askmsg ' + role + (cls ? ' ' + cls : '');
    // Code fences are the only markup worth honouring here; everything else stays literal
    // so a model that emits stray angle brackets cannot rewrite the page.
    var html = esc(text).replace(/\`\`\`([a-z]*)\\n([\\s\\S]*?)\`\`\`/g, function (_m, _l, body) {
      return '<pre>' + body + '</pre>';
    });
    d.innerHTML = html;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function readNotes() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); } catch (e) { return []; }
  }

  function ask() {
    if (busy) return;
    var q = input.value.trim();
    if (!q) { input.focus(); return; }

    bubble('you', q);
    input.value = '';
    history.push({ role: 'user', content: q });
    busy = true;
    send.disabled = true;
    var pending = bubble('bot', 'thinking…', 'pending');

    var ctx = (window.__askContext ? window.__askContext() : {}) || {};
    ctx.notes = readNotes();

    fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, context: ctx })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (out) {
        pending.remove();
        if (!out.ok || out.j.error) {
          bubble('bot', out.j.error || 'That did not work.', 'err');
          return;
        }
        bubble('bot', out.j.reply);
        history.push({ role: 'assistant', content: out.j.reply });
      })
      .catch(function () {
        pending.remove();
        // A static export has no server to answer. Say that, rather than failing silently
        // or spinning — this page is designed to be openable from a file:// URL.
        bubble('bot',
          'Nothing answered. If you opened this page as a saved file, there is no server behind it — run ./repo-tour serve and open it from there.',
          'err');
      })
      .finally(function () { busy = false; send.disabled = false; input.focus(); });
  }

  send.addEventListener('click', ask);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
  });

  function refreshNoteCount() {
    if (!note) return;
    var n = readNotes().length;
    note.textContent = n === 0
      ? 'It can see this page. Take notes and it can see those too.'
      : 'It can see this page and your ' + n + ' note' + (n === 1 ? '' : 's') + '.';
  }
  refreshNoteCount();
  window.__askRefresh = refreshNoteCount;
})();
`;
}

/** The panel's markup — the same in both pages, so it is written once. */
export function askPanelHtml(): string {
  return `
<div class="askwrap">
  <div class="asklog" id="asklog"></div>
  <div class="asknote" id="asknote"></div>
  <div class="askrow">
    <textarea id="askinput" rows="2" placeholder="Ask about this change, or about your notes…"></textarea>
    <button class="btn primary" id="asksend" type="button">Ask</button>
  </div>
</div>`;
}

export const ASK_CSS = `
.askwrap { display:flex; flex-direction:column; height:100%; min-height:0; }
.asklog { flex:1 1 auto; overflow:auto; padding:12px 14px; display:flex; flex-direction:column; gap:10px; min-height:120px; }
.askmsg { font-size:13px; line-height:1.6; padding:8px 10px; border-radius:8px; border:1px solid var(--line); }
.askmsg.you { background:var(--chip); }
.askmsg.bot { background:var(--bg); }
.askmsg.pending { opacity:.55; font-style:italic; }
.askmsg.err { border-color:var(--del-ink,#cf222e); color:var(--del-ink,#cf222e); }
.askmsg pre { margin:8px 0 0; padding:8px; overflow:auto; background:var(--chip); border-radius:6px;
              font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.asknote { padding:0 14px 8px; font-size:11px; color:var(--muted); }
.askrow { display:flex; gap:8px; padding:10px 12px; border-top:1px solid var(--line); align-items:flex-end; }
.askrow textarea {
  flex:1; resize:vertical; font:13px/1.5 inherit; padding:7px 9px; border-radius:6px;
  border:1px solid var(--line); background:var(--bg); color:var(--ink);
}
`;
