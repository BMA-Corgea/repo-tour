/**
 * Stage 4 — Interpret. The only stage that spends tokens.
 *
 * Everything before this can say what code IS: its name, its size, what it imports, who
 * imports it, and whatever the author wrote in a docstring. None of that explains a
 * function nobody documented. That gap is not a template problem — the "why" is simply
 * not present in the syntax — so it is answered here, by a model reading the real source.
 *
 * Three properties keep this affordable:
 *
 *   1. It only ever sees the TOUR ITINERARY. Stages 1-3 narrow ~11,000 files to ~6, so
 *      this is a handful of calls, not thousands.
 *   2. Results are cached by CONTENT HASH, not path. A stop is paid for once; renaming a
 *      file, or re-running on a clone, re-uses it for free. Editing the lines invalidates
 *      only those lines.
 *   3. Every call reports its own tokens and cost, and the totals reach the manifest.
 *
 * It runs through the local `claude` CLI rather than the Anthropic API, because this is a
 * subscription tool, not an API-key tool.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CodeStep } from './codetour.js';
import type { FileExtract, FileRecord } from './types.js';

/**
 * Run the local `claude` CLI headlessly, feeding the prompt on stdin.
 *
 * stdin rather than argv on purpose: a prompt carrying a few hundred lines of source
 * would blow past the shell's argument limit on a large file.
 */
