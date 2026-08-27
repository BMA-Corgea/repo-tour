# T-3 — vision conformance

**The intent is the oldest one on this project.** From the first session, 2026-08-25:

> *"Side panel for notes, each note carrying metadata for WHICH TOUR STEP inspired it, so
> post-tour code review is better than LGTM. Chatbot during the tour answering questions."*

Both halves are now real, on both surfaces. A note carries which stop inspired it **and what
that stop was saying**, and the assistant reads the notes back.

## The six pieces, as Evan described them on day one

| | |
|---|---|
| digest / understand a repo | **shipped** — T-1 |
| guided tour of the repo | **shipped** — early, under T-1 |
| notes panel with step provenance | **shipped** — T-3 |
| in-tour chatbot | **shipped** — T-3 |
| PR mode, before/after and *why* | **shipped** — T-5, T-8, T-9 |
| GONS integration | **still deferred** — T-7 |

Five of six. GONS is the one left, and it was always the endgame rather than the product.

## What this does not do

It reads a PR and lets you write notes about it. It does not **post** anything back to
GitHub. That is a different trust boundary — writing to someone's repository under their
credentials — and belongs in its own ticket once Evan has used the notes a few times and
knows what he wants sent.
