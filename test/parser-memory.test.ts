/**
 * T-31 AC3 — a file too big for the parser cannot take the rest down.
 *
 * web-tree-sitter runs one wasm instance per loaded copy of the package, with a heap capped at
 * 2 GiB. A file that needs more aborts it (`RuntimeError: Aborted()`), and on main every later
 * parse in the process then throws too, including in later digests in the same server: the
 * owner's `./start.sh` server runs for days. T-31 lets go of that copy, loads a fresh one, and
 * remembers the content that did it, so the same file is not parsed again in this process.
 *
 * In its own file because vitest runs each test file in its own process, and on main the abort
 * leaves this process's parser dead for every test after it.
 *
 * The fixture is the cheapest content measured to exhaust the heap: 12 MiB of unclosed
 * parentheses aborts in about 3 s at about 2.1 GB of memory (a 42 MB generated concatenation
 * takes about 20 s). Real code needs about 30 bytes of parser memory per byte, so a real file
 * gets there at tens of megabytes; this one only gets there sooner.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { digest, type DigestResult } from '../src/digest.js';

const MIB = 1024 * 1024;

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const EVENTS = ['uncaughtException', 'unhandledRejection', 'exit', 'beforeExit'] as const;
const listeners = (): Record<string, number> =>
  Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)]));

/**
 * A full collection, asked for from inside the test: vitest does not start this process with
 * --expose-gc. Node's docs warn that changing V8 flags after start-up can be unpredictable; this one
 * only makes `gc` available to new contexts, and it is the one way to ask for a collection here
 * without a vitest config for one file. (Review N5: kept, with this note. Without it the test would
 * wait on V8's own memory reducer, which took 6-10 s in the review's runs.)
 */
async function collect(): Promise<void> {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  await new Promise((r) => setTimeout(r, 50));
  gc();
}

/**
 * Collect until `back(reading)` holds, for up to 5 s, and return the last reading. A copy that has
 * been let go of is not always freed by the first collection: measured, once in a sequence of
 * digests, it took one more collection a second later (497 MiB, then 2 MiB).
 */
async function settle(read: () => number, back: (n: number) => boolean): Promise<number> {
  const deadline = Date.now() + 5000;
  for (;;) {
    await collect();
    const n = read();
    if (back(n) || Date.now() > deadline) return n;
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('T-31 AC3: a file that exhausts the parser is skipped, and the rest are still read', () => {
  it('the files after it, and the next digest in the same process, are read; its memory comes back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-t31-memory-'));
    try {
      // Sorted first, so every other file is parsed after the abort.
      write(path.join(root, 'src/a-catalog.js'), `var u = ${'('.repeat(12 * MIB)}`);
      write(path.join(root, 'src/b.js'), "const c = require('./c');\nfunction b() { return c.c(); }\nmodule.exports = { b };\n");
      write(path.join(root, 'src/c.js'), 'function c() { return 3; }\nmodule.exports = { c };\n');
      write(path.join(root, 'src/d.py'), 'import os\n\n\ndef d():\n    return os.sep\n');
      write(path.join(root, 'src/e.ts'), "import { b } from './b';\nexport function e(): number { return b(); }\n");
      const before = listeners();

      let first: DigestResult | undefined;
      let error: unknown;
      try { first = await digest(root, { write: false }); } catch (e) { error = e; }
      expect(error, `one file that exhausted the parser ended the digest: ${String(error)}`).toBeUndefined();

      expect(first!.manifest.unparsed, 'only the file that exhausted the parser belongs here: '
        + 'the files after it failed as well, on the parser it left dead').toEqual([
        { path: 'src/a-catalog.js', reason: 'the parser ran out of memory on it (its limit is 2 GiB)' },
      ]);
      expect(first!.extracts.map((x) => x.path), 'files parsed after the abort were lost')
        .toEqual(['src/b.js', 'src/c.js', 'src/d.py', 'src/e.ts']);
      expect(first!.graph.edges).toEqual([
        { from: 'src/b.js', to: 'src/c.js' },
        { from: 'src/e.ts', to: 'src/b.js' },
      ]);
      expect(first!.extracts.find((x) => x.path === 'src/d.py')?.imports.map((i) => i.raw)).toEqual(['os']);

      // A replacement copy of the parser adds no process-wide listeners: none to pile up in a long-running server.
      expect(listeners(), 'loading a fresh parser left listeners on the process').toEqual(before);

      // Let go of means let go of: the dead copy's heap is garbage, and a collection gives it back.
      const rss = await settle(() => process.memoryUsage().rss, (n) => n < 1024 * MIB);
      expect(rss, `the dead parser's 2 GiB is still held after a collection: rss ${Math.round(rss / MIB)} MiB`)
        .toBeLessThan(1024 * MIB);

      // The next digest in this process: the file is remembered, not parsed into the ground again.
      const second = await digest(root, { write: false });
      expect(second.manifest.unparsed).toEqual(first!.manifest.unparsed);
      expect(second.extracts.map((x) => x.path)).toEqual(['src/b.js', 'src/c.js', 'src/d.py', 'src/e.ts']);
      expect(second.manifest.cost.extractMs,
        `the second digest parsed the file again: ${second.manifest.cost.extractMs} ms against ${first!.manifest.cost.extractMs} ms`)
        .toBeLessThan(first!.manifest.cost.extractMs / 4);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('a large file that parses does not leave its heap behind for the life of the process (review S1)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-t31-grown-'));
    try {
      // 3 MiB of a generated concatenation: it parses, and grows the parser's heap to about 500 MiB on its way.
      write(path.join(root, 'src/big.js'), `var h = 'x'${"\n+'y'".repeat((3 * MIB) / 5)};\nmodule.exports = h;\n`);
      write(path.join(root, 'src/small.js'), 'function small() { return 1; }\nmodule.exports = { small };\n');
      await collect();
      const before = process.memoryUsage().external;

      const result = await digest(root, { write: false });
      expect(result.manifest.unparsed, 'the large file should parse').toEqual([]);
      expect(result.extracts.map((x) => x.path)).toEqual(['src/big.js', 'src/small.js']);

      const grownBy = await settle(() => process.memoryUsage().external - before, (n) => n < 150 * MIB);
      expect(grownBy, `the parser kept the heap a large file grew: ${Math.round(grownBy / MIB)} MiB more than before`)
        .toBeLessThan(150 * MIB);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