function runClaude(args: string[], input: string, cwd: string, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 200)}`));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

/** Bump when the prompt changes — old cached answers were produced by a different question. */
export const PROMPT_VERSION = 4;

export const DEFAULT_MODEL = 'claude-sonnet-5';

export interface StopMeaning {
  /** what this code does, in plain language */
  what: string;
  /** why it exists / what it is in aid of — or an honest admission that it is not inferable */
  why: string;
}

export interface InterpretCost {
  calls: number;
  cachedStops: number;
  interpretedStops: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  model: string;
  failures: string[];
}

export interface InterpretResult {
  /** keyed by the stable content key of each stop */
  meanings: Map<string, StopMeaning>;
  cost: InterpretCost;
}

/**
 * A stop's identity is its CONTENT, not its location: the file's content hash plus the
 * line range plus the prompt version. Same code, same answer, wherever it lives.
 */
export function stopKey(fileSha: string, startLine: number, endLine: number): string {
  return createHash('sha256')
    .update(`${PROMPT_VERSION}:${fileSha}:${startLine}-${endLine}`)
    .digest('hex')
    .slice(0, 32);
}

function numberedSlice(lines: string[], from: number, to: number): string {
  const out: string[] = [];
  const width = String(to).length;
  for (let i = from; i <= to && i <= lines.length; i++) {
    out.push(`${String(i).padStart(width)} | ${lines[i - 1] ?? ''}`);
  }
  return out.join('\n');
}

interface FileJob {
  file: string;
  sha: string;
  stops: Array<{ step: CodeStep; key: string; index: number }>;
}

const SYSTEM = [
  'You explain unfamiliar code to a developer who has never seen this repository.',
  'You are given real source, with line numbers, from one file.',
  'For each numbered EXCERPT, say what it does and why it exists.',
  '',
  'Rules:',
  '- Do NOT narrate syntax. "It parses argv, then loops over the results" is worthless:',
  '  the reader can see that. Explain the PURPOSE — what job this serves in the system,',
  '  what would break without it, what problem it is solving.',
  '- Write plainly, like a colleague talking. No bullet lists, no markdown, no headings.',
  '- Write a real paragraph, the length of a good textbook paragraph: roughly 80-140 words',
  '  for "what". This is read in a docked panel with room to breathe, so do not clip',
  '  yourself — but every sentence must earn its place. Do not pad, and do not walk the',
  '  code line by line; explain the job it does and the shape of how it does it.',
  '- "why": 1-2 sentences on why this exists or what it protects against.',
  '- If the reason genuinely cannot be inferred from what you were shown, say so in "why"',
  '  in one short sentence. Never invent history, tickets, incidents or motivations.',
  '- Name concrete identifiers from the code when they help.',
  '',
  'Reply with ONLY a JSON array, one object per excerpt, in order:',
  '[{"n":1,"what":"...","why":"..."}]',
  'No prose before or after the JSON. No code fences.',
].join('\n');

function buildPrompt(
  repoName: string,
  job: FileJob,
  file: FileRecord,
  extract: FileExtract | undefined,
  lines: string[],
  importers: number,
): string {
  const internal = (extract?.imports ?? []).filter((i) => i.resolved !== null).map((i) => i.raw);
  const parts: string[] = [];

  parts.push(`Repository: ${repoName}`);
  parts.push(`File: ${job.file} (${file.loc} lines, ${file.language ?? 'unknown language'})`);
  parts.push(
    importers > 0
      ? `Context: ${importers} other file${importers === 1 ? '' : 's'} in this repo import it.`
      : 'Context: nothing else in this repo imports it, so it is probably an entry point or a leaf.',
  );
  if (internal.length) parts.push(`It imports from inside this repo: ${internal.slice(0, 12).join(', ')}`);
  parts.push('');
  parts.push(`There are ${job.stops.length} excerpt${job.stops.length === 1 ? '' : 's'} to explain.`);
  parts.push('');

  job.stops.forEach((s, i) => {
    parts.push(`--- EXCERPT ${i + 1} — lines ${s.step.startLine}-${s.step.endLine} (${s.step.title}) ---`);
    parts.push(numberedSlice(lines, s.step.startLine, s.step.endLine));
    parts.push('');
  });

  parts.push(SYSTEM);
  return parts.join('\n');
}

function parseAnswer(raw: string, expected: number): Array<{ n: number; what: string; why: string }> | null {
  // The model was told to return bare JSON; be forgiving about fences and stray prose.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out = parsed
      .filter((x): x is { n: number; what: string; why: string } =>
        typeof x === 'object' && x !== null && typeof (x as { what?: unknown }).what === 'string')
      .map((x, i) => ({ n: typeof x.n === 'number' ? x.n : i + 1, what: x.what, why: typeof x.why === 'string' ? x.why : '' }));
    return out.length === expected ? out : out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface InterpretOptions {
  model?: string;
  cacheDir?: string;
  /** skip the model entirely and only use what is already cached */
  cachedOnly?: boolean;
  onProgress?: (msg: string) => void;
}

/** Where paid answers live. Content-keyed, so it is shared across every repo scanned. */
export function defaultCacheDir(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.cache', 'interpret');
}

export async function interpretStops(
  root: string,
  steps: CodeStep[],
  files: FileRecord[],
  extracts: FileExtract[],
  edges: Array<{ from: string; to: string }>,
  opts: InterpretOptions = {},
): Promise<InterpretResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });

  const fileByPath = new Map(files.map((f) => [f.path, f] as const));
  const extractByPath = new Map(extracts.map((e) => [e.path, e] as const));
  const importerCount = new Map<string, number>();
  for (const e of edges) importerCount.set(e.to, (importerCount.get(e.to) ?? 0) + 1);

  const meanings = new Map<string, StopMeaning>();
  const cost: InterpretCost = {
    calls: 0, cachedStops: 0, interpretedStops: 0,
    inputTokens: 0, outputTokens: 0, usd: 0, model, failures: [],
  };

  // Group the stops by file: one call per file, not one per stop.
  const jobs = new Map<string, FileJob>();
  steps.forEach((step, index) => {
    if (step.synthetic) return; // the tour's own words, not code to explain
    const f = fileByPath.get(step.file);
    if (!f) return;
    const key = stopKey(f.sha256, step.startLine, step.endLine);

    const cachePath = path.join(cacheDir, `${key}.json`);
    if (fs.existsSync(cachePath)) {
      try {
        meanings.set(key, JSON.parse(fs.readFileSync(cachePath, 'utf8')) as StopMeaning);
        cost.cachedStops++;
        return;
      } catch { /* corrupt cache entry — fall through and re-earn it */ }
    }
    if (opts.cachedOnly) return;

    if (!jobs.has(step.file)) jobs.set(step.file, { file: step.file, sha: f.sha256, stops: [] });
    jobs.get(step.file)!.stops.push({ step, key, index });
  });

  for (const job of jobs.values()) {
    const f = fileByPath.get(job.file)!;
    let text: string;
    try { text = fs.readFileSync(path.join(root, job.file), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);

    const prompt = buildPrompt(
      path.basename(root), job, f, extractByPath.get(job.file), lines,
      importerCount.get(job.file) ?? 0,
    );

    opts.onProgress?.(`interpreting ${job.file} (${job.stops.length} excerpt${job.stops.length === 1 ? '' : 's'})…`);

    let stdout: string;
    try {
      stdout = await runClaude(
        ['-p', '--model', model, '--output-format', 'json', '--allowedTools', ''],
        prompt, root,
      );
    } catch (e) {
      cost.failures.push(`${job.file}: ${(e as Error).message.slice(0, 160)}`);
      continue;
    }
    cost.calls++;

    let envelope: { result?: string; usage?: { input_tokens?: number; output_tokens?: number }; total_cost_usd?: number };
    try { envelope = JSON.parse(stdout) as typeof envelope; }
    catch { cost.failures.push(`${job.file}: could not parse the CLI envelope`); continue; }

    cost.inputTokens += envelope.usage?.input_tokens ?? 0;
    cost.outputTokens += envelope.usage?.output_tokens ?? 0;
    cost.usd += envelope.total_cost_usd ?? 0;

    const answers = parseAnswer(envelope.result ?? '', job.stops.length);
    if (!answers) {
      cost.failures.push(`${job.file}: the reply was not the JSON that was asked for`);
      continue;
    }

    for (const a of answers) {
      const slot = job.stops[a.n - 1];
      if (!slot) continue;
      const meaning: StopMeaning = { what: a.what.trim(), why: (a.why ?? '').trim() };
      meanings.set(slot.key, meaning);
      cost.interpretedStops++;
      try {
        fs.writeFileSync(path.join(cacheDir, `${slot.key}.json`), JSON.stringify(meaning, null, 2));
      } catch { /* an unwritable cache costs money next time, but never correctness */ }
    }
  }

  return { meanings, cost };
}

/**
 * A last-resort ceiling, not a style choice.
 *
 * The panel is sized for a textbook paragraph; this only catches a runaway answer, and it
 * cuts at a sentence boundary so the reader never loses half a thought.
 */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}

/** Merge interpretations into the tour, leaving deterministic text where none exists. */
export function applyMeanings(
  steps: CodeStep[],
  files: FileRecord[],
  meanings: Map<string, StopMeaning>,
): Array<CodeStep & { interpreted: boolean }> {
  const shaByPath = new Map(files.map((f) => [f.path, f.sha256] as const));
  return steps.map((s) => {
    if (s.synthetic) return { ...s, interpreted: false };
    const sha = shaByPath.get(s.file);
    const m = sha ? meanings.get(stopKey(sha, s.startLine, s.endLine)) : undefined;
    if (!m) return { ...s, interpreted: false };
    const why = m.why && m.why.length > 2 ? ` ${m.why}` : '';
    // Defensive: a model that over-runs the word budget must not produce an unreadable
    // bubble. Trim at a sentence boundary rather than mid-word.
    return { ...s, text: clamp(`${m.what}${why}`, 1400), interpreted: true };
  });
}

// ---------------------------------------------------------------- architecture

export interface ArchitectureMeaning {
  /** the system as a whole: what it is, how a request or a job moves through it */
  overview: string;
  /** part path -> what that part is for */
  purposes: Record<string, string>;
}

const ARCH_SYSTEM = [
  'You are explaining the SHAPE of an unfamiliar system to a developer who has never seen it.',
  'You are given its parts, their sizes, their most-weighted files, and the import flow between them.',
  '',
  'Rules:',
  '- Explain the SYSTEM, not the folder listing. What does this thing do, what are the pieces',
  '  for, and how does work move through them? Name the direction of flow if the imports show one.',
  '- The part names and file names are real evidence — use them.',
  '- Where the import graph shows nothing between parts, say plainly that they may talk over',
  '  something imports cannot see (HTTP, a queue, a shared database) rather than asserting',
  '  they are independent.',
  '- Plain prose, no markdown, no bullets, no headings.',
  '- "overview": 100-160 words. Each "purpose": 25-50 words, one or two sentences.',
  '- Never invent history or motivation you were not shown.',
  '',
  'Reply with ONLY this JSON shape and nothing else:',
  '{"overview":"...","parts":[{"path":"exact path as given","purpose":"..."}]}',
].join('\n');

/** Interpret the system's shape. One call, cached on the brief's own hash. */
export async function interpretArchitecture(
  root: string,
  brief: string,
  opts: InterpretOptions = {},
): Promise<{ meaning: ArchitectureMeaning | null; cost: InterpretCost }> {
  const model = opts.model ?? DEFAULT_MODEL;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });

  const cost: InterpretCost = {
    calls: 0, cachedStops: 0, interpretedStops: 0,
    inputTokens: 0, outputTokens: 0, usd: 0, model, failures: [],
  };

  const key = createHash('sha256').update(`arch:${PROMPT_VERSION}:${brief}`).digest('hex').slice(0, 32);
  const cachePath = path.join(cacheDir, `${key}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      cost.cachedStops = 1;
      return { meaning: JSON.parse(fs.readFileSync(cachePath, 'utf8')) as ArchitectureMeaning, cost };
    } catch { /* re-earn it */ }
  }
  if (opts.cachedOnly) return { meaning: null, cost };

  opts.onProgress?.('interpreting the system as a whole…');

  let stdout: string;
  try {
    stdout = await runClaude(
      ['-p', '--model', model, '--output-format', 'json', '--allowedTools', ''],
      `${brief}\n\n${ARCH_SYSTEM}`, root,
    );
  } catch (e) {
    cost.failures.push(`architecture: ${(e as Error).message.slice(0, 160)}`);
    return { meaning: null, cost };
  }
  cost.calls = 1;

  let envelope: { result?: string; usage?: { input_tokens?: number; output_tokens?: number }; total_cost_usd?: number };
  try { envelope = JSON.parse(stdout) as typeof envelope; }
  catch { cost.failures.push('architecture: could not parse the CLI envelope'); return { meaning: null, cost }; }

  cost.inputTokens = envelope.usage?.input_tokens ?? 0;
  cost.outputTokens = envelope.usage?.output_tokens ?? 0;
  cost.usd = envelope.total_cost_usd ?? 0;

  const raw = envelope.result ?? '';
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) {
    cost.failures.push('architecture: the reply was not the JSON that was asked for');
    return { meaning: null, cost };
  }

  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as {
      overview?: string;
      parts?: Array<{ path?: string; purpose?: string }>;
    };
    const purposes: Record<string, string> = {};
    for (const part of parsed.parts ?? []) {
      if (typeof part.path === 'string' && typeof part.purpose === 'string') purposes[part.path] = part.purpose.trim();
    }
    const meaning: ArchitectureMeaning = { overview: (parsed.overview ?? '').trim(), purposes };
    if (!meaning.overview) {
      cost.failures.push('architecture: the reply had no overview');
      return { meaning: null, cost };
    }
    cost.interpretedStops = 1 + Object.keys(purposes).length;
    try { fs.writeFileSync(cachePath, JSON.stringify(meaning, null, 2)); } catch { /* costs money next time, never correctness */ }
    return { meaning, cost };
  } catch {
    cost.failures.push('architecture: the JSON did not parse');
    return { meaning: null, cost };
  }
}
