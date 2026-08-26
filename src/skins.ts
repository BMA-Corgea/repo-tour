/**
 * The skin registry — the whole of what it costs to add a look.
 *
 * ── The contract (ported from GLP-Strong-App's `public/skins/` + `src/theme/themes.ts`) ──
 * A skin is ONE file at `assets/skins/<name>.css` whose rules are all scoped under
 * `:root[data-theme="<name>"]`, plus ONE row in `SKINS` below. Nothing else changes: the file
 * is inlined into every generated page, the option appears in the switcher, and the choice
 * applies on load and persists across reloads, automatically.
 *
 * THE FIRST ROW IS THE BASE and is special in exactly one way — it owns the bare `:root`, so
 * its rules are unscoped. It carries the tokens AND the component layer, which is why an
 * alternate that redefines nothing but tokens re-skins the whole page, including anything
 * added after that alternate was written.
 *
 * WHY EVERY SKIN IS INLINED RATHER THAN LINKED. A generated tour has to open from a `file://`
 * URL with no network at all — that is a product requirement, not an optimisation — so there
 * is nowhere to link to. Every skin ships in the page, inert until the attribute flips. They
 * are small enough (~70 lines each) that this costs nothing worth measuring against a page
 * already carrying the repository's source.
 *
 * The alternates are emitted AFTER the base so a scoped override wins ties on equal specificity.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Skin {
  /** URL-safe id. Also the `data-theme` value and the filename. */
  readonly name: string;
  /** What the switcher shows. */
  readonly label: string;
  /** One line — what this skin is for. */
  readonly note: string;
}

/**
 * The first row is the base. Add a skin by writing `assets/skins/<name>.css` and appending here.
 *
 * `system` is not a file: it is the absence of a `data-theme` attribute, which lets the base's
 * `prefers-color-scheme` block decide. It is first because a tool that opens in the wrong
 * brightness for someone's desk is a tool they close.
 */
export const SKINS: readonly Skin[] = [
  { name: 'system', label: 'System', note: 'Follows your OS light or dark setting.' },
  { name: 'dark', label: 'Dark', note: 'The base palette, always dark.' },
  { name: 'gunmetal', label: 'Gunmetal', note: 'Brushed graphite and one electric cyan.' },
  { name: 'titanium', label: 'Titanium', note: 'Warm light metal and a deep teal. Built for daylight.' },
  { name: 'classic', label: 'Classic', note: 'Win9x desktop — gray chrome, navy title bars, square corners.' },
  { name: 'jrpg', label: 'JRPG', note: 'A console menu screen: teal field, gold frames, cream text.' },
] as const;

/** The skin a page opens in when nothing is stored. */
export const DEFAULT_SKIN = 'system';

function skinsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'skins');
}

/** The base stylesheet: tokens plus the component layer. */
export function baseCss(): string {
  return fs.readFileSync(path.join(skinsDir(), 'base.css'), 'utf8');
}

/**
 * Every alternate skin's CSS, in registry order.
 *
 * A row with no file is skipped rather than throwing: `system` and `dark` are handled by the
 * base, and a half-added skin should cost you a missing option, not a page that will not build.
 */
export function alternateCss(): string {
  const dir = skinsDir();
  const parts: string[] = [];
  for (const skin of SKINS) {
    const file = path.join(dir, `${skin.name}.css`);
    if (!fs.existsSync(file)) continue;
    parts.push(fs.readFileSync(file, 'utf8'));
  }
  return parts.join('\n');
}

/** The switcher markup. */
export function skinPicker(): string {
  const options = SKINS
    .map((s) => `<option value="${s.name}" title="${s.note.replace(/"/g, '&quot;')}">${s.label}</option>`)
    .join('');
  return `<select class="skinpick" id="skinpick" aria-label="Skin">${options}</select>`;
}

/**
 * Applies the stored skin BEFORE first paint, then wires the switcher.
 *
 * Inlined ahead of the body so a chosen skin never flashes the default first — a page that
 * blinks white on the way to dark is worse than one that was always white.
 */
export function skinScript(): string {
  return `
(function () {
  var KEY = 'repotour:skin';
  var root = document.documentElement;
  function apply(name) {
    if (!name || name === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', name);
  }
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  apply(stored || ${JSON.stringify(DEFAULT_SKIN)});

  document.addEventListener('DOMContentLoaded', function () {
    var pick = document.getElementById('skinpick');
    if (!pick) return;
    pick.value = stored || ${JSON.stringify(DEFAULT_SKIN)};
    pick.addEventListener('change', function () {
      apply(pick.value);
      try { localStorage.setItem(KEY, pick.value); } catch (e) {}
    });
  });
})();
`;
}
