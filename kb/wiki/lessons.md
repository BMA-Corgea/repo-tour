---
name: lessons
description: Durable lessons this project has learned — one entry per lesson, newest first, each citing the ticket it came from.
type: reference
---

# lessons

One entry per lesson, newest first, each citing the ticket or incident it came from.

---

## A control that silently declines is a broken control (T-3, 2026-08-26)

Evan: **"the button for note taking doesn't do anything."** He was right, and the cause was
a rule I had written on purpose: Save refused unless lines had already been clicked, and
said so only by changing a small grey hint line nobody looks at. You typed a thought, hit
the button, and nothing visible happened.

The rule itself was wrong, not just its feedback. **A note about "this file" is a perfectly
good note.** Save now anchors to what you are actually looking at — the current tour stop
if a tour is running, otherwise the visible lines of the open file — so the button always
does something true. There is an explicit *Anchor to what I'm looking at* control for when
you want to see the anchor before writing, and the hint says up front what a note would
attach to.

One follow-on that only showed up under test: an anchor picked while browsing survived into
the tour, so a note taken at stop 12 recorded "while browsing". The anchor now follows the
tour — moving to a stop drops a stale pick — because the provenance is the entire point of
the feature.

**The general rule: if a control can refuse, it must either not be enabled or must say so
where the eye already is. Silent refusal reads as a dead button.**

---

## An older tour is still true, so never make it unreachable (T-4, 2026-08-26)

Evan, working it out himself: **"Repo tour keeps resetting because we keep updating the
codebase. We need to be able to keep an old tour pinned even if it's changing. It needs to
not become unreachable, just a subtle note … while still being able to access it."**

He was right, and the design was wrong. `/r` served a tour only when the fingerprint matched
exactly; any edit sent it straight to a build page. So on a repository under active work —
which is every repository worth touring — the tour was unreadable most of the time, and each
edit cost minutes before anything could be read at all.

**A tour pinned to an older commit is still the truth about that commit.** It does not stop
being worth reading because a file changed. `/r` now serves the newest build it has, whatever
tree state it describes, and the card reports that build rather than claiming "no tour yet".

The staleness is a **corner chip**, not a banner, and that is the substance rather than the
styling: the page is still correct, so pushing the code down to announce it would interrupt a
reader who may not care yet. The chip states the fact, offers the rebuild, and — when a newer
build lands — offers the switch instead of taking it. Nobody gets yanked out of chapter six
because a build finished.

**The general rule: staleness is a property to disclose, not a reason to withhold.** The
version that refuses to show you anything until it is perfectly current is the version you
cannot use.

---

## A server that restarts itself must be able to STOP itself (T-4, 2026-08-26)

Evan, with a screenshot of his terminal: **"It gets caught up and I can't refresh when you
update it."** The log read:

    [tsx] change in ./src/interpret.ts  Process hasn't exited. Killing process...
    [tsx] change in ./src/server.ts     Process hasn't exited. Killing process...
    [tsx] change in ./src/cli.ts        Process hasn't exited. Killing process...

and then nothing. No "running at" line. The app was simply gone, and every refresh failed.

`tsx watch` was added so he would get updates without restarting — which made stopping happen
constantly, and the process had never been asked to stop cleanly before. Two things held it
open past the signal:

1. **Keep-alive sockets.** `server.close()` stops accepting new connections and then waits for
   existing ones to finish. Every open page polls every two seconds over keep-alive, so
   "existing" means "forever". They have to be DESTROYED, not waited on.
2. **In-flight model calls.** An interpretation runs for minutes. Those children are tracked
   now and killed on shutdown; the build resumes from its marker on the next boot, so nothing
   is lost by killing them.

`serve` handles SIGINT and SIGTERM, closes, and exits — with a 2.5s backstop so a wedged
handle cannot outlive the request to stop, and a second Ctrl-C that exits immediately.

Verified in exactly his shape: a build running with **four live model children**, a browser
polling over keep-alive, then a source file touched. Before: force-killed, nothing listening.
After: `SIGTERM — stopping.`, back up, and the build resumed itself.

