# Code Map

The living code map (regenerable, Aider repo-map pattern): modules, their
exported symbols, and local import edges. LOCATE reads this first, then
verifies against reality; BUILD regenerates it at close-out.
Regenerate with `node scripts/code-map.mjs`. Do not hand-edit; changes
will be overwritten.

## scripts/fetch-images.mjs

- Exports: (none)
- Imports: (none)

## src/adjudicate.ts

- Exports: ADJUDICATOR_VERSION, adjudicate
- Imports: (none)

## src/architecture.ts

- Exports: architectureBrief, buildArchitecture
- Imports: (none)

## src/ask.ts

- Exports: ASK_PERSONA, buildAskPrompt, buildContextBlock, trimMessages
- Imports: (none)

## src/askpanel.ts

- Exports: ASK_CSS, askPanelHtml, askPanelScript
- Imports: (none)

## src/assets.ts

- Exports: assetsDir, configureAssets, grammarsDir, resetAssets
- Imports: (none)

## src/checkpoint.ts

- Exports: NoCheckpointError, loadCheckpoint, sideAt, staleness
- Imports: (none)

## src/cli.ts

- Exports: (none)
- Imports: (none)

## src/codetour.ts

- Exports: buildArchitectureSteps, buildCodeTour
- Imports: (none)

## src/delta.ts

- Exports: claimsOf, fileDelta, meaningDistance, orderByMeaning, ripple, surfaceChange, vocabularyOf
- Imports: (none)

## src/diff.ts

- Exports: parseUnified, rawDiff, unifiedDiff
- Imports: (none)

## src/digest.ts

- Exports: CACHE_DIR, SCHEMA_VERSION, digest
- Imports: (none)

## src/extract.ts

- Exports: extract, initParsers
- Imports: (none)

## src/incremental.ts

- Exports: planIncremental
- Imports: (none)

## src/interpret.ts

- Exports: DEFAULT_MODEL, PROMPT_VERSION, SUMMARY_MAX, applyMeanings, defaultCacheDir, fullText, interpretArchitecture, interpretStops, stepKey, stopKey
- Imports: (none)

## src/inventory.ts

- Exports: PARSEABLE, inventory
- Imports: (none)

## src/library.ts

- Exports: findTour, listTours, newestFor, registryPath, renderLibrary, saveTour, toursDir
- Imports: (none)

## src/llm.ts

- Exports: DEFAULT_PROVIDER, PROVIDERS, killLlmChildren, providerById, resolveBin, resolveChoice, runLlm, surveyProviders
- Imports: (none)

## src/narrate.ts

- Exports: compress, narrate
- Imports: (none)

## src/notes.ts

- Exports: NOTES_CSS, notesKey, notesPanelHtml, notesPanelScript
- Imports: (none)

## src/pr.ts

- Exports: PrResolutionError, diffSet, hunks, issueRefs, lineCounts, listPrs, repoSlug, resolvePr
- Imports: (none)

## src/prflow.ts

- Exports: runPrFlow
- Imports: (none)

## src/prtour.ts

- Exports: band, buildPrTour, whyFor
- Imports: (none)

## src/prview.ts

- Exports: PANE_CSS, renderPrView
- Imports: (none)

## src/rank.ts

- Exports: MULTIPLIER, WEIGHTS, churnByFile, rank
- Imports: (none)

## src/repoview.ts

- Exports: HIGHLIGHTER, renderRepoView
- Imports: (none)

## src/rollup.ts

- Exports: rollup
- Imports: (none)

## src/server.ts

- Exports: RepoTourServer, fingerprint
- Imports: (none)

## src/skins.ts

- Exports: DEFAULT_SKIN, SKINS, alternateCss, baseCss, skinPicker, skinScript
- Imports: (none)

## src/tour.ts

- Exports: buildTourSteps
- Imports: (none)

## src/types.ts

- Exports: (none)
- Imports: (none)

## src/view.ts

- Exports: renderView
- Imports: (none)
