/**
 * Resolving a pull request to a pair of commits.
 *
 * Everything downstream of this module compares two commits and does not know or care how
 * they were named. That is deliberate: a PR on GitHub and a branch you have not pushed yet
 * are the same problem, and only one of them needs the network.
 *
 * What GitHub adds — and the only reason the `gh` path exists at all — is the PROSE humans
 * wrote around the change: the title, the description, the commit messages, the issues it
 * closes. Spec §7 is strict that a claim about WHY a change was made must cite its source,
 * and these are the only sources there are. Git alone carries commit messages; GitHub
 * carries the rest.
 *
 * This module never guesses. A ref that does not resolve is a refusal, because the failure
 * mode of guessing a base is a tour that confidently explains the wrong diff.
 */

import { execFileSync } from 'node:child_process';

export interface PrCommit {
  sha: string;
  /** the full message, subject and body — spec §7's cheapest source of "why" */
  message: string;
}

export interface PrProse {
  title: string | null;
  body: string | null;
  commits: PrCommit[];
  /** issue references this PR closes, as `owner/repo#n` or `#n` */
  issues: string[];
  /** where the prose came from, so the tour can say how much it actually knows */
  source: 'github' | 'git-only';
}

export interface PrRefs {
  headSha: string;
  /** the commit the comparison is against — the landing point */
  baseSha: string;
  /** merge-base of head and base. Null when it IS the base (nothing moved since the fork). */
  forkSha: string | null;
  baseLabel: string;
  headLabel: string;
  /** commits on base that are not on head — how far the branch has fallen behind */
  baseAhead: number;
  prose: PrProse;
}

export class PrResolutionError extends Error {}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function tryGit(root: string, ...args: string[]): string | null {
  try {
    return git(root, ...args);
  } catch {
    return null;
  }
}

/** Resolve one ref, or refuse. Never falls back to HEAD, main, or anything else. */
function resolveRef(root: string, ref: string, role: string): string {
  const sha = tryGit(root, 'rev-parse', '--verify', `${ref}^{commit}`);
  if (!sha) {
    throw new PrResolutionError(
      `cannot resolve ${role} "${ref}" in this repository.\n` +
        `  A tour built on a guessed ${role} explains the wrong diff, so this stops here.\n` +
        `  Try: git rev-parse ${ref}    (and fetch first if it lives on the remote)`,
    );
  }
  return sha;
}

function commitsBetween(root: string, from: string, to: string): PrCommit[] {
  const raw = tryGit(root, 'log', '--format=%H%x00%B%x1e', `${from}..${to}`);
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [sha, message] = chunk.split('\x00');
      return { sha: (sha ?? '').trim(), message: (message ?? '').trim() };
    })
    .filter((c) => c.sha.length > 0);
}

export interface ResolveOptions {
  /** GitHub PR number. Mutually exclusive with base/head. */
  pr?: number;
  base?: string;
  head?: string;
  /** injectable so tests do not need a GitHub remote */
  gh?: (args: string[]) => string;
}

