/**
 * Asset roots — injectable, so a consumer can point the core at asset roots of its
 * choosing instead of always resolving relative to this package's own install location.
 *
 * Why this exists: `src/skins.ts` and `src/extract.ts` used to locate their files purely
 * from `import.meta.url` / `require.resolve`, which is correct only when the code runs
 * from inside this repo's own checkout. A consumer that loads this package as a `file:`
 * or git dependency (the VS Code extension — see `.autodev/specs/T-11-core-package.md`)
 * still resolves correctly through that path, since the assets ship inside the package
 * (`files` in package.json), but a consumer that wants to override where assets live —
 * a test with a copied fixture directory, an extension host with its own layout — needs
 * a way in. This module is that way in.
 *
 * Three-tier resolution, checked in this order for each root independently:
 *
 *   1. explicit config, set via `configureAssets()`
 *   2. an environment variable (`REPO_TOUR_ASSETS`, `REPO_TOUR_GRAMMARS`)
 *   3. the packaged default (`import.meta.url` for assets, `require.resolve` for the
 *      grammars, which ship inside the `tree-sitter-wasms` dependency)
 *
 * Whatever is configured stays configured for the life of the process; `resetAssets()`
 * clears it back to tiers 2/3, which tests use so configuration from one case cannot
 * leak into the next.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

export interface AssetsConfig {
  /** Root directory containing `skins/`, `img/`, etc. Defaults to `<package>/assets`. */
  assetsDir?: string;
  /** Root directory containing tree-sitter grammar `.wasm` files. Defaults to `tree-sitter-wasms`'s own `out/` directory. */
  grammarsDir?: string;
}

let explicit: AssetsConfig = {};

/**
 * Set explicit asset roots. Merges onto whatever was configured before, so a caller that
 * only cares about one root can pass just that one without disturbing the other. Explicit
 * config always wins over the environment and the packaged default.
 */
export function configureAssets(config: AssetsConfig): void {
  explicit = { ...explicit, ...config };
}

/** Test-only: drop explicit configuration so the next call re-resolves from env or default. */
export function resetAssets(): void {
  explicit = {};
}

function packagedAssetsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
}

function packagedGrammarsDir(): string {
  const pkg = require_.resolve('tree-sitter-wasms/package.json');
  return path.join(path.dirname(pkg), 'out');
}

/** Where skins, images, etc. live: explicit config → `REPO_TOUR_ASSETS` → the packaged default. */
export function assetsDir(): string {
  if (explicit.assetsDir) return explicit.assetsDir;
  const env = (process.env['REPO_TOUR_ASSETS'] ?? '').trim();
  if (env) return env;
  return packagedAssetsDir();
}

/** Where grammar `.wasm` files live: explicit config → `REPO_TOUR_GRAMMARS` → `tree-sitter-wasms`'s own directory. */
export function grammarsDir(): string {
  if (explicit.grammarsDir) return explicit.grammarsDir;
  const env = (process.env['REPO_TOUR_GRAMMARS'] ?? '').trim();
  if (env) return env;
  return packagedGrammarsDir();
}
