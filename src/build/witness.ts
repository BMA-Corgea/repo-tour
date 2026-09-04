/**
 * The witness — WHEN the author actually wrote a file, read off git, never invented.
 *
 * `git log --diff-filter=A` answers a narrower question than plain `git log`: not every
 * commit that touched a path, but the one that ADDED it — the same distinction rank.ts's
 * `churnByFile` draws for "how often", drawn here for "since when". One walk per repo
 * root, `--reverse` so history is read oldest-first and the FIRST time a path appears IS
 * its add — no second pass to pick a minimum date by hand. A repo with no commits (or no
 * `.git` at all) yields nulls for everything under it, honestly, exactly like
 * `churnByFile` does for churn (kb/wiki/lessons.md: "Ask git what it already knows about
 * identity — never infer it from paths").
 *
 * The witness is shown, never used to order (spec §4.1) — `plan.ts` reads dates out of
 * this map only as a topological tiebreaker among files with no dependency between them.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { RepoRef } from '../types.js';

export interface Witness {
  sha: string | null;
  date: string | null;
  subject: string | null;
}

export const NULL_WITNESS: Witness = { sha: null, date: null, subject: null };

/**
 * A `git log --format=%H%x09%ad%x09%s` header line: 7-40 hex chars, a tab, an ISO date,
 * a tab, the rest of the line as the subject. Detecting headers this way (rather than by
 * blank-line position) is the point — `--name-only` prints the header, then a BLANK line,
 * THEN the names, so a state machine keyed on blank lines drops every name by resetting
 * right before it reads one. A path is vanishingly unlikely to contain a tab, so "does
 * this line look like the header" is unambiguous in practice.
 */
const HEADER = /^([0-9a-f]{7,40})\t(\d{4}-\d{2}-\d{2})\t(.*)$/;

/**
 * First-commit witness per file, across every repo root the digest found.
 *
 * Runs unconditionally on every repo; a repo with zero commits makes the underlying `git
 * log` fail (non-zero exit), which is caught and treated the same as "no repo at all" —
 * every path under it simply never enters the map, and callers read that as `null`.
 */
export function firstCommits(repos: RepoRef[]): Map<string, Witness> {
  const out = new Map<string, Witness>();

  for (const repo of repos) {
    let raw: string;
    try {
      raw = execFileSync(
        'git',
        [
          '-C', repo.absRoot, 'log', '--diff-filter=A', '--name-only',
          '--format=%H%x09%ad%x09%s', '--date=short', '--reverse',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 512 * 1024 * 1024 },
      );
    } catch {
      continue; // no commits yet — every file under this repo stays witness: null
    }

    const prefix = repo.root === '' ? '' : `${repo.root}/`;
    let current: Witness | null = null;

    for (const line of raw.split('\n')) {
      if (line === '') continue;
      const m = HEADER.exec(line);
      if (m) {
        current = { sha: m[1]!, date: m[2]!, subject: m[3]! };
        continue;
      }
      if (!current) continue; // defensive: a name line before any header has been seen
      const scanPath = path.posix.normalize(prefix + line.trim());
      // Oldest-first walk: the FIRST time a path is seen here is its add. A later
      // delete-then-re-add of the same path must not overwrite that earlier truth.
      if (!out.has(scanPath)) out.set(scanPath, current);
    }
  }

  return out;
}
