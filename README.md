# repo-tour

**Be walked through a repository instead of opening it cold.**

Point it at a codebase you have never seen. It reads the whole tree, works out which few
files actually carry it, and builds a guided tour — the system first, then the code, with the
reasoning written by reading the lines it points at.

```bash
./start.sh          # opens http://127.0.0.1:7788
```

Load a repository, press **Build the tour**, and read.

---

## The problem it exists for

You can read code faster than you can be given time to read it. Handed an unfamiliar
repository — a new job, an acquisition, a dependency you now own, a pull request against
1,500 lines you did not write — the honest options are to spend a week, or to skim and hope.
Most review is the second one, and "LGTM" is what that sounds like.

The hard part is not reading a file. It is **not knowing which forty of four thousand files
to read, or in what order.** repo-tour answers that question first, and only then starts
explaining.

## How it works

Five stages. Four are deterministic and free; exactly one spends tokens, and it runs last —
by which point the field has been narrowed from thousands of files to a handful.

| Stage | What it does | Cost |
| --- | --- | --- |
| **1 · Inventory** | Walks the tree. Every nested `.git` is its own repository with its own history. Classifies each file from deterministic signals only — linguist markers, path patterns, generated headers, lockfile names. | free |
| **2 · Rank** | Churn, import in-degree, and — last — size. The order matters: on a real repo the five largest files are usually build exhaust, and the most important one is 96 lines. | free |
| **3 · Extract** | tree-sitter. Symbols, imports, call sites, public surface. A parser cannot invent a function that does not exist. | free |
| **4 · Interpret** | A model reads the actual lines and writes what they do and why. The only stage that spends anything. | tokens |
| **5 · Roll up** | files → directories → subsystems → repo, each tier written from the tier below. No step ever needs the whole repo in context. | free |

That ordering is the whole design. Everything cheap and exact runs first so the expensive
stage only ever reads what survived.

## What you get

- **The system before the code.** A diagram of the parts, which way imports flow between
  them, and one stop per part — then it descends into functions.
- **A tour in chapters.** The contents are visible before you start; begin at any chapter,
  skip one, jump back.
- **Notes with provenance.** Take a note at any stop and it records *which explanation
  prompted it*. Export as Markdown grouped by file. That is a review comment; "LGTM" is not.
- **Honest limits, on the page.** The import graph states its own coverage. The digest says
  which stages ran. A tour built before your last commit says so in the corner rather than
  disappearing.

## Cost

The paid stage sees only the tour itinerary — around six files out of however many you have —
and every explanation is cached by content hash. A first tour of a 365-file repository is a
handful of calls; a rebuild after editing one file re-does one file's worth of work.

Which model does that writing is a setting, not a hardcoded binary. Claude, Codex and a local
Ollama model ship as providers; adding another is one entry in `src/llm.ts`.

```bash
./repo-tour providers      # what can run here
./repo-tour doctor         # node, git, parsers, providers
```

## Also

- Everything runs on your machine. The server binds loopback only, because it serves the
  contents of your repositories.
- `repo-tour tour <path> --view out.html` exports a single self-contained file that opens
  offline — the whole repo page, the tour, and the notes panel, with no network at all.
- Four skins, and adding one is a single CSS file plus a row in `src/skins.ts`.

## Licence

[GNU AGPL v3](LICENSE.txt) or later. If you run a modified version somewhere other people can
reach, they are entitled to its source — which is why the interface carries a **Source** link
rather than burying the offer in a file nobody opens.
