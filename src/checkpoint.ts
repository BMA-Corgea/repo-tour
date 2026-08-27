/**
 * The checkpoint — the digest you already have — and the one side PR mode has to compute.
 *
 * The first draft of this module checked out the base commit into a git worktree and
 * digested it. That was wrong, and Evan cut it at the spec gate: "I don't think I care
 * about interpreting historical commits yet." Re-reading his original framing showed it
 * had never been needed — he asked to compare a PR against "the ALREADY EXISTING
 * interpretation of the checkpoint". The checkpoint is not computed. It is the digest
 * sitting in `.repo-tour/` from the last time anyone ran repo-tour here.
 *
 * So only the changed files have to be read out of git, and nothing is ever checked out:
 * the user's working tree and index are never touched by PR mode. What lands in the temp
 * directory is the diff, not the repository.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CACHE_DIR, SCHEMA_VERSION, type DigestManifest, type DigestResult } from './digest.js';
import { extract } from './extract.js';
import { inventory } from './inventory.js';
import type { FileExtract, FileRecord, ImportGraph, RankedFile } from './types.js';
import type { TierDigest } from './rollup.js';

export interface Checkpoint {
  manifest: DigestManifest;
  files: FileRecord[];
  extracts: FileExtract[];
  graph: ImportGraph;
  ranked: RankedFile[];
  tiers: TierDigest[];
  /** the commit this digest represents, from the scan root's own repo */
  sha: string | null;
  generatedAt: string;
  /**
   * The checkpoint reassembled into the shape the renderer already understands.
   *
   * PR mode renders through `renderRepoView`, the same surface as a repo tour (criterion
   * 9), and that function reads a DigestResult. Rebuilding one here is what lets the PR
   * tour show the repository AROUND the change rather than a bare list of diffs — the
   * whole reason the checkpoint is worth having.
   */
  result: DigestResult;
}

export class NoCheckpointError extends Error {}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(root: string, ...args: string[]): string | null {
  try {
    return git(root, ...args).trim();
  } catch {
    return null;
  }
}

/**
 * Load the on-disk digest as the checkpoint.
 *
 * Refuses rather than silently digesting: a full digest is a real cost and a real wait,
 * and starting one the reader did not ask for — in the middle of what they thought was a
 * quick look at a PR — is exactly the kind of unannounced surprise §6 forbids.
 */
export function loadCheckpoint(root: string, outDir?: string): Checkpoint {
  const dir = outDir ?? path.join(root, CACHE_DIR);
  if (!fs.existsSync(path.join(dir, 'digest.json'))) {
    throw new NoCheckpointError(
      `no digest on disk for this repository (looked in ${path.relative(root, dir) || dir}).\n` +
        '  PR mode compares a change against the interpretation you already have, so there\n' +
        '  has to be one. Run:  repo-tour digest .\n' +
        '  (--no-cold suppresses this message and exits quietly.)',
    );
  }

  const manifest = readJson<DigestManifest>(path.join(dir, 'digest.json'));
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new NoCheckpointError(
      `the digest on disk is schema v${manifest.schemaVersion}; this build reads v${SCHEMA_VERSION}.\n` +
        '  Comparing against a digest written by a different shape of this tool would produce\n' +
        '  differences that are the format moving, not the code. Run:  repo-tour digest .',
    );
  }
  const index = readJson<Array<{ path: string; sha256: string }>>(path.join(dir, 'inventory.json'));
  const graph = readJson<ImportGraph>(path.join(dir, 'graph.json'));
  const ranked = readJson<RankedFile[]>(path.join(dir, 'ranked.json'));

  const files: FileRecord[] = [];
  const extracts: FileExtract[] = [];
  for (const row of index) {
    const blob = path.join(dir, 'files', `${row.sha256}.json`);
    if (!fs.existsSync(blob)) continue; // a partially-written cache degrades, it does not throw
    const payload = readJson<{ file: FileRecord; extract: FileExtract | null }>(blob);
    files.push(payload.file);
    if (payload.extract) extracts.push(payload.extract);
  }

  const tiersDir = path.join(dir, 'tiers');
  const tiers: TierDigest[] = fs.existsSync(tiersDir)
    ? fs
        .readdirSync(tiersDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<TierDigest>(path.join(tiersDir, f)))
    : [];

  const selfRepo = manifest.repos.find((r) => r.root === '') ?? manifest.repos[0];
  const result: DigestResult = {
    manifest,
    inventory: {
      root: manifest.root,
      repos: manifest.repos,
      files,
      skipped: manifest.skipped,
      stats: {
        dirsWalked: 0,
        filesSeen: files.length,
        filesRecorded: files.length,
        bytesRead: 0,
        wallMs: 0,
      },
    },
    extracts,
    graph,
    ranked,
    deepSlice: ranked.filter((r) => r.score > 0).map((r) => r.path),
    tiers,
    plan: null,
  };

  return {
    manifest,
    files,
    extracts,
    graph,
    ranked,
    tiers,
    sha: selfRepo?.head ?? null,
    generatedAt: manifest.generatedAt,
    result,
  };
}