**The general point: adding auto-restart to a long-running process is half a feature. The
other half is making the process stoppable, and nothing forces you to write it — the failure
only appears once restarts are frequent enough to catch the process busy.**

(The test written for this found a second bug: `listen()` reported the port it was ASKED for,
so `--port 0` — bind anything free — answered 0, which is not a port anyone can connect to.)

---

## An in-flight build must survive the process that started it (T-4, 2026-08-26)

Evan: **"Does the repo tour building reset every time the app resets? I've tried building it
so many times now."**

Yes, and it was my doing twice over. `tsx watch` was added so he would get updates without
restarting the app — and every commit I made restarted his server, killed the in-process
build, and put the card back to "no tour yet". He was racing my commits all session without
knowing it.

Reproduced exactly: job `running`, save one file in `src/`, job `idle`, card "NO TOUR YET".

**"No tour yet" is the worst possible presentation of a lost build.** Minutes of work vanish
and the only signal says you never started — so there is nothing to retry, only something to
begin again.

A build now writes a marker to `<repo>/.repo-tour/building.json`, kept current as it goes, and
a fresh server resumes any marker younger than six hours. Resuming is cheap because every
finished stop is already cached by content hash, so each attempt keeps its ground. Verified by
killing it twice mid-build: it resumed both times and finished at 29 stops.

**The general point: adding a restart trigger to a system with long-running in-process work
turns a convenience into a work-destroying loop.** The two features have to be designed
together — one of them makes restarts frequent, so the other must make them survivable.

---

## Two safe features combined into a reload loop (T-4, 2026-08-26)

Evan: **"when I click on a chapter to read through it pops me back to the beginning of the
tour"** — and he guessed it was another build interfering. It was not. Nothing he did caused
it, and nothing about chapters was wrong.

Two changes made an hour apart, each correct alone:

1. Live reload: the server's boot id is stamped into the page, which polls `/api/version`
   and reloads when it differs — so an update lands without a restart.
2. Persistence: rendered pages are cached to disk, so a build survives a restart.

Together: a page built by one server run gets served by a LATER run, carrying the earlier
run's boot id. The first poll disagrees, the page reloads, gets served from the same cache
with the same stale id, and reloads again — **every two seconds, forever.** Clicks looked
like they threw you back to stop 1 because the page really was restarting underneath.

The fix is to read the baseline at LOAD rather than bake it in, which makes the page
self-calibrating: it compares against the server it is actually talking to, cached or not.

**The general shape: an identity baked into a cached artifact is a lie the moment the
artifact outlives the thing it identifies.** Neither feature could show this in isolation,
and neither test covered the pair. What found it was counting page loads while clicking.

---

## "Not built yet" is a claim about the user's work, so it had better be true (T-4, 2026-08-26)

Evan: **"it's showing as not built yet"** — for both repositories, right after they had been
built.

The rendered page lived only in a `Map` in the server process. Everything expensive survived
a restart (the digest cache inside each repo, the interpretation cache keyed by content
hash), so a rebuild was quick and nothing was truly lost — but the LABEL said the work was
gone, and clicking through meant waiting again for something already finished.

This got much worse the moment the server started restarting on its own source changes: a
feature meant to remove friction turned the memory cache over constantly.

Built pages now persist to `<repo>/.repo-tour/rendered/<fingerprint>.html`, keyed by the
fingerprint so a page is only ever reused for the exact tree state it describes, keeping the
last four. Verified by killing the server outright: a fresh process reports "built: 34 stops,
up to date" and serves the finished 3.85MB page in 19ms with no rebuild.

**The general point: a cache that is only in memory is a cache that lies to the user every
time the process dies — not about correctness, but about whether their work still exists.**

---

## Test servers must not write to the real state file (T-4, 2026-08-26)

Evan, looking at the app: **"Did we lose the tours we made?"** His list showed one
throwaway repo from my own testing and nothing else.

The server persists its loaded repositories to `.cache/loaded.json`. Every throwaway server
I started for a test wrote to that same file, and I had been clearing it between runs to get
a clean slate — which meant my clean slate was HIS list.

