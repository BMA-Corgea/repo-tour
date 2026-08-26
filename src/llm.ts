/**
 * The LLM layer — which model writes the explanations, and how to add another one.
 *
 * Ported from GONS's `backend/app/llm_adapter.py`, which had already solved the awkward
 * parts: providers are CLI shapes rather than API clients, binaries hide in a dozen install
 * locations, and a provider that is not installed must be a quiet fallback rather than a
 * crash.
 *
 * ── Adding a provider ────────────────────────────────────────────────────────────────────
 * One entry in `PROVIDERS`. It needs to say what it is, which models it offers, how to tell
 * whether it is usable on this machine, and how to run a prompt. Nothing else changes: it
 * appears in the picker, in the doctor, and in the settings, automatically.
 *
 * ── Why the reply carries usage and cost ─────────────────────────────────────────────────
 * repo-tour reports what a build cost, and that report has to be measured rather than
 * estimated — a criterion of the original spec. A provider that cannot report usage says so
 * with zeros and a `metered: false`, which is honest; inventing a number would not be.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LlmReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** false when the provider cannot tell us what it spent — the zeros above are unknowns */
  metered: boolean;
}

export interface Availability {
  ok: boolean;
  /** what to show a person: a version, a path, or the reason it cannot be used */
  detail: string;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  /** models this provider offers; the first is its default */
  readonly models: readonly string[];
  /** whether it can run here, right now */
  available(): Promise<Availability>;
  run(prompt: string, opts: { model: string; cwd: string; timeoutMs: number }): Promise<LlmReply>;
}

// ---------------------------------------------------------------- binaries

/**
 * Candidate absolute paths for a CLI, in priority order.
 *
 * Straight from GONS, and the length of these lists is the point: a globally installed node
 * CLI lands in whichever of a dozen places the user's toolchain prefers, and a server started
 * from a desktop launcher often has a PATH that contains none of them.
 */
function knownPaths(name: string): string[] {
  const home = os.homedir();
  const common = [
    path.join(home, '.local', 'bin', name),
    path.join(home, '.npm-global', 'bin', name),
    path.join(home, '.npm-packages', 'bin', name),
    path.join(home, '.yarn', 'bin', name),
    path.join(home, '.bun', 'bin', name),
    path.join(home, '.volta', 'bin', name),
    path.join(home, '.asdf', 'shims', name),
    path.join(home, '.nodenv', 'shims', name),
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ];
  if (name === 'claude') return [path.join(home, '.claude', 'local', 'claude'), ...common];
  return common;
}

/** env override → PATH → known locations. An explicit-but-broken override does NOT fall through. */
export function resolveBin(name: string, envVar: string): string | null {
  const explicit = (process.env[envVar] ?? '').trim();
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.X_OK);
      return explicit;
    } catch { return null; }
  }

  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }

  for (const candidate of knownPaths(name)) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

interface RunResult { code: number | null; stdout: string; stderr: string }

/**
 * Every LLM child this process has spawned and not yet reaped.
 *
 * An interpretation call can run for minutes. When the server is asked to stop — which now
 * happens on every source change, because it restarts itself — those children keep the
 * process alive past the shutdown signal, the supervisor gives up waiting and force-kills,
 * and nothing comes back listening. Holding the handles is what makes a clean stop possible.
 */
const liveChildren = new Set<import('node:child_process').ChildProcess>();

/** Stop every in-flight model call. A killed build resumes from its marker on the next boot. */
export function killLlmChildren(): void {
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  liveChildren.clear();
}

function runProcess(
  bin: string, args: string[], input: string, cwd: string, timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      liveChildren.delete(child);
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); liveChildren.delete(child); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ code, stdout, stderr });
    });

    // stdin, never argv: a prompt carrying a few hundred lines of source blows past the
    // shell's argument limit on a large file.
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function version(bin: string): Promise<string> {
  try {
    const r = await runProcess(bin, ['--version'], '', process.cwd(), 15_000);
    return r.stdout.trim().split('\n')[0] ?? '';
  } catch { return ''; }
}

// ---------------------------------------------------------------- providers

/**
 * Claude Code's CLI. The default, and the only one that reports what it spent.
 *
 * `--allowedTools ''` matters: it answers about the excerpt it was handed rather than
 * wandering off to read the repository, which is a much larger trust question than
 * "summarise these forty lines".
 */
