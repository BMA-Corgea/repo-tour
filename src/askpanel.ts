/**
 * The Ask panel, as a client script both pages embed.
 *
 * One implementation, because two would drift: the repo tour and the PR page ask the same
 * kind of question and should answer it the same way. Each page supplies a `context()`
 * function returning what is currently on screen; everything else is here.
 *
 * The reader's notes are read straight out of localStorage and sent with every question.
 * That is the whole point of the original ticket — an assistant that cannot see what you
 * flagged cannot help you review — and it is also why the notes never need to leave the
 * browser except when the reader asks something.
 *
 * ── T-18: it remembers, it shows its working, and it can hand something back ─────────────
 * Three things changed, all of them the owner's own rulings on the decision form:
 *
 *  • The transcript is SAVED (Q3=B). It used to be one array in the page's memory, so a
 *    reload erased everything the reader had asked while their notes survived. Now it lives
 *    beside the notes in localStorage, one continuous thread per tour, each message stamped
 *    with the stop it was asked at and filterable to that stop.
 *  • The answer STREAMS, and every lookup is shown as it happens (Q1=C, Q4=A). The response
 *    is an event stream now, not one blob of JSON, because the tutor may go and read another
 *    file before it answers and the reader is owed the sight of that.
 *  • An answer can become a NOTE (Q6=B). The traffic used to run one way — it could read the
 *    reader's notes and never add to them.
 */

export interface AskPanelOptions {
  /** where the reader's notes live, so the panel can send them with every question */
  notesKey: string;
  /** where this tour's transcript lives, beside the notes */
  chatKey: string;
  /**
   * What to tell a reader whose page has no server behind it (Q9=A).
   *
   * A tour opened from disk can never ask anything — that is the accepted limit, not a bug —
   * so the message names the exact command that brings the tutor back rather than saying
   * something went wrong.
   */
  offlineHint: string;
}