export interface Staleness {
  /** the checkpoint's commit; null when the digest predates commit recording */
  sha: string | null;
  /** commits on the comparison base that the checkpoint has not seen */
  behind: number;
  /** files the checkpoint has not seen change, that this PR also touches — the real hazard */
  overlap: string[];
  /** true when the checkpoint IS the base — nothing has moved */
  current: boolean;
}

/**
 * How far behind the comparison base the checkpoint is, and — the part that matters —
 * whether anything that moved in between is also touched by this PR.
 *
 * A stale checkpoint is not an error and is not worth nagging about on its own. An overlap
 * is: it is the "two changes that are individually fine and jointly wrong" case, and it is
 * invisible in the PR's own diff. Spec §4 makes it a stop in the tour, not a footnote.
 */
export function staleness(
  root: string,
  checkpointSha: string | null,
  baseSha: string,
  prPaths: string[],
): Staleness {
  if (!checkpointSha) return { sha: null, behind: 0, overlap: [], current: false };
  if (checkpointSha === baseSha) return { sha: checkpointSha, behind: 0, overlap: [], current: true };

  const count = tryGit(root, 'rev-list', '--count', `${checkpointSha}..${baseSha}`);
  const changed = tryGit(root, 'diff', '--name-only', `${checkpointSha}..${baseSha}`);
  const moved = new Set((changed ?? '').split('\n').map((l) => l.trim()).filter(Boolean));
  return {
    sha: checkpointSha,
    behind: count ? Number(count) : 0,
    overlap: prPaths.filter((p) => moved.has(p)),
    current: false,
  };
}

export interface Side {
  /** the temp directory holding this side's changed files */
  dir: string;
  files: FileRecord[];
  extracts: FileExtract[];
  dispose: () => void;
}

/**
 * Read a set of paths at one commit and extract them.
 *
 * `git show <sha>:<path>` per file — no checkout, no worktree, no stash. The directory
 * that results holds the diff and nothing else, which is why this is affordable on a
 * repository of any size: the cost is the size of the change.
 *
 * `inventory()` runs over that directory rather than hand-building FileRecords, so
 * classification, hashing, line counting and binary detection stay in ONE implementation.
 * A second copy of those rules would drift from the digest's, and a PR tour that disagrees
 * with the repo tour about what a file even is would be worse than no PR tour.
 */
export async function sideAt(
  root: string,
  sha: string,
  paths: string[],
  /**
   * For a rename, the path to READ at this commit, keyed by the path to REPORT it under.
   *
   * Without this a rename reads as "the new path did not exist here", the base side comes
   * back empty, and every symbol in the file looks newly added — which scored a pure
   * rename of skins.ts -> themes.ts at 1.00 "meaning moved" with ZERO lines changed. A
   * rename is the one change git tells us is not a change at all.
   */
  readAs: Map<string, string> = new Map(),
): Promise<Side> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-tour-${sha.slice(0, 8)}-`));
  const dispose = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a temp directory we cannot remove is not worth failing a tour over */
    }
  };

  try {
    for (const rel of paths) {
      // The T-1 self-scan rule: a tool that writes into the tree it reads must exclude its
      // own output. Nothing should ever put the cache here, and if something does, this is
      // where it stops — one run would not show us the bug.
      if (rel === CACHE_DIR || rel.startsWith(`${CACHE_DIR}/`)) continue;

      const source = readAs.get(rel) ?? rel;
      let content: Buffer;
      try {
        content = execFileSync('git', ['-C', root, 'show', `${sha}:${source}`], {
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        continue; // absent on this side (added or deleted) — the diff set already says so
      }
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }

    const inv = inventory(dir);
    if (inv.files.some((f) => f.path === CACHE_DIR || f.path.startsWith(`${CACHE_DIR}/`))) {
      throw new Error('the digest cache reached a PR side directory — see T-1 lessons');
    }
    const { extracts } = await extract(dir, inv.files);
    return { dir, files: inv.files, extracts, dispose };
  } catch (err) {
    dispose(); // never leave a temp tree behind on a throw
    throw err;
  }
}