Nothing expensive was lost, and it is worth being precise about why: the interpretation cache
is keyed by content hash and lives elsewhere (119 entries intact), and each repository's own
`.repo-tour/` digest cache is inside that repository (autoSQL: 415 files). Re-adding autoSQL
rebuilt it with **zero** interpretation calls. Only the LIST was destroyed, and a list is the
cheapest thing to rebuild — which is exactly why it was easy not to notice.

`--state <file>` now exists so a test server points somewhere disposable. **Any process
started for a test that writes to a path a real user's data also lives at is one keystroke
from destroying it, and the blast radius is invisible until someone looks at their own
screen.**

---

## The right photograph for a developer tool is not a photograph of code (T-5, 2026-08-26)

Evan: **"Give me some design on the landing page. It looks ugly and plain. GLP-Strong-App has
a pexels API key."**

GLP's image fetcher carries the rule that decided this: *"a wrong photograph is worse than no
photograph — it makes the thing look automated, which is the one thing a curated library must
not look like."* For a developer tool the obvious search is "code on a screen", and that is
exactly the wrong photograph: it is the stock cliché that says we had nothing to say, and a
reader who writes code all day does not need a picture of code.

The queries aim at STRUCTURE AT SCALE instead — stacks, staircases, halls. What came back is a
library in levels with a staircase cutting through it, which happens to BE the product's own
idea: enter at the top, descend to one shelf.

Three things ported from GLP's fetcher and worth keeping:

- **Download, never hotlink.** A third-party CDN has no business receiving a request from a
  page that lists the private repositories on someone's machine.
- **Attribution met twice** — `credits.json` beside the files, and a credit line on the page.
  Because it is an obligation it has to be legible, which over a photograph that is bright in
  one skin and dark in another means giving it its own backdrop.
- **Credits are data.** A run skips what it already has and collects no metadata for it, so
  rewriting the file from one run's results yields a list that silently drops rows.

The scrim is built from `var(--bg)`, so the same photograph reads warm under Titanium and cool
under Gunmetal without a second asset — and with no image at all the band renders a token
gradient, which is a designed state rather than a gap.

---

## Two skins ported, and what actually makes a look read (T-5, 2026-08-26)

Evan asked for GIMS-Project's **Classic** and then, from a Tales-of-era screenshot, a **JRPG**
skin. Both are one file plus one registry row, and both are more about structure than palette.

**Classic** (Win9x desktop): the colours are the least of it. What sells it is three bevel
tokens — raise, press, sunken — built from four insets each, per the 98.css technique, and the
fact that *documents are white and chrome is gray*. So the code pane became a sunken white
client area rather than a panel. The hero photograph is suppressed outright: a 2020s stock
photo under a Win2000 title bar is not a skin, it is a mistake wearing one.

**JRPG** (console menu): also not the colours. Three things, in order — the DOUBLE RULE (dark,
gold, dark) which is what reads as forged where a single gold border reads as a web alert;
LABEL versus VALUE, cream noun and gold number, which the product's muted/accent split already
encodes; and 2px corners, so it is neither a card nor a terminal.

**Where taste has to beat theme:** the JRPG skin puts a serif display face on headings and
leaves the code pane monospace on a quiet ground. The same serif over 1,500 lines of Python
would make the tool unreadable, and this is a reading tool before it is a costume.

---

## Styles are a swappable layer, not decoration (T-5, 2026-08-26)

Evan: **"the buttons are ugly. Check out the way the GLP-Strong-App has styles that can be
one shot. I want this repo set up like that as well."**

GLP-Strong-App's contract, now ported: **a skin is ONE file whose rules are all scoped under
`[data-theme="<name>"]`, plus ONE row in a registry.** Nothing else changes — the file is
picked up, the option appears in the switcher, the choice applies before first paint and
persists. The base file is special in exactly one way: it owns the bare `:root`, so it carries
the tokens AND the component layer. That is what makes an alternate that redefines nothing but
tokens re-skin the whole page, including anything added after that alternate was written.

Two departures from GLP, both forced by this product:

