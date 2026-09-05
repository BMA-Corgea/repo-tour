/**
 * T-18 — the containment rule (AC2).
 *
 * A repo-tour server sits in front of somebody's private repositories, and T-18 lets a
 * language model name a path it would like to see. The model has no tools and no shell: it
 * emits a line of text and THIS decides what that line is allowed to mean. So this file is
 * mostly refusals, and they are the point.
 *
 * The rule under test is not "the path does not contain ..". It is "the path's REAL location,
 * symlinks resolved, is inside the repository's real root" — which is why a symlink planted
 * inside the repo is one of the cases below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInRepo, fetchFile, searchRepo, serveFetch, isScreenedPath } from '../src/fetchrepo.js';

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-fetch-'));
  root = path.join(base, 'repo');
  outside = path.join(base, 'secrets');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'rank.ts'), 'export function rank() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\nrank is scored here\n');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'THE SECRET');
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'index.js'), 'rank rank rank\n');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  fs.writeFileSync(path.join(root, '.env'), 'AWS_SECRET_ACCESS_KEY=hunter2\n');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n  url = https://user:ghp_TOKEN@github.com/x/y.git\n');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n');

  try {
    fs.symlinkSync(path.join(outside, 'private.txt'), path.join(root, 'escape.txt'));
    fs.symlinkSync(outside, path.join(root, 'escapedir'));
  } catch { /* a platform without symlinks skips those cases; the rest still hold */ }
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('resolveInRepo refuses everything that is not in the repository', () => {
  it('accepts an ordinary relative path', () => {
    // realpath on both sides: /tmp is itself a symlink on some platforms, and the function
    // deliberately hands back the RESOLVED path so a caller cannot re-resolve it later.
    expect(resolveInRepo(root, 'src/rank.ts')).toBe(fs.realpathSync(path.join(root, 'src', 'rank.ts')));
  });

  it('refuses a climb out with ..', () => {
    expect(resolveInRepo(root, '../secrets/private.txt')).toBeNull();
    expect(resolveInRepo(root, '../../etc/passwd')).toBeNull();
    expect(resolveInRepo(root, 'src/../../secrets/private.txt')).toBeNull();
  });

  it('refuses an absolute path, whatever it points at', () => {
    expect(resolveInRepo(root, '/etc/passwd')).toBeNull();
    // even one that happens to be inside: an absolute path is not a repo-relative path
    expect(resolveInRepo(root, path.join(root, 'src', 'rank.ts'))).toBeNull();
  });

  it('refuses a symlink that leaves the repository', () => {
    if (!fs.existsSync(path.join(root, 'escape.txt'))) return; // no symlinks on this platform
    expect(resolveInRepo(root, 'escape.txt')).toBeNull();
    expect(resolveInRepo(root, 'escapedir/private.txt')).toBeNull();
  });

  it('refuses a path that does not exist but WOULD have been outside', () => {
    // The check is on where the path resolves to, not on whether something is there now.
    expect(resolveInRepo(root, '../secrets/not-yet-written.txt')).toBeNull();
  });

  it('allows a path that does not exist but would be inside', () => {
    expect(resolveInRepo(root, 'src/not-yet.ts'))
      .toBe(path.join(fs.realpathSync(path.join(root, 'src')), 'not-yet.ts'));
  });

  it('refuses a null byte and an empty path', () => {
    expect(resolveInRepo(root, 'src/rank.ts\0.png')).toBeNull();
    expect(resolveInRepo(root, '')).toBeNull();
  });

  it('does not let a sibling directory pass on a prefix match', () => {
    // '/tmp/x/repo-evil' must not satisfy a startsWith test for '/tmp/x/repo'.
    const evil = `${root}-evil`;
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'gotcha.txt'), 'no');
    try {
      expect(resolveInRepo(root, '../repo-evil/gotcha.txt')).toBeNull();
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });
});

describe('fetchFile hands over what it is allowed to, and says why when it will not', () => {
  it('serves a file with its path on the first line', () => {
    const out = fetchFile(root, 'src/rank.ts');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toContain('src/rank.ts:');
    expect(out.body).toContain('return 1;');
    expect(out.what).toBe('file src/rank.ts');
  });

  it('refuses an escape with a reason a person can read', () => {
    const out = fetchFile(root, '../secrets/private.txt');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('outside the repository');
    expect(out.reason).not.toContain('THE SECRET');
  });

  it('distinguishes "not here" from "not allowed"', () => {
    const missing = fetchFile(root, 'src/nope.ts');
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toContain('there is no src/nope.ts');
  });

  it('lists a directory rather than refusing it', () => {
    // "what is in src?" is a real question; a refusal would teach the model nothing.
    const out = fetchFile(root, 'src');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toContain('is a directory containing');
    expect(out.body).toContain('rank.ts');
  });

  it('refuses a binary file instead of pasting bytes into a prompt', () => {
    const out = fetchFile(root, 'bin.dat');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('binary');
  });
});

