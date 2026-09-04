/**
 * The structural check — never a model, never a body comparison (spec §4.4).
 *
 * A learner's file is compared to the reference on exactly three axes: which exported
 * symbols exist (by name and kind), which imports are declared (by raw specifier), and
 * whether the file parses at all. Nothing about what a function DOES is ever inspected —
 * `extract()` only ever sees top-level declarations, so a renamed local variable inside a
 * function body is invisible to it by construction, which is what makes this check honest
 * about what it can and cannot catch.
 *
 * `extract()`'s parser map is module-private and `src/extract.ts` is T-11's file this
 * week, so rather than reach into it, this writes the learner's source to a throwaway
 * directory at the SAME relative path and calls `extract()` normally through its one
 * public function — never the module's internals.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extract } from '../extract.js';
import type { FileExtract, FileRecord, SymbolKind } from '../types.js';
import type { CheckReport } from './types.js';

/** name + kind, joined on a character neither can contain — the identity a symbol is compared by. */
function symbolKey(name: string, kind: SymbolKind): string {
  return `${kind}::${name}`;
}

function compare(reference: FileExtract, learner: FileExtract | undefined): CheckReport {
  const refExported = reference.symbols.filter((s) => s.exported);
  const learnerExported = learner ? learner.symbols.filter((s) => s.exported) : [];

  const refKeys = new Set(refExported.map((s) => symbolKey(s.name, s.kind)));
  const learnerKeys = new Set(learnerExported.map((s) => symbolKey(s.name, s.kind)));

  const symbols: CheckReport['symbols'] = [];
  for (const s of refExported) {
    symbols.push({ name: s.name, kind: s.kind, status: learnerKeys.has(symbolKey(s.name, s.kind)) ? 'present' : 'missing' });
  }
  for (const s of learnerExported) {
    if (!refKeys.has(symbolKey(s.name, s.kind))) symbols.push({ name: s.name, kind: s.kind, status: 'extra' });
  }

  // Unique raw specifiers, in the order the reference first declared them.
  const seenRaw = new Set<string>();
  const refRawInOrder: string[] = [];
  for (const i of reference.imports) {
    if (seenRaw.has(i.raw)) continue;
    seenRaw.add(i.raw);
    refRawInOrder.push(i.raw);
  }
  const learnerRaw = new Set((learner ? learner.imports : []).map((i) => i.raw));

  const imports: CheckReport['imports'] = refRawInOrder.map((raw) => ({
    raw, status: learnerRaw.has(raw) ? 'present' : 'missing',
  }));

  // A file `extract()` could not produce anything for at all (wrong language, empty read)
  // is reported as having at least one problem — never silently "clean".
  const parseErrors = learner ? learner.parseErrors : 1;

  const ok =
    symbols.every((s) => s.status !== 'missing') &&
    imports.every((i) => i.status !== 'missing') &&
    parseErrors === 0;

  return { symbols, imports, parseErrors, ok };
}

/**
 * Compare a learner's source against the reference's already-computed extract.
 *
 * `relPath` is the file's path relative to whatever root it belongs in — the same value
 * that would appear in a `FileRecord.path` — so the learner's write lands where a real
 * import in that file would expect its siblings to be, even though this check never reads
 * anything else from that throwaway tree.
 */
export async function check(
  learnerSource: string,
  referenceExtract: FileExtract,
  language: string,
  relPath: string,
): Promise<CheckReport> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-check-'));
  try {
    const dest = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, learnerSource);

    const record: FileRecord = {
      path: relPath,
      repo: '',
      bytes: Buffer.byteLength(learnerSource, 'utf8'),
      loc: learnerSource.split(/\r?\n/).length,
      language,
      sha256: '',
      classification: 'source',
      signals: ['check-harness'],
      binary: false,
    };

    const { extracts } = await extract(dir, [record]);
    return compare(referenceExtract, extracts[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