- **Every skin is inlined, not linked.** A generated tour must open from `file://` with no
  network, so there is nowhere to link to. Alternates ship inert in the page.
- **The app's own pages use the same files.** One contract, not two — the server's shell reads
  `base.css` and the alternates exactly as the tour renderer does.

The "ugly buttons" were also a genuine bug, not only taste: the chapter list rendered into
`#idletoc`, while the styles were scoped to `.toc button`. Unstyled, they fell back to inline
default buttons and wrapped into a hedge of pills. **Scoping a style to a class and then
rendering the markup somewhere that lacks it produces no error and no warning — only a
screenshot that looks wrong.**

---

## A module-relative path with a space in it silently wrote to the wrong place (T-5, 2026-08-26)

`path.dirname(new URL(import.meta.url).pathname)` does NOT decode percent-encoding. This
project lives under `Coding Projects`, so every module-relative path resolved to a directory
literally named `Coding%20Projects` — and `fs` happily CREATED it on the Desktop. The
interpretation cache (paid for with tokens), the tour registry and the loaded-repo list had
all been living there. 120 files. Nothing failed; it just went somewhere nobody would look.

Use `fileURLToPath(import.meta.url)`. `new URL('../x', import.meta.url)` passed straight to
`fs` is also fine — it is only taking `.pathname` as a string that breaks. A test now asserts
no resolved path contains a `%xx` escape.

---

## The button was not buried — the PAGE was scrolled (T-4, 2026-08-26)

Evan, twice: **"the tour button needs to be scrolled up to"**, then **"the green button is
still tucked in there"** after it had been moved into the sticky header.

Moving it was treating a symptom. `open()` kept the selected file-tree row visible with
`scrollIntoView({ block: 'nearest' })` — and **scrollIntoView scrolls every scrollable
ancestor, including the document.** The page opened already scrolled 58px, so the sticky
header sat over the bars beneath it. The button looked buried wherever it was put, because
the page had moved, not the button.

Measured: `window.scrollY === 58` immediately after load; the header's bottom edge overlapped
the next bar by exactly 58px. After scrolling the tree container by hand instead, scrollY is
0 on open and stays 0 when clicking a file far down the tree.

**The lesson beyond this bug: when a fix does not take, re-measure instead of adjusting the
fix.** The second report was the signal that the diagnosis, not the patch, was wrong. A test
now asserts the client script never calls scrollIntoView at all — container scrolling only.

---

## Put the primary action in the sticky header (T-4, 2026-08-26)

"Take the tour" sat in a bar under the sticky page header. Scroll at all and it slid
underneath — the button that starts the thing the page exists for required scrolling back
up to find. Measured: at 400px of scroll it sat at y=18 with the header occupying 0–99.

It now lives in the sticky header itself, verified at 0, 400, 1200 and 4000px of scroll.
Moving it also left the old one behind, so the page briefly shipped two `#start` buttons
with the second one dead — now caught by a test asserting no duplicate ids, plus one
asserting every id the client script reaches for is actually rendered.

---

## A generated file cannot be refreshed — the product had to become an app (T-4, 2026-08-26)

Evan: **"does my full refresh doesn't work for updating? ... essentially I need an app that
can load repos with tours into it. That way a refresh will enable seeing more updates."**

He was describing the fundamental limit of what had been built. `repo-tour tour` wrote a
self-contained HTML file, and a self-contained file never looks at the repository again.
Refreshing it re-reads the same bytes forever, and — worse — a stale tour is
indistinguishable from a fresh one.

`repo-tour serve` replaces it as the front door. Repositories are loaded in and stay
loaded; a refresh fingerprints the tree and rebuilds only if it actually moved. The static
export still exists (`repo-tour tour --view`) because a file you can send someone is a real
thing to want — but it is no longer the primary shape.

**What made the refresh affordable was already built.** Content-hash file reuse, the
interpretation cache, and incremental digest all existed for other reasons; together they
mean a refresh after one edit re-does one file's worth of work. An unchanged refresh is
served from memory in about 9ms.

