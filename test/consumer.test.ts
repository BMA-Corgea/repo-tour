/**
 * The consumer smoke test — proves the package works the way an EXTERNAL project (the VS
 * Code extension in `VSCode-LLM-Tutorial`, see `.autodev/specs/T-11-core-package.md`) will
 * actually use it: `import()` by package name, from outside this repo, unbundled, with
 * asset roots it can point wherever it likes.
 *
 * Every check that depends on Node's OWN module resolution (the exports map, subpath
 * imports, the `dist/*` wildcard) is run in a real spawned `node` subprocess rather than
 * through vitest's own resolver — that is the only way to prove what a real external
 * consumer will see, and it is what AC1's check literally asks for ("node -e import() of
 * each ... resolves"). Grammar-loading checks are ALSO run as subprocesses, for a second
 * reason: `src/extract.ts` caches an initialized parser per language for the life of the
 * process, so an in-process override test could pass by reading a stale cached parser
 * rather than the override — a subprocess starts with nothing cached.
 *
 * Import specifiers below are built from plain absolute path strings, never a hand-built
 * `file://` URL — this repo's own path contains a space ("Coding Projects"), which is
 * exactly the class of bug `pipeline.test.ts`'s "paths with spaces" test exists to catch.
 *
 * T-11 acceptance criteria covered here: AC1 (exports map), AC2 (injectable asset roots),
 * AC3 (a file:/git dependency gets `dist/` with no manual build step), AC4 (this file,
 * green), AC6 (no new runtime dependency).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { configureAssets, resetAssets } from '../src/assets.js';
import { baseCss, alternateCss } from '../src/skins.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = (name: string): string => path.join(REPO_ROOT, 'dist', `${name}.js`);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}
function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'fixture@test.local');
  git(dir, 'config', 'user.name', 'fixture');
}
function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message, '--allow-empty');
}

/** Run a small inline ESM script with `node` and report the outcome. Never throws. */
function runNode(script: string, opts: { cwd: string; env?: NodeJS.ProcessEnv }): {
  status: number; stdout: string; stderr: string;
} {
  const scriptFile = path.join(opts.cwd, `._probe-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(scriptFile, script);
  try {
    const res = spawnSync(process.execPath, [scriptFile], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      encoding: 'utf8',
    });
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }
}

let consumerDir: string;    // "a directory outside the repo" — node_modules/repo-tour symlinked in
let fixtureRoot: string;    // a tiny real git repo for the digest() smoke test (AC4)
let packDest: string;       // where `npm pack` puts its tarball (AC3)
let tarballConsumer: string; // a second, separate fresh dir the tarball gets installed into (AC3)

beforeAll(() => {
  consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-consumer-'));
  fs.mkdirSync(path.join(consumerDir, 'node_modules'), { recursive: true });
  fs.symlinkSync(REPO_ROOT, path.join(consumerDir, 'node_modules', 'repo-tour'), 'dir');
  write(path.join(consumerDir, 'package.json'), JSON.stringify({ name: 'consumer-probe', private: true, type: 'module' }));

  // A minimal but real git repo — digest() walks git history, so it needs one to run at all.
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-consumer-fixture-'));
  initRepo(fixtureRoot);
  write(path.join(fixtureRoot, 'src/app.tsx'), 'export function Hello(): null { return null; }\n');
  commitAll(fixtureRoot, 'initial');

  packDest = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-pack-'));
  tarballConsumer = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-tarball-consumer-'));
}, 30_000);

afterAll(() => {
  for (const dir of [consumerDir, fixtureRoot, packDest, tarballConsumer]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AC2's in-process tests mutate module-level config; never let one test's override leak
// into the next (skinsDir/grammarPath have no cache, but leaving config set is still a trap).
afterEach(() => resetAssets());

describe('AC1 — the exports map resolves subpaths from outside the repo', () => {
  it('resolves every declared module, plus package.json and the dist/* wildcard', () => {
    const subpaths = [
      'digest', 'interpret', 'llm', 'ask', 'skins', 'extract',
      'types', 'rollup', 'architecture', 'codetour', 'assets',
    ];
    const script = `
const subpaths = ${JSON.stringify(subpaths)};
let failures = 0;
for (const sub of subpaths) {
  try {
    await import('repo-tour/' + sub);
    console.log('OK ' + sub);
  } catch (err) {
    failures++;
    console.log('FAIL ' + sub + ' ' + (err.code ?? '') + ' ' + err.message);
  }
}
try {
  await import('repo-tour/package.json', { with: { type: 'json' } });
  console.log('OK package.json');
} catch (err) { failures++; console.log('FAIL package.json ' + err.message); }
try {
  await import('repo-tour/dist/skins.js');
  console.log('OK dist/skins.js');
} catch (err) { failures++; console.log('FAIL dist/skins.js ' + err.message); }
process.exit(failures === 0 ? 0 : 1);
`;
    const res = runNode(script, { cwd: consumerDir });
    expect(res.stdout + res.stderr).not.toMatch(/^FAIL/m);
    expect(res.status, res.stdout + res.stderr).toBe(0);
  });

  it('pre-adds ./build for T-12 without erroring — a missing target 404s, a missing map entry would not', () => {
    // T-11 writes this export path before T-12 exists so the two tickets never touch
    // package.json's exports at once (the locate's stated reason). Whichever state T-12 is
    // in when this runs, the export ENTRY itself must always be valid.
    const builtPath = path.join(REPO_ROOT, 'dist', 'build', 'index.js');
    const script = `
try {
  await import('repo-tour/build');
  console.log('RESOLVED');
} catch (err) {
  console.log('CODE:' + (err.code ?? 'NONE') + ' ' + err.message);
}
`;
    const res = runNode(script, { cwd: consumerDir });
    if (fs.existsSync(builtPath)) {
      expect(res.stdout).toContain('RESOLVED');
    } else {
      expect(res.stdout).toContain('CODE:ERR_MODULE_NOT_FOUND');
      expect(res.stdout).not.toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    }
  });
});

describe('AC2 — asset roots are injectable', () => {
  it('skinsDir reads through a copied+overridden assetsDir, not the packaged default', () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-assets-override-'));
    fs.cpSync(path.join(REPO_ROOT, 'assets'), overrideDir, { recursive: true });

    try {
      configureAssets({ assetsDir: overrideDir });

      // Reading through the override must match reading the original file directly —
      // the spec's own stated check ("baseCss() equal").
      expect(baseCss()).toBe(fs.readFileSync(path.join(REPO_ROOT, 'assets', 'skins', 'base.css'), 'utf8'));
      expect(alternateCss()).toContain('gunmetal');

      // Now prove the override is genuinely being read, not silently falling back to the
      // packaged default: mutate the COPY and confirm the change is visible.
      const sentinel = '/* T-11-OVERRIDE-SENTINEL */';
      fs.appendFileSync(path.join(overrideDir, 'skins', 'base.css'), `\n${sentinel}\n`);
      expect(baseCss()).toContain(sentinel);
      // The packaged default itself must be untouched by that mutation.
      expect(fs.readFileSync(path.join(REPO_ROOT, 'assets', 'skins', 'base.css'), 'utf8')).not.toContain(sentinel);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  it('grammarsDir override: only the grammar actually present in the override loads (subprocess — see file header)', () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-grammars-override-'));
    try {
      const defaultGrammars = path.join(REPO_ROOT, 'node_modules', 'tree-sitter-wasms', 'out');
      fs.copyFileSync(
        path.join(defaultGrammars, 'tree-sitter-python.wasm'),
        path.join(overrideDir, 'tree-sitter-python.wasm'),
      );
      // Deliberately NOT copying tree-sitter-javascript.wasm: if the override were ever
      // ignored in favour of the packaged default, requesting javascript would wrongly
      // succeed, because the default directory DOES have it.

      const script = `
const assetsMod = await import(${JSON.stringify(DIST('assets'))});
const extractMod = await import(${JSON.stringify(DIST('extract'))});
assetsMod.configureAssets({ grammarsDir: ${JSON.stringify(overrideDir)} });
try {
  await extractMod.initParsers(['python']);
  console.log('PYTHON_OK');
} catch (err) {
  console.log('PYTHON_FAIL ' + err.message);
}
try {
  await extractMod.initParsers(['javascript']);
  console.log('JAVASCRIPT_RESOLVED');
} catch (err) {
  console.log('JAVASCRIPT_FAIL ' + (err.code ?? '') + ' ' + err.message);
}
`;
      const res = runNode(script, { cwd: consumerDir });
      expect(res.stdout + res.stderr, res.stdout + res.stderr).toContain('PYTHON_OK');
      expect(res.stdout + res.stderr, res.stdout + res.stderr).toContain('JAVASCRIPT_FAIL');
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  it('REPO_TOUR_ASSETS / REPO_TOUR_GRAMMARS env vars are honored with nothing else configured', () => {
    const envAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-env-assets-'));
    const envGrammars = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-env-grammars-'));
    try {
      const script = `
const a = await import(${JSON.stringify(DIST('assets'))});
console.log('assetsDir=' + a.assetsDir());
console.log('grammarsDir=' + a.grammarsDir());
`;
      const res = runNode(script, {
        cwd: consumerDir,
        env: { REPO_TOUR_ASSETS: envAssets, REPO_TOUR_GRAMMARS: envGrammars },
      });
      expect(res.stdout).toContain(`assetsDir=${envAssets}`);
      expect(res.stdout).toContain(`grammarsDir=${envGrammars}`);
    } finally {
      fs.rmSync(envAssets, { recursive: true, force: true });
      fs.rmSync(envGrammars, { recursive: true, force: true });
    }
  });

  it('explicit configureAssets() wins over the environment', () => {
    const explicitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-explicit-assets-'));
    try {
      const script = `
const a = await import(${JSON.stringify(DIST('assets'))});
a.configureAssets({ assetsDir: ${JSON.stringify(explicitDir)} });
console.log('assetsDir=' + a.assetsDir());
`;
      const res = runNode(script, {
        cwd: consumerDir,
        env: { REPO_TOUR_ASSETS: '/should/not/win' },
      });
      expect(res.stdout).toContain(`assetsDir=${explicitDir}`);
    } finally {
      fs.rmSync(explicitDir, { recursive: true, force: true });
    }
  });
});

describe('AC4 — the consumer smoke test itself', () => {
  it('imports by package name, runs digest() on a fixture, and reads the skins', () => {
    const script = `
const { digest } = await import('repo-tour/digest');
const { baseCss, alternateCss } = await import('repo-tour/skins');

const result = await digest(${JSON.stringify(fixtureRoot)}, { write: false });
if (result.manifest.counts.files <= 0) throw new Error('digest saw no files');
if (result.manifest.counts.parsed <= 0) throw new Error('digest parsed nothing');

const base = baseCss();
if (base.length === 0) throw new Error('baseCss() is empty');

const alt = alternateCss();
if (!alt.includes('gunmetal')) throw new Error('alternateCss() does not include gunmetal');

console.log('CONSUMER_SMOKE_OK files=' + result.manifest.counts.files + ' parsed=' + result.manifest.counts.parsed);
`;
    const res = runNode(script, { cwd: consumerDir });
    expect(res.stdout + res.stderr, res.stdout + res.stderr).toContain('CONSUMER_SMOKE_OK');
    expect(res.status, res.stdout + res.stderr).toBe(0);
  }, 30_000);
});

describe('AC3 — a file:/git-style dependency gets dist/ with no manual build', () => {
  it('npm pack builds dist/ via prepare, and npm install from the tarball yields it too', () => {
    // Real npm, real filesystem — this is what a git dependency install and `npm publish`
    // both exercise; a file: link is the ONE case this does not cover (prepare does not run
    // for file: links), which is why dist/ is still committed-built for that path (README).
    const pack = spawnSync('npm', ['pack', '--pack-destination', packDest, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(pack.status, pack.stdout + pack.stderr).toBe(0);
    const packed = JSON.parse(pack.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const tarballName = packed[0]!.filename;
    const tarballPath = path.join(packDest, tarballName);
    expect(fs.existsSync(tarballPath)).toBe(true);

    // The tarball itself must contain a built dist/, not just source.
    const packedPaths = packed[0]!.files.map((f) => f.path);
    expect(packedPaths.some((p) => p === 'dist/digest.js')).toBe(true);
    expect(packedPaths.some((p) => p === 'dist/skins.js')).toBe(true);
    expect(packedPaths.some((p) => p.startsWith('src/'))).toBe(false);

    write(path.join(tarballConsumer, 'package.json'), JSON.stringify({ name: 'tarball-consumer', private: true, type: 'module' }));
    const install = spawnSync('npm', ['install', tarballPath, '--no-audit', '--no-fund'], {
      cwd: tarballConsumer,
      encoding: 'utf8',
    });
    expect(install.status, install.stdout + install.stderr).toBe(0);

    const installedDist = path.join(tarballConsumer, 'node_modules', 'repo-tour', 'dist');
    expect(fs.existsSync(installedDist)).toBe(true);
    expect(fs.existsSync(path.join(installedDist, 'skins.js'))).toBe(true);
    expect(fs.readdirSync(installedDist).length).toBeGreaterThan(0);
  }, 120_000);
});

describe('AC6 — no new runtime dependency', () => {
  it('package.json dependencies are exactly the two this ticket started with', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({
      'tree-sitter-wasms': '^0.1.12',
      'web-tree-sitter': '^0.25.10',
    });
  });
});