describe('searchRepo', () => {
  it('reports file:line for every match', () => {
    const out = searchRepo(root, 'rank');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toMatch(/src\/rank\.ts:\d+:/);
    expect(out.body).toContain('README.md:2:');
  });

  it('never searches node_modules', () => {
    const out = searchRepo(root, 'rank');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).not.toContain('node_modules');
  });

  it('says plainly when there is nothing, rather than failing', () => {
    const out = searchRepo(root, 'zzzznotpresent');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toContain('No occurrence');
  });

  it('refuses a search too short to mean anything', () => {
    const out = searchRepo(root, 'a');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('too short');
  });
});

describe('serveFetch routes the two verbs', () => {
  it('sends file to fetchFile and search to searchRepo', () => {
    expect(serveFetch(root, { kind: 'file', arg: 'README.md' }).ok).toBe(true);
    const s = serveFetch(root, { kind: 'search', arg: 'scored' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.body).toContain('README.md');
  });
});

describe('secrets are not content (the auto-review finding)', () => {
  // searchRepo always skipped dot-entries and SKIP_DIRS; fetchFile did not, so the same
  // module refused to FIND 'hunter2' by search while happily serving `.env` by name. That
  // made the tutor the one component in repo-tour that would read a private repository's
  // secrets into a prompt — and the reader is only shown the fetch after the material has
  // already gone to the provider on the next hop.
  it('refuses a dotfile by name', () => {
    const out = fetchFile(root, '.env');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('not content');
    expect(out.reason).not.toContain('hunter2');
  });

  it('refuses anything inside .git', () => {
    expect(fetchFile(root, '.git/config').ok).toBe(false);
    expect(fetchFile(root, '.git').ok).toBe(false);
  });

  it('refuses dependency and build directories', () => {
    expect(fetchFile(root, 'node_modules/junk/index.js').ok).toBe(false);
  });

  it('does not advertise them in a directory listing either', () => {
    // A listing that names `.env` is a map to it.
    const out = fetchFile(root, '.');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).not.toContain('.env');
    expect(out.body).not.toContain('.git');
    expect(out.body).toContain('README.md');
  });

  it('still serves .github, which people legitimately tour', () => {
    const out = fetchFile(root, '.github/workflows/ci.yml');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toContain('name: ci');
  });

  it('agrees with searchRepo, which has always refused them', () => {
    const s = searchRepo(root, 'hunter2');
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.body).toContain('No occurrence');
  });

  it('is not fooled by a symlink with an innocent name', () => {
    // The name-based screen tested the path AS SPELLED while fetchFile read the RESOLVED
    // file, so `safe.txt -> .env` served the secret in full and `docs -> .git` served the
    // remote URL with its token. Found in review attempt 2; searchRepo never had the hole
    // because it skips symlinks outright.
    try {
      fs.symlinkSync(path.join(root, '.env'), path.join(root, 'safe.txt'));
      fs.symlinkSync(path.join(root, '.git'), path.join(root, 'docs'));
    } catch { /* already there, or a platform without symlinks */ }
    if (!fs.existsSync(path.join(root, 'safe.txt'))) return;

    const file = fetchFile(root, 'safe.txt');
    expect(file.ok).toBe(false);
    if (file.ok) return;
    expect(file.reason).toContain('not content');
    expect(file.reason).not.toContain('hunter2');

    const viaDir = fetchFile(root, 'docs/config');
    expect(viaDir.ok).toBe(false);

    // and the listing does not hand over the map to them either
    const listing = fetchFile(root, '.');
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.body).not.toContain('safe.txt');
    expect(listing.body).not.toContain('docs');
    expect(listing.body).toContain('README.md');
  });

  it('screens by segment, so a nested dotfile is caught too', () => {
    expect(isScreenedPath('src/.env')).toBe(true);
    expect(isScreenedPath('a/node_modules/b.js')).toBe(true);
    expect(isScreenedPath('src/rank.ts')).toBe(false);
    expect(isScreenedPath('.github/workflows/ci.yml')).toBe(false);
    expect(isScreenedPath('.github')).toBe(true);   // the leaf itself is not content
  });
});

describe('resolveInRepo hands back the resolved path, not the spelled one', () => {
  it('returns the real path so a caller cannot re-resolve a symlink after the check', () => {
    if (!fs.existsSync(path.join(root, 'insidelink'))) {
      fs.symlinkSync(path.join(root, 'src'), path.join(root, 'insidelink'));
    }
    const out = resolveInRepo(root, 'insidelink/rank.ts');
    expect(out).toBe(fs.realpathSync(path.join(root, 'src', 'rank.ts')));
  });
});