const claude: Provider = {
  id: 'claude',
  label: 'Claude',
  note: 'The Claude Code CLI — uses your existing login, and reports real token usage and cost.',
  models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-fable-5'],

  async available() {
    const bin = resolveBin('claude', 'REPO_TOUR_CLAUDE_BIN');
    if (!bin) return { ok: false, detail: 'not found on PATH' };
    const v = await version(bin);
    return { ok: true, detail: v || bin };
  },

  async run(prompt, { model, cwd, timeoutMs }) {
    const bin = resolveBin('claude', 'REPO_TOUR_CLAUDE_BIN');
    if (!bin) throw new Error('the claude CLI is not installed');

    const r = await runProcess(
      bin, ['-p', '--model', model, '--output-format', 'json', '--allowedTools', ''],
      prompt, cwd, timeoutMs,
    );
    if (r.code !== 0) throw new Error(`claude exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);

    const envelope = JSON.parse(r.stdout) as {
      result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      total_cost_usd?: number;
    };
    return {
      text: envelope.result ?? '',
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
      usd: envelope.total_cost_usd ?? 0,
      metered: true,
    };
  },
};

/**
 * OpenAI's Codex CLI.
 *
 * It writes its final message to a file rather than stdout, so the call needs a temporary
 * path to hand it — and it reports no usage, which is recorded as unmetered rather than
 * guessed at.
 */
const codex: Provider = {
  id: 'codex',
  label: 'Codex',
  note: 'The OpenAI Codex CLI, sandboxed read-only. Does not report token usage or cost.',
  models: ['default'],

  async available() {
    const bin = resolveBin('codex', 'REPO_TOUR_CODEX_BIN');
    if (!bin) return { ok: false, detail: 'not found on PATH' };
    const v = await version(bin);
    return { ok: true, detail: v || bin };
  },

  async run(prompt, { cwd, timeoutMs }) {
    const bin = resolveBin('codex', 'REPO_TOUR_CODEX_BIN');
    if (!bin) throw new Error('the codex CLI is not installed');

    const out = path.join(os.tmpdir(), `repo-tour-codex-${process.pid}-${Date.now()}.txt`);
    try {
      const r = await runProcess(
        bin,
        ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
          '-C', cwd, '--output-last-message', out, '-'],
        prompt, cwd, timeoutMs,
      );
      const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
      if (r.code !== 0 && !text) {
        throw new Error(`codex exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
      }
      return { text, inputTokens: 0, outputTokens: 0, usd: 0, metered: false };
    } finally {
      try { fs.rmSync(out, { force: true }); } catch { /* a leftover temp file is not a failure */ }
    }
  },
};

/**
 * Ollama, over HTTP — a local model, so nothing leaves the machine and nothing is billed.
 *
 * Worth having for exactly that reason: a repository you would not send to a hosted model
 * can still get a tour.
 */
const OLLAMA_URL = () => (process.env['REPO_TOUR_OLLAMA_URL'] ?? 'http://localhost:11434').replace(/\/$/, '');

const ollama: Provider = {
  id: 'ollama',
  label: 'Ollama (local)',
  note: 'A model running on this machine. Nothing leaves it and nothing is billed; slower, and usually less careful.',
  models: ['qwen2.5-coder:7b', 'llama3.1:8b', 'deepseek-coder-v2:16b'],

  async available() {
    try {
      const res = await fetch(`${OLLAMA_URL()}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { ok: false, detail: `responded ${res.status}` };
      const body = await res.json() as { models?: Array<{ name?: string }> };
      const names = (body.models ?? []).map((m) => m.name).filter(Boolean);
      return { ok: true, detail: names.length ? `${names.length} model(s): ${names.slice(0, 3).join(', ')}` : 'running, no models pulled' };
    } catch {
      return { ok: false, detail: `nothing answering at ${OLLAMA_URL()}` };
    }
  },

  async run(prompt, { model, timeoutMs }) {
    const res = await fetch(`${OLLAMA_URL()}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`ollama responded ${res.status}`);
    const body = await res.json() as { response?: string; prompt_eval_count?: number; eval_count?: number };
    return {
      text: (body.response ?? '').trim(),
      inputTokens: body.prompt_eval_count ?? 0,
      outputTokens: body.eval_count ?? 0,
      usd: 0,               // a local model costs electricity, and zero is the honest figure
      metered: true,
    };
  },
};

/** The registry. Adding a provider is one entry here plus its object above. */
export const PROVIDERS: readonly Provider[] = [claude, codex, ollama] as const;

export const DEFAULT_PROVIDER = 'claude';

export function providerById(id: string): Provider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export interface LlmChoice {
  provider: string;
  model: string;
}

/** The default model for a provider, or the provider's first if the stored one is unknown. */
export function resolveChoice(choice: Partial<LlmChoice> | null): LlmChoice {
  const p = providerById(choice?.provider ?? DEFAULT_PROVIDER) ?? providerById(DEFAULT_PROVIDER)!;
  const model = choice?.model && p.models.includes(choice.model) ? choice.model : p.models[0]!;
  return { provider: p.id, model };
}

/**
 * Run a prompt against the chosen provider.
 *
 * Throws rather than returning empty — unlike GONS's `call_llm`, which returns "" on every
 * failure. repo-tour records per-file failures and shows them, so it needs the reason, and a
 * silent empty string would be indistinguishable from a model that had nothing to say.
 */
export async function runLlm(
  prompt: string, choice: LlmChoice, cwd: string, timeoutMs = 300_000,
): Promise<LlmReply> {
  const provider = providerById(choice.provider);
  if (!provider) throw new Error(`no such provider: ${choice.provider}`);
  return provider.run(prompt, { model: choice.model, cwd, timeoutMs });
}

/** Every provider with whether it can run here — for the doctor and the settings UI. */
export async function surveyProviders(): Promise<Array<{
  id: string; label: string; note: string; models: readonly string[]; availability: Availability;
}>> {
  return Promise.all(PROVIDERS.map(async (p) => ({
    id: p.id,
    label: p.label,
    note: p.note,
    models: p.models,
    availability: await p.available(),
  })));
}