export function askPanelScript(opts: AskPanelOptions): string {
  return `
(function () {
  var NOTES_KEY = ${JSON.stringify(opts.notesKey)};
  var CHAT_KEY = ${JSON.stringify(opts.chatKey)};
  var OFFLINE_HINT = ${JSON.stringify(opts.offlineHint)};
  // The server answered, then the connection broke: it is running, the line to it is not.
  var DROPPED_HINT = 'The connection to repo-tour dropped before the answer arrived. Ask again.';
  var log = document.getElementById('asklog');
  var input = document.getElementById('askinput');
  var send = document.getElementById('asksend');
  var note = document.getElementById('asknote');
  var scope = document.getElementById('askscope');
  if (!log || !input || !send) return;

  /** The saved conversation: every turn, stamped with where the reader was standing. */
  var msgs = [];
  var showAll = true;
  var busy = false;
  var live = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- the transcript -----------------------------------------------------

  function loadChat() {
    try {
      var raw = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (m) { return m && typeof m.content === 'string' && m.content.trim(); })
        .map(function (m) {
          return {
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.content),
            stopIndex: typeof m.stopIndex === 'number' ? m.stopIndex : -1,
            stopTitle: typeof m.stopTitle === 'string' ? m.stopTitle : null,
            file: typeof m.file === 'string' ? m.file : null,
            ts: typeof m.ts === 'number' ? m.ts : 0,
            citations: Array.isArray(m.citations) ? m.citations : null
          };
        });
    } catch (e) { return []; }
  }

  function saveChat() {
    // Never worth breaking the page for: a private window can refuse storage outright, and
    // an unsaved transcript is a smaller loss than a dead panel.
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs)); } catch (e) {}
  }

  function where() {
    var ctx = (window.__askContext ? window.__askContext() : {}) || {};
    return {
      stopIndex: typeof ctx.stopIndex === 'number' ? ctx.stopIndex : -1,
      stopTitle: ctx.stopTitle || null,
      file: ctx.file || null
    };
  }

  /** The last thirty turns, never opening on an assistant turn. */
  function forSending() {
    var out = msgs.slice(-30).map(function (m) { return { role: m.role, content: m.content }; });
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  function readNotes() {
    try { return JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); } catch (e) { return []; }
  }

  // ---- rendering ----------------------------------------------------------

  /**
   * An answer, with its file references turned into links.
   *
   * The verdicts come from the server (one implementation, with tests — the browser only
   * renders what it is handed). Citations inside a fenced code block are left alone: a path
   * in an example is not a claim about this repository.
   */
  function answerHtml(text, cites) {
    var marks = [];
    var fence = /\\u0060\\u0060\\u0060[a-z]*\\n([\\s\\S]*?)\\u0060\\u0060\\u0060/g;
    var m;
    while ((m = fence.exec(text)) !== null) {
      marks.push({ start: m.index, end: m.index + m[0].length, kind: 'pre', body: m[1] });
    }
    (cites || []).forEach(function (c) {
      for (var i = 0; i < marks.length; i++) {
        if (marks[i].kind === 'pre' && c.start >= marks[i].start && c.start < marks[i].end) return;
      }
      marks.push({ start: c.start, end: c.end, kind: 'cite', cite: c });
    });
    marks.sort(function (a, b) { return a.start - b.start; });

    var out = '';
    var pos = 0;
    marks.forEach(function (mk) {
      if (mk.start < pos) return;
      out += esc(text.slice(pos, mk.start));
      if (mk.kind === 'pre') out += '<pre>' + esc(mk.body) + '</pre>';
      else out += citeHtml(mk.cite, text.slice(mk.start, mk.end));
      pos = mk.end;
    });
    return out + esc(text.slice(pos));
  }

  function citeHtml(c, label) {
    var why = c.verdict === 'supplied' ? 'it was given this file'
      : c.verdict === 'unshown' ? 'this file is real, but it was never given it — check before you believe this'
      : 'there is no such file in this repository';
    if (c.verdict === 'unknown') {
      return '<span class="cite unknown" title="' + esc(why) + '">' + esc(label) + '</span>';
    }
    return '<a href="#" class="cite ' + c.verdict + '" title="' + esc(why) + '"' +
      ' data-file="' + esc(c.path) + '" data-line="' + (c.line || '') + '">' + esc(label) + '</a>';
  }

  function visible() {
    if (showAll) return msgs;
    var here = where().stopIndex;
    return msgs.filter(function (m) { return m.stopIndex === here; });
  }

  function render() {
    var rows = visible();
    log.innerHTML = rows.length ? '' : '<div class="askempty">Ask anything about what is on screen. ' +
      'It can see this page, your notes, and it can go and read another file if it needs one.</div>';
    rows.forEach(function (m, i) {
      var d = document.createElement('div');
      d.className = 'askmsg ' + (m.role === 'assistant' ? 'bot' : 'you');
      d.innerHTML = m.role === 'assistant' ? answerHtml(m.content, m.citations) : esc(m.content);
      if (m.stopTitle && showAll) {
        var tag = document.createElement('div');
        tag.className = 'askat';
        tag.textContent = 'at stop ' + (m.stopIndex + 1) + ' · ' + m.stopTitle;
        d.appendChild(tag);
      }
      if (m.role === 'assistant') d.appendChild(keepButton(rows, i));
      log.appendChild(d);
    });
    log.scrollTop = log.scrollHeight;
    refreshScope();
  }

  /** "Keep as note" — pre-fills the note box with the exchange, for the reader to trim. */
  function keepButton(rows, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'askkeep';
    b.textContent = 'keep as note';
    b.addEventListener('click', function () {
      if (!window.__keepNote) return;
      var question = '';
      for (var j = i - 1; j >= 0; j--) { if (rows[j].role === 'user') { question = rows[j].content; break; } }
      window.__keepNote(question, rows[i].content);
    });
    return b;
  }

  function refreshScope() {
    if (!scope) return;
    var here = where();
    var atHere = msgs.filter(function (m) { return m.stopIndex === here.stopIndex; }).length;
    scope.textContent = showAll
      ? (here.stopIndex >= 0 && atHere ? 'showing the whole tour · ' + atHere + ' here' : 'showing the whole tour')
      : 'showing this stop only';
    scope.setAttribute('data-all', showAll ? '1' : '0');
  }

  // ---- asking -------------------------------------------------------------

  function liveBubble() {
    var d = document.createElement('div');
    d.className = 'askmsg bot live';
    var steps = document.createElement('div');
    steps.className = 'asksteps';
    var body = document.createElement('div');
    body.className = 'askbody';
    body.textContent = 'thinking…';
    d.appendChild(steps);
    d.appendChild(body);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return { el: d, steps: steps, body: body, text: '', started: false };
  }

  function step(text, ok) {
    if (!live) return;
    var s = document.createElement('div');
    s.className = 'askstep' + (ok === false ? ' bad' : '');
    s.textContent = text;
    live.steps.appendChild(s);
    log.scrollTop = log.scrollHeight;
  }

  function grow(text) {
    if (!live) return;
    if (!live.started) { live.body.textContent = ''; live.started = true; }
    live.text += text;
    live.body.textContent = live.text;
    log.scrollTop = log.scrollHeight;
  }

  function fail(message) {
    if (!live) return;
    live.body.className = 'askbody err';
    live.body.textContent = message;
    live.el.classList.remove('live');
    live = null;
  }

  /** Read an event stream, calling back per frame. Frames are 'event: x\\ndata: {…}'. */
  function readStream(res, onFrame) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { flush(true); return; }
        buf += decoder.decode(r.value, { stream: true });
        flush(false);
        return pump();
      });
    }
    function flush(last) {
      var cut = buf.indexOf('\\n\\n');
      while (cut !== -1) {
        handle(buf.slice(0, cut));
        buf = buf.slice(cut + 2);
        cut = buf.indexOf('\\n\\n');
      }
      if (last && buf.trim()) handle(buf);
    }
    function handle(block) {
      var kind = /^event: (.+)$/m.exec(block);
      var data = /^data: (.+)$/m.exec(block);
      if (!kind || !data) return;
      try { onFrame(kind[1], JSON.parse(data[1])); } catch (e) {}
    }
    return pump();
  }

  function ask() {
    if (busy) return;
    var q = input.value.trim();
    if (!q) { input.focus(); return; }

    var w = where();
    msgs.push({ role: 'user', content: q, stopIndex: w.stopIndex, stopTitle: w.stopTitle, file: w.file, ts: Date.now() });
    saveChat();
    input.value = '';
    render();

    var history = forSending();
    busy = true;
    send.disabled = true;
    live = liveBubble();

    var ctx = (window.__askContext ? window.__askContext() : {}) || {};
    ctx.notes = readNotes();
    var connected = false;

    fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, context: ctx })
    })
      .then(function (res) {
        if (!res.ok || !res.body) {
          return res.json().then(function (j) { throw new Error(j.error || 'that did not work'); },
            function () { throw new Error('that did not work'); });
        }
        connected = true;
        var cites = null;
        return readStream(res, function (kind, data) {
          if (kind === 'fetch') {
            step(data.ok ? 'read ' + data.what : 'could not ' + data.what + ' — ' + data.detail, data.ok);
          } else if (kind === 'delta') {
            grow(data.text);
          } else if (kind === 'reset') {
            if (live) { live.text = ''; live.started = false; grow(data.text); }
          } else if (kind === 'error') {
            fail(data.message);
          } else if (kind === 'done') {
            cites = data.citations || null;
            if (live) {
              var w2 = where();
              msgs.push({
                role: 'assistant', content: live.text, stopIndex: w2.stopIndex, stopTitle: w2.stopTitle,
                file: w2.file, ts: Date.now(), citations: cites
              });
              saveChat();
              live = null;
              render();
            }
          }
        });
      })
      .catch(function (e) {
        // A stream that broke after it started is a dropped line, not a stopped server. Say
        // so in words, not the browser's ("Error in input stream" is Firefox's).
        if (connected) { fail(DROPPED_HINT); return; }
        // A static export has no server to answer. Say what to run, rather than failing
        // silently or spinning — this page is designed to be openable from a file:// URL.
        // Nothing answering is a TypeError in every browser, each in its own words (Chrome
        // "Failed to fetch", Firefox "NetworkError when attempting to fetch resource.", Safari
        // "Load failed"); the server's own refusals arrive as a plain Error with its message.
        // Checked by name, because a page's TypeError and a test VM's are different objects.
        fail(e && e.name === 'TypeError' ? OFFLINE_HINT : (e && e.message) || OFFLINE_HINT);
      })
      .finally(function () {
        if (live) { live.el.remove(); live = null; }
        busy = false; send.disabled = false; input.focus();
      });
  }

  send.addEventListener('click', ask);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
  });

  if (scope) {
    scope.addEventListener('click', function () { showAll = !showAll; render(); });
  }

  log.addEventListener('click', function (e) {
    var a = e.target.closest('a.cite');
    if (!a) return;
    e.preventDefault();
    if (window.__openCitation) {
      window.__openCitation(a.getAttribute('data-file'), Number(a.getAttribute('data-line')) || null);
    }
  });

  function refreshNoteCount() {
    if (!note) return;
    var n = readNotes().length;
    note.textContent = n === 0
      ? 'It can see this page and can read another file if it needs one. Take notes and it can see those too.'
      : 'It can see this page, your ' + n + ' note' + (n === 1 ? '' : 's') + ', and can read another file if it needs one.';
  }

  msgs = loadChat();
  render();
  refreshNoteCount();
  window.__askRefresh = refreshNoteCount;
  // The stop changed under us: the filter and the "n here" count are about where the reader
  // is standing now, so they are stale the moment the tour moves.
  window.__askStopChanged = function () { if (!showAll) render(); else refreshScope(); };
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
    <textarea id="askinput" rows="2" placeholder="Ask about this code, your notes, or anything the tour skipped…"></textarea>
    <button class="btn primary" id="asksend" type="button">Ask</button>
  </div>
  <button class="askscope" id="askscope" type="button" data-all="1">showing the whole tour</button>
</div>`;
}