**And the same self-referential trap bit twice.** The fingerprint was HEAD plus
`git status --porcelain` — but the digest writes its cache INTO the repo, so status always
reported it, the fingerprint changed on every build, and the page was permanently "stale",
rebuilding forever. The digest had already learned this lesson (`.repo-tour` is in
`NEVER_DESCEND`); the server had to learn it again. **Anything that reads a tree it also
writes to must exclude its own output — and a single run will never reveal the bug.**

---

## Client script lives inside TS template literals — parse it in a test (T-3, 2026-08-26)

The page's JavaScript is written as template literals in `src/repoview.ts` and inlined at
render time. That means every backslash is escaped twice, and getting it wrong produces a
page that renders perfectly and does nothing.

`f.text.split(/\\r?\\n/)` written with one backslash too few emitted a regex containing a
REAL newline: `Invalid regular expression: missing /`. The whole app script died on load,
so the file tree came back empty — a symptom nowhere near the cause.

**The guard:** a test pulls every `<script>` block out of the rendered page and runs it
through `new Function(code)`. It never executes anything; it only parses. Any escaping
mistake in any inlined script now fails a unit test instead of silently shipping a dead
page.

---

## A tour made only of files teaches you files (T-1, 2026-08-26)

The tour walked eight files well and left you knowing eight files. It could not tell you
what the system WAS, because "how the pieces talk" is not visible from inside any one of
them — and stage 5 had been rolling up directory and repo tiers since T-1 with nothing
reading them.

The architecture layer (`src/architecture.ts`) closes that. Three findings from building it:

1. **Nested repositories are the best possible subsystem boundary.** A repo boundary is an
   explicit statement by the authors that these things are separate. GUTS is eight repos and
   no directory heuristic beats saying so.
2. **Size a part by what it OWNS, never by its whole subtree.** Sizing from the recursive
   tier made containers look like parts: autoSQL collapsed to `demo`/`spikes`/`ops`, hiding
   the four real components inside `demo`, and GUTS listed its own scan root as a peer of
   its children with 1.8M lines. Ownership by longest path prefix lets `demo` and
   `demo/server` both be parts, with every file landing in exactly one.
3. **A part with no edges is not an entry point.** The layering put unconnected parts in the
   top row, which reads as "these are the ways in". They get their own row now, and the
   narration says plainly that nothing imports them in either direction.

The picture is layered by peeling the import graph — ways in at the top, foundations at the
bottom — because that ordering is the one thing a folder listing can never show.

---

## The LLM is a choice, and adding one is a single entry (T-1, 2026-08-26)

Evan: **"Abstract it one level up so it's not just runClaude, but that you can choose which
LLM you're using and make it easy to add another one."**

`src/llm.ts` is ported from GONS's `backend/app/llm_adapter.py`, which had already solved the
awkward parts. Three of them worth keeping:

1. **Providers are CLI shapes, not API clients.** `claude -p`, `codex exec --output-last-message`,
   or an HTTP POST to Ollama. That is what a subscription-based toolchain actually looks like.
2. **Binary resolution is env → PATH → a long list of known install locations.** The length of
   that list is the point: a globally installed node CLI lands in whichever of a dozen places
   the toolchain preferred, and a server started from a desktop launcher often has a PATH
   containing none of them. An explicit-but-broken override does NOT fall through — a typo in
   a path should fail loudly, not quietly use something else.
3. **An unavailable provider is a state, not a crash.** Availability is asked and displayed.

Two places repo-tour needed more than GONS:

- **The reply carries usage and cost**, because "cost is reported, not hidden" is an
  acceptance criterion. A provider that cannot report usage says so with `metered: false`
  rather than returning a zero that reads as free.
- **`runLlm` throws instead of returning `""`.** GONS returns an empty string on every
  failure; repo-tour shows per-file failures, so it needs the reason — and an empty string
  would be indistinguishable from a model with nothing to say.

**The cache key had to learn who wrote the answer.** A local 7B model and Sonnet do not
produce interchangeable prose, and serving one as the other would be a lie about the page. But
naively appending the writer would have discarded 119 explanations already paid for — so the
DEFAULT writer is absent from the key, keeping it byte-identical to the original format.
Switching provider builds a second cache alongside; switching back finds the first intact.