function ghJson(root: string, args: string[], run?: ResolveOptions['gh']): unknown {
  const raw = run
    ? run(args)
    : execFileSync('gh', ['-R', repoSlug(root) ?? '', ...args].filter(Boolean), {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
  return JSON.parse(raw) as unknown;
}

/** `owner/name` from the origin remote, or null when there is no GitHub remote. */
export function repoSlug(root: string): string | null {
  const url = tryGit(root, 'remote', 'get-url', 'origin');
  if (!url) return null;
  const m = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Resolve a PR (or a pair of refs) to the commits the rest of PR mode works on.
 *
 * The base is the LANDING point — where this change will actually come to rest — not the
 * fork point. Spec §4: you are reading a PR to decide whether to merge it, and the
 * interesting failures are the ones that only exist against what is on main now. The fork
 * point is still resolved and reported whenever it differs, because "main moved under this
 * branch" is a fact the reader needs and nothing else will tell them.
 */
export function resolvePr(root: string, opts: ResolveOptions): PrRefs {
  if (opts.pr !== undefined && (opts.base || opts.head)) {
    throw new PrResolutionError('give either a PR number or --base/--head, not both.');
  }

  if (opts.pr !== undefined) {
    const slug = repoSlug(root);
    if (!slug && !opts.gh) {
      throw new PrResolutionError(
        'no GitHub remote on this repository, so PR #' + opts.pr + ' cannot be looked up.\n' +
          '  Use --base <ref> --head <ref> instead; that path needs no network at all.',
      );
    }
    let raw: unknown;
    try {
      raw = ghJson(
        root,
        ['pr', 'view', String(opts.pr), '--json', 'headRefOid,headRefName,baseRefName,title,body,commits,closingIssuesReferences'],
        opts.gh,
      );
    } catch (err) {
      throw new PrResolutionError(
        `could not read PR #${opts.pr} through gh: ${(err as Error).message.split('\n')[0]}\n` +
          '  Check `gh auth status`, or use --base/--head to work offline.',
      );
    }
    const pr = raw as {
      headRefOid?: string;
      headRefName?: string;
      baseRefName?: string;
      title?: string;
      body?: string;
      commits?: Array<{ oid?: string; messageHeadline?: string; messageBody?: string }>;
      closingIssuesReferences?: Array<{ number?: number }>;
    };
    if (!pr.headRefOid || !pr.baseRefName) {
      throw new PrResolutionError(`PR #${opts.pr} did not report a head commit and a base branch.`);
    }
    const headSha = resolveRef(root, pr.headRefOid, 'head');
    const baseSha = resolveBaseBranch(root, pr.baseRefName);
    return assemble(root, headSha, baseSha, pr.headRefName ?? pr.headRefOid, pr.baseRefName, {
      title: pr.title ?? null,
      body: pr.body && pr.body.trim().length > 0 ? pr.body : null,
      commits: (pr.commits ?? []).map((c) => ({
        sha: c.oid ?? '',
        message: [c.messageHeadline ?? '', c.messageBody ?? ''].join('\n').trim(),
      })),
      issues: (pr.closingIssuesReferences ?? [])
        .map((i) => (typeof i.number === 'number' ? `#${i.number}` : ''))
        .filter(Boolean),
      source: 'github',
    });
  }

  if (!opts.base || !opts.head) {
    throw new PrResolutionError('give a PR number, or both --base and --head.');
  }
  const headSha = resolveRef(root, opts.head, 'head');
  const baseSha = resolveRef(root, opts.base, 'base');
  return assemble(root, headSha, baseSha, opts.head, opts.base, {
    title: null,
    body: null,
    commits: commitsBetween(root, baseSha, headSha),
    issues: [],
    source: 'git-only',
  });
}

/**
 * A PR's base is a BRANCH NAME, and the local copy of it may be stale or missing. Prefer
 * the remote-tracking ref, which is what the PR will actually land on, and fall back to a
 * local branch of the same name.
 */
function resolveBaseBranch(root: string, branch: string): string {
  const remote =
    tryGit(root, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`) ??
    tryGit(root, 'rev-parse', '--verify', `${branch}^{commit}`);
  if (!remote) {
    throw new PrResolutionError(
      `the PR targets "${branch}", which does not exist locally or as origin/${branch}.\n` +
        `  Fetch it first: git fetch origin ${branch}`,
    );
  }
  return remote;
}

function assemble(
  root: string,
  headSha: string,
  baseSha: string,
  headLabel: string,
  baseLabel: string,
  prose: PrProse,
): PrRefs {
  const mergeBase = tryGit(root, 'merge-base', baseSha, headSha);
  const forkSha = mergeBase && mergeBase !== baseSha ? mergeBase : null;
  const behind = tryGit(root, 'rev-list', '--count', `${headSha}..${baseSha}`);
  const commits = prose.commits.length > 0 ? prose.commits : commitsBetween(root, mergeBase ?? baseSha, headSha);
  return {
    headSha,
    baseSha,
    forkSha,
    baseLabel,
    headLabel,
    baseAhead: behind ? Number(behind) : 0,
    prose: { ...prose, commits },
  };
}

/** Files this PR touches, with their change kind — the diff set, and nothing wider. */
export function diffSet(
  root: string,
  from: string,
  to: string,
): Array<{ path: string; status: 'A' | 'M' | 'D' | 'R'; from?: string }> {
  const raw = tryGit(root, 'diff', '--name-status', '-M', `${from}..${to}`);
  if (!raw) return [];
  const out: Array<{ path: string; status: 'A' | 'M' | 'D' | 'R'; from?: string }> = [];
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    const code = (parts[0] ?? '').trim();
    if (!code) continue;
    if (code.startsWith('R') && parts.length >= 3) {
      out.push({ status: 'R', from: parts[1]!, path: parts[2]! });
    } else if (parts.length >= 2) {
      const status = code[0] as 'A' | 'M' | 'D';
      if (status === 'A' || status === 'M' || status === 'D') out.push({ status, path: parts[1]! });
    }
  }
  return out;
}
