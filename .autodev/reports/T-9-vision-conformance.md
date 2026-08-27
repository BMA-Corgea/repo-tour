# T-9 — vision conformance

**Intent:** six faults Evan listed, verbatim, on the T-8 page. All six addressed:
the file panel is the PR's files; the diff is on screen and highlighted; the page links the
PR; the narration says what the PR is doing rather than reciting the score; ahead/behind is
gone; and the tab shows a real count and a reading state.

Plus two he found after: the style not following through (invented tokens with dark
fallbacks) and the building page hanging (one argument doing three jobs).

**The lesson worth keeping.** The failing stop text was `MEANING MOVED · 0.60 · 2 lines` —
the engine's rubric on screen instead of the reader's subject. That is precisely the failure
of the metrics demo he rejected on 2026-08-26, whose lesson was already in the KB when this
shipped. Writing a lesson down does not prevent it. It is now enforced by a test that fails
if a stop opens with a number, which is the only form of "remembered" that survives.
