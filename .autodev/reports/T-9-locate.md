# T-9 — Location report

## The one decision that caused five of six faults

`src/cli.ts` / `src/prflow.ts` end with:

```ts
renderRepoView(checkpoint.result, { steps: plan.steps, itinerary: plan.itinerary })
```

A PR tour is therefore **the repo page with different stops in the sidebar**. Everything
Evan listed follows from that: the file tree comes from `checkpoint.result.inventory` (the
whole repo), the code panel renders whole files from that inventory (so no diff, no
highlighting), there is no PR object in scope to link to, and a stop is a file+line range
because that is what the repo view can point at.

The sixth fault is in `src/prtour.ts:fileStop` — the summary is built as
`` `${verdict} · ${d.meaningDelta.toFixed(2)} · ${n} lines. ${reason}` ``, which puts the
score first and the change second.

## Targets

| file | what changes |
|---|---|
| **`src/prview.ts`** *(new)* | the PR page: file panel = the PR's files, code panel = a highlighted diff, header links the PR. Reuses `baseCss`/`skinScript` so it is the same product, not a second look |
| **`src/diff.ts`** *(new)* | parse `git diff -U6` into hunks of typed lines (`add`/`del`/`ctx`) for rendering. Deterministic; no model |
| `src/pr.ts` | `unifiedDiff(root, from, to, file)`; PR html_url on `PrRefs` |
| `src/adjudicate.ts` | the prompt gains **repo context** — the checkpoint's existing interpretation of the file, and its importers — and returns a `narrative`: what this PR proposes to change about code that does X |
| `src/prtour.ts` | stop text leads with the narrative; score demoted to a chip; ahead/behind removed from the default |
| `src/prflow.ts` | render through `renderPrView`, not `renderRepoView`; carry diffs through |
| `src/server.ts` | PR count on the repo page's tab; a loading state that says a PR is being interpreted |
| `src/repoview.ts` | the tab shows the count and reads as available |

## Not touched

The digest engine, the delta, the ripple, the narrator. The comparison is not what Evan
objected to — its **presentation** is.
