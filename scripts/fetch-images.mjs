/**
 * scripts/fetch-images.mjs — royalty-free photographs for the landing page.
 *
 *   node scripts/fetch-images.mjs              fetch anything missing
 *   node scripts/fetch-images.mjs --force      re-fetch everything
 *
 * Ported wholesale from GLP-Strong-App's `scripts/fetch-program-images.mjs`, and the rules in
 * that file's header apply here unchanged:
 *
 *   FILES ARE DOWNLOADED, NOT HOTLINKED. A third-party CDN has no business receiving a request
 *   from a page listing the private repositories on someone's machine, and a hotlinked image
 *   breaks a page that has to work with no network.
 *
 *   ATTRIBUTION IS MET TWICE: `credits.json` beside the files, and a credit line on the page.
 *
 *   THE CREDITS ARE DATA. A run skips files it already has and so collects no metadata for
 *   them; rewriting the credits from only what this run fetched produces a list that silently
 *   drops rows, which is worse than no list because it reads as complete.
 *
 * ── WHAT A RIGHT PHOTOGRAPH IS HERE ───────────────────────────────────────────────────────
 * The recipe fetcher's rule — "a wrong photograph is worse than no photograph, it makes the
 * thing look automated" — bites in a specific way for a developer tool. The obvious search is
 * "code on a screen", and that is the wrong photograph: it is the stock cliché that says we had
 * nothing to say, and a reader who writes code all day does not need a picture of code.
 *
 * The queries below aim at STRUCTURE AT SCALE — stacks, staircases, lattices, halls. They read
 * as "a large ordered thing you could get lost in and be walked through", which is what the
 * product is for, and they cannot be wrong about the audience the way a photo of a person at a
 * laptop can be.
 *
 * THE KEY IS NEVER WRITTEN INTO THIS REPOSITORY. It is read from PEXELS_API_KEY, or borrowed
 * from GLP-Strong-App's .env.local, which is where it already lives.
 *
 * REVIEW THE RESULT BY EYE BEFORE COMMITTING. That is the whole quality gate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'img');
const CREDITS_JSON = join(OUT, 'credits.json');
const CREDITS_MD = join(OUT, 'CREDITS.md');

/** slug → ordered searches, tried until one returns something usable. Short queries win. */
const QUERIES = {
  hero: ['library staircase', 'archive shelves', 'spiral staircase architecture'],
  'hero-alt': ['brutalist architecture', 'concrete structure', 'steel lattice'],
};

function apiKey() {
  if (process.env.PEXELS_API_KEY) return process.env.PEXELS_API_KEY;
  // Borrowed, not copied: read at fetch time, never persisted here.
  const glp = join(ROOT, '..', 'GLP-Strong-App', '.env.local');
  try {
    const line = readFileSync(glp, 'utf8').split('\n').find((l) => l.startsWith('PEXELS_API_KEY='));
    if (line) return line.slice('PEXELS_API_KEY='.length).trim();
  } catch { /* fall through to the honest error */ }
  return null;
}

async function search(key, query) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=8&orientation=landscape&size=large`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`pexels ${res.status} for "${query}"`);
  const body = await res.json();
  return body.photos ?? [];
}

async function main() {
  const force = process.argv.includes('--force');
  const key = apiKey();
  if (!key) {
    console.error('No PEXELS_API_KEY. Set it, or leave the images absent — the hero has a');
    console.error('designed fallback and the page is complete without them.');
    process.exit(1);
  }

  mkdirSync(OUT, { recursive: true });
  const credits = existsSync(CREDITS_JSON)
    ? JSON.parse(readFileSync(CREDITS_JSON, 'utf8'))
    : [];

  for (const [slug, queries] of Object.entries(QUERIES)) {
    const file = join(OUT, `${slug}.jpg`);
    if (existsSync(file) && !force) {
      console.log(`${slug}: already have it`);
      continue;
    }

    let picked = null;
    let used = '';
    for (const q of queries) {
      const photos = await search(key, q);
      // Prefer a dark photograph: the hero carries light text over a scrim, and a bright
      // image needs so much scrim that the photograph stops being visible at all.
      const dark = photos.filter((p) => (p.avg_color ?? '').match(/^#[0-6]/));
      picked = dark[0] ?? photos[0] ?? null;
      used = q;
      if (picked) break;
    }
    if (!picked) { console.log(`${slug}: nothing usable — leaving it absent`); continue; }

    const src = picked.src.large2x ?? picked.src.large;
    const bytes = Buffer.from(await (await fetch(src)).arrayBuffer());
    writeFileSync(file, bytes);

    const at = credits.findIndex((c) => c.slug === slug);
    if (at !== -1) credits.splice(at, 1);
    credits.push({
      slug,
      query: used,
      photographer: picked.photographer,
      photographerUrl: picked.photographer_url,
      pageUrl: picked.url,
      avgColor: picked.avg_color,
      file: `${slug}.jpg`,
    });
    console.log(`${slug}: "${used}" → ${picked.photographer} (${Math.round(bytes.length / 1024)} KB)`);
  }

  credits.sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(CREDITS_JSON, `${JSON.stringify(credits, null, 2)}\n`);
  writeFileSync(
    CREDITS_MD,
    [
      '# Image credits',
      '',
      'Photographs from [Pexels](https://pexels.com), downloaded rather than hotlinked.',
      '',
      '| File | Photographer | Source |',
      '| --- | --- | --- |',
      ...credits.map((c) => `| \`${c.file}\` | [${c.photographer}](${c.photographerUrl}) | [Pexels](${c.pageUrl}) |`),
      '',
    ].join('\n'),
  );
  console.log(`\ncredits written for ${credits.length} image(s)`);
}

await main();