**And one bug the refactor created.** The in-memory results map was keyed the same way as the
cache filename, so once the key included the provider, `applyMeanings` — which recomputes keys
and has no business knowing which provider ran — silently failed to find anything a non-default
provider had written. The map is keyed by LOCATION now and the writer lives only in the
filename. **A cache key and a lookup key are not the same thing the moment one of them learns
something the other cannot know.**

---

## Interpretation runs through the local `claude` CLI, not an API (T-1, 2026-08-26)

There is no API key in this project and there is not meant to be. Evan has a Claude
subscription, so stage 4 spawns the `claude` binary from `PATH` — the same binary and the
same login as his terminal:

    claude -p --model claude-sonnet-5 --output-format json --allowedTools ''

Four choices worth keeping:

- **The prompt goes in on STDIN, never argv.** A prompt carrying a few hundred lines of
  source blows past the shell's argument limit on a large file.
- **`--output-format json`** returns an envelope with `usage` and `total_cost_usd`, which is
  where cost reporting comes from. It is measured, never estimated.
- **`--allowedTools ''`** — it gets the excerpt and answers about the excerpt. A stage that
  can read files and run commands is a different, much larger trust question.
- **Failure degrades rather than breaks.** A missing binary, a non-zero exit, an unparseable
  envelope, a reply that is not the JSON asked for — each is recorded per file and that file
  falls back to structural narration. A thin tour, not a crash.

**The gap that answering this exposed:** `doctor` checked node, git, dependencies and
grammars but not `claude`, so it could report "ready" while the one thing that makes a tour
explanatory was missing. Explaining a mechanism out loud is a decent way to find what nobody
verifies.

---

## Stage 4 is the product, and there is no template that substitutes for it (T-1, 2026-08-26)

Shown a tour stop on `main` that read *"A function at line 71. 95 lines. It is private to
cli.ts, so it can be changed in place."*, Evan said: **"that sure is saying very little
about how it works. We've explained nothing and we move on after this step."**

The instinct was to enrich the template — pull call graphs and control flow off the AST and
write a fuller sentence. That would have produced *"it parses argv, guards on the command,
calls digest(), then branches on --json"*: a narration of syntax the reader can already
see. **The "why" is not in the syntax, so no template can reach it.** Docstrings help only
where an author happened to write one; `main` had none.

Stage 4 — a model reading the actual source — is not an optimisation of the deterministic
path. It is the thing the other four stages exist to make affordable. On autoSQL it is
**5 calls and about $0.38** for a 14-stop tour, because stages 1-3 narrowed 365 files to 5.
Cached by content hash, so it is paid once.

**Rule:** when narration is thin, the answer is to interpret, not to template harder.

---

## Fit the container to the explanation, not the explanation to the container (T-1, 2026-08-26)

Stage 4's first answers were good and too long for the coachmark bubble, so the prompt was
told to "BE SHORT" — capping the explanation at 40 words to fit the UI.

Evan reversed it: **"We might need to readjust how we portray information so that we can
have longer explanations. I'm thinking like a textbook paragraph's worth of information."**

He was right, and the mistake was structural: a floating spotlight bubble is a UI for
*"click this button"* tooltips, not for teaching someone a codebase. Shrinking the teaching
to fit the tooltip was optimising the wrong side of the equation.

The guide is now a **docked third column** — tree, code, guide — sized for a real
paragraph. Explanations run 95-192 words, and the browser test asserts none of them is
clipped by the panel. The floating-bubble engine was dropped from this surface entirely;
the highlighted lines are the spotlight, so the dim overlay was never needed.

---

## I built the machinery's UI instead of the product's UI (T-1, 2026-08-26)

The first demo was a dashboard of score, churn, in-degree, LOC and classification, with a
tour that walked a viewer through *the dashboard*. Evan's verdict: **"There's no code on
the screen... This is nothing like the github repo format we were looking to recreate...
I need to know almost nothing about the score, churn, in LOG, class, or lang."**

He was right on every point, and the mistake is worth naming precisely because it is easy
to repeat.