export const ASK_CSS = `
.askwrap { display:flex; flex-direction:column; height:100%; min-height:0; }
.asklog { flex:1 1 auto; overflow:auto; padding:12px 14px; display:flex; flex-direction:column; gap:10px; min-height:120px; }
.askmsg { font-size:13px; line-height:1.6; padding:8px 10px; border-radius:8px; border:1px solid var(--line);
          white-space:pre-wrap; overflow-wrap:anywhere; }
.askmsg.you { background:var(--chip); }
.askmsg.bot { background:var(--bg); }
.askmsg.pending { opacity:.55; font-style:italic; }
.askmsg .askbody.err, .askmsg.err { border-color:var(--del-ink,#cf222e); color:var(--del-ink,#cf222e); }
.askmsg pre { margin:8px 0 0; padding:8px; overflow:auto; background:var(--chip); border-radius:6px; white-space:pre;
              font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.askempty { font-size:12px; color:var(--muted); padding:6px 0; }

/* what it looked at, while it looks */
.asksteps { display:flex; flex-direction:column; gap:2px; margin-bottom:6px; white-space:normal; }
.askstep { font-size:11px; color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.askstep::before { content:'· '; }
.askstep.bad { color:var(--del-ink,#cf222e); }

/* where a claim came from, and whether to trust it */
.cite { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em; }
a.cite.supplied { color:var(--acc,#0969da); text-decoration:underline; text-underline-offset:2px; }
a.cite.unshown { color:var(--amber-ink,#8a5a08); text-decoration:underline dotted; text-underline-offset:2px; }
.cite.unknown { color:var(--del-ink,#cf222e); text-decoration:line-through; }

.askkeep { display:block; margin-top:8px; font-size:11px; background:none; border:0; padding:0;
           color:var(--muted); cursor:pointer; text-decoration:underline; }
.askat { margin-top:6px; font-size:10.5px; color:var(--muted); font-style:italic; }
.asknote { padding:0 14px 8px; font-size:11px; color:var(--muted); }
.askrow { display:flex; gap:8px; padding:10px 12px; border-top:1px solid var(--line); align-items:flex-end; }
.askrow textarea {
  flex:1; resize:vertical; font:13px/1.5 inherit; padding:7px 9px; border-radius:6px;
  border:1px solid var(--line); background:var(--bg); color:var(--ink);
}
.askscope { margin:0 12px 10px; align-self:flex-start; font-size:11px; background:none; border:0; padding:0;
            color:var(--muted); cursor:pointer; text-decoration:underline; }
`;
