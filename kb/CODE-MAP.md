# Code Map

The living code map (regenerable, Aider repo-map pattern): modules, their
exported symbols, and local import edges. LOCATE reads this first, then
verifies against reality; BUILD regenerates it at close-out.
Regenerate with `node scripts/code-map.mjs`. Do not hand-edit; changes
will be overwritten.

## src/cli.ts

- Exports: (none)
- Imports: (none)

## src/digest.ts

- Exports: CACHE_DIR, SCHEMA_VERSION, digest
- Imports: (none)

## src/extract.ts

- Exports: extract, initParsers
- Imports: (none)

## src/inventory.ts

- Exports: PARSEABLE, inventory
- Imports: (none)

## src/rank.ts

- Exports: MULTIPLIER, WEIGHTS, churnByFile, rank
- Imports: (none)

## src/types.ts

- Exports: (none)
- Imports: (none)