**The metrics are how the engine DECIDES what to show you. They are not what a reader
wants to see.** They are load-bearing and they should be invisible — under the floor,
like a query planner. Putting them on screen and calling it a tour is showing someone the
scoring rubric instead of the thing being scored.

There was a second, compounding error: the demo was run against *repo-tour itself*. A
tool that reads repositories should never be demoed on its own source. The reader has no
stake in it, and it proves nothing about the hard case.

**The rule now:** the product surface is the repo — file tree, real source, line numbers,
a guide pointing at lines. Anything a reader would not care about belongs in
`repo-tour inspect`, which exists to judge digest QUALITY and is a different job.

---

## The author already wrote the "why" — read it before spending a token (T-1, 2026-08-26)

Deterministic narration can say what a function IS, how long it is, and who calls it. It
cannot say why it exists. That gap looked like it needed stage 4 (the paid stage).

It mostly does not. **Docstrings and leading comment blocks are the author explaining
their own code, and extracting them is free.** On autoSQL, 7 of 14 tour stops now quote
the author directly, including sentences no metric could ever produce: *"One pick → the
whole response body. Separated from the route so the suite drives the same code the
screen does, with no HTTP."*

Two consequences, both live in `src/codetour.ts`:

1. A stop's narration LEADS with the author's words when they exist.
2. Symbol selection **prefers documented symbols**. A documented 20-line function is a
   better stop than an undocumented 200-line one, because the reader leaves it knowing
   something.

Stage 4's job shrinks accordingly: it is for the code nobody explained, and for the
cross-file "why" no single docstring can carry.

---

## The digest must never digest its own cache (T-1, 2026-08-26)

Found by running the tool twice on its own repository during the `verify` stage — not by
any unit test, because a unit test never runs the tool twice against a root it just wrote
to.

Run 1 writes `.repo-tour/`. Run 2 then walks that directory and inventories ~100 cache
files as brand-new additions. The damage is not cosmetic: the incremental plan reports
fake additions, the reuse percentage is computed against a denominator the tool invented
(79 of 181 files → "44% reused" when the honest answer was 100%), and every parent tier is
marked stale by files that are the tool's own output.

`.repo-tour` is now in `NEVER_DESCEND`, and a regression test runs the digest twice and
asserts 100% reuse with zero additions.

**The general lesson:** any tool that writes into the tree it reads must exclude its own
output, and the bug is invisible to a single run. Verify by running twice.

---

## The import graph does NOT underdeliver on GUTS the way we assumed (T-1, 2026-08-26)

The T-1 spec and handoff both carry a warning that GUTS produces "124 edges across ~1M
lines" because its organs talk over HTTP contracts rather than imports, and that v1 must
not present a thin graph as a complete one.

**The real number is 3,247 edges, from 4,439 resolved imports out of 10,688 — 42%
coverage.** The 124-edge figure came from the throwaway Python probe on 2026-08-25, which
scanned far less of the tree than it appeared to (see the next lesson).

**What to keep and what to drop.** Drop the belief that the graph is nearly empty — it is
not, and design decisions made to compensate for a 124-edge graph would be solving a
problem that does not exist. **Keep the honesty requirement anyway:** 42% coverage means
6,249 imports leave the tree, and cross-service topology is still genuinely missing. The
graph states its own coverage in `digest.json` under `graphCoverage`, and that field
should never be dropped, however good the number gets.

---

## GUTS is roughly 5x larger than the design-session probe reported (T-1, 2026-08-26)

The 2026-08-25 Python probe reported **6 nested repos / 2,505 files / 1.02M LOC**. The
real inventory is **8 repositories / 11,958 files**, including a repo nested two levels
deep (`spine/L4-intent/goms/repos/Handbook-Generator`) that the probe missed entirely.

**Why it matters beyond bookkeeping:** the probe was cited as evidence in the spec's
ranking argument, and it was right about the *shape* of the problem while wrong about its
*size*. Any number inherited from that probe should be re-derived, not quoted. The
structural walk in `src/inventory.ts` is now the source of truth — it registers a repo at
every `.git` it encounters, at any depth, including `.git` files (worktrees/submodules).

---

## Stage 2 is numbered before stage 3 but must RUN after it (T-1, 2026-08-26)

The spec numbers the pipeline inventory → rank → extract, and that ordering is correct as
a *cost* argument: ranking is the cheaper idea, so it reads first.

But one of ranking's three signals is **in-degree**, and in-degree is a product of the
import graph that extraction builds. `digest.ts` therefore calls `extract` before `rank`
while reporting each under its own stage name. If a future change reorders these, ranking
silently loses 35% of its signal and every file scores as if nothing imported it — a
failure that produces plausible output and no error.

---

## Length ranks a repo backwards unless it is normalized AND weighted third (T-1, 2026-08-26)

Two separate mechanisms are required, and having only one is not enough:

1. **Weight LOC third** (churn 0.45, in-degree 0.35, size 0.20).
2. **log1p-normalize before weighting.** Plain max-normalization lets a single 38,367-line
   benchmark dump compress every real file toward zero, so the weights stop mattering.

Proven on GUTS: `manifest.yaml` — 96 lines, 134 commits — ranks **#6 of 11,958**, above
every benchmark file in the tree.

---

## A path segment alone must not classify prose as a test (T-1, 2026-08-26)

The first run of the classifier called `.autodev/specs/T-1-digest-engine.md` a `test`
because a path segment said `specs`, which damps its score by half. A design document in a
`specs/` folder may be the most valuable file in a repo.

**Rule now enforced:** a path segment (`test/`, `spec/`, `__tests__/`) only implies "test"
when the file is in a language a test can be written in. Filename patterns (`test_*.py`,
`*.test.ts`, `conftest.py`) still stand on their own. Caught by running the tool on its own
repo — worth doing after every classifier change.

---

## Churn must be counted in each file's OWN repository (T-1, 2026-08-26)

`git log` at the scan root sees only the parent repo's history. On GUTS that is 336
commits out of 1,701 across all 8 repos. `churnByFile` runs one `git log --name-only` per
discovered repo root and maps results back to scan-root-relative paths. A repo with no
commits yet yields zero churn for its files, which is true rather than an error.

## Ask git what it already knows about identity — never infer it from paths

**2026-08-27, T-5.** PR mode scored a pure file rename (`skins.ts` → `themes.ts`, zero
lines changed) at **1.00 "meaning moved"** — the maximum. It had read the base side at the
NEW path, found nothing there, concluded every symbol in the file was newly added, and let
the public-surface floor do the rest.

A rename is the one change git explicitly tells you is *not* a change: `git diff -M`
reports it as `R` with both paths. The tool asked for the diff, received that answer, and
then went and looked up the file by path anyway.

**The rule:** when a tool compares two versions of a tree, file IDENTITY comes from git's
own rename detection, not from matching path strings. Anywhere you resolve "the same file
on the other side", the old path is data you were already given.

**Why it stayed invisible:** every unit test constructed both sides directly, so no test
ever exercised a path that exists on one side and not the other. It surfaced only by
running the tool against a branch built to contain exactly one rename. Sibling of the T-1
lesson: a tool that reads a tree needs a fixture shaped like the case you are afraid of,
because the ordinary run will not show you.

## A cache keyed on the input must also be keyed on the code that transforms it

**2026-08-27, T-8.** The served repo page is cached against a fingerprint of the repository
tree. A new UI control shipped, the tree had not changed, and the cache kept serving the
page that predated the feature — so the feature was invisible to the only person who wanted
it. There is a `presentationVersion()` that hashes the renderer for exactly this, and the
one code path that mattered never consulted it.

**The rule:** any cache whose value is `f(input)` must invalidate on a change to `f`, not
only to `input`. If a version-of-the-code hash already exists, every read path checks it —
not just the ones that were convenient to write.

**Why it stayed invisible:** every test called the renderer directly and got fresh output.
Only the running server had a cache in front of it, and no test ran the server. Sibling of
the T-1 self-scan lesson and the T-5 rename lesson: three times now, the defect lived in
the gap between what the tests construct and what a person actually touches.
