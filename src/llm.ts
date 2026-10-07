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

import { spawn, type ChildProcess } from 'node:child_process';
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

/** A piece of the answer as it is written. */
export type LlmDelta = (text: string) => void;

/** What every call is given. `signal` ends it early: whoever it was for has gone. */
export interface RunOpts {
  model: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  /** models this provider offers; the first is its default */
  readonly models: readonly string[];
  /**
   * The best model this provider offers, for a job where quality matters more than cost.
   *
   * T-18 Q5: the tutor is a different job from the narration. Narration is written once and
   * read many times; a tutor answer is written once, for one person, who is stuck.
   */
  readonly strongest: string;
  /** whether it can run here, right now */
  available(): Promise<Availability>;
  run(prompt: string, opts: RunOpts): Promise<LlmReply>;
  /**
   * The same call, delivering the answer as it arrives.
   *
   * Optional: a provider without one is driven through `run` by `runLlmStream`, which emits
   * the whole answer as a single delta. Callers therefore have ONE contract regardless of who
   * is answering — which is what lets `/api/ask` stream without caring who the provider is.
   */
  runStream?(
    prompt: string,
    opts: RunOpts,
    onDelta: LlmDelta,
  ): Promise<LlmReply>;
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

/**
 * Kill `child` when `signal` fires: a model call nobody is waiting for any more.
 *
 * Returns the cleanup a normal exit runs, so a finished call never leaves a listener behind.
 */
function cancelOn(
  signal: AbortSignal | undefined, child: ChildProcess, timer: NodeJS.Timeout,
  reject: (e: Error) => void,
): () => void {
  if (!signal) return () => {};
  const cancel = (): void => {
    clearTimeout(timer);
    liveChildren.delete(child);
    child.kill('SIGKILL');
    reject(new Error('cancelled: nobody is waiting for this answer'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  return () => signal.removeEventListener('abort', cancel);
}

function runProcess(
  bin: string, args: string[], input: string, cwd: string, timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('cancelled: nobody is waiting for this answer')); return; }
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      liveChildren.delete(child);
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const uncancel = cancelOn(signal, child, timer, reject);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); uncancel(); liveChildren.delete(child); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      uncancel();
      liveChildren.delete(child);
      resolve({ code, stdout, stderr });
    });

    // stdin, never argv: a prompt carrying a few hundred lines of source blows past the
    // shell's argument limit on a large file.
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Run a child and hand back its stdout LINE BY LINE as it arrives.
 *
 * Same lifecycle as `runProcess` — the same timeout, the same `liveChildren` registration so
 * a shutdown can still kill it — but the caller sees output while the model is still writing,
 * which is the whole point of T-18's Q4. Partial trailing lines are buffered; NDJSON that
 * arrives split across two reads is a normal occurrence, not an error.
 */
function streamProcess(
  bin: string, args: string[], input: string, cwd: string, timeoutMs: number,
  onLine: (line: string) => void, signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('cancelled: nobody is waiting for this answer')); return; }
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    let pending = '';
    const timer = setTimeout(() => {
      liveChildren.delete(child);
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const uncancel = cancelOn(signal, child, timer, reject);

    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.trim()) onLine(line);
        nl = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); uncancel(); liveChildren.delete(child); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      uncancel();
      liveChildren.delete(child);
      if (pending.trim() && !signal?.aborted) onLine(pending);
      resolve({ code, stdout, stderr });
    });

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
 * It must answer about the excerpt it was handed, not wander off to read the repository,
 * which is a much larger trust question than "summarise these forty lines". See `ISOLATED`.
 */

/**
 * The flags that make a claude call a plain model call: no tools, and nothing from the repo
 * it is answering about or from this machine's own Claude Code setup.
 *
 * This used to be `--allowedTools ''`, and that never meant "no tools": it only adds to an
 * allow list. Under the bypass permission mode this machine runs by default, the CLI it
 * started had 37 tools, Bash among them. It also ran the toured repo's hooks, obeyed its
 * CLAUDE.md, and wrote a session into that repo's history. A project file telling it to end
 * every reply with one word got that word back (measured 2026-10-07, claude 2.1.293). For a
 * tool whose whole job is reading other people's code, that hands the toured repo's author
 * the reader's machine.
 *
 *   --safe-mode               no CLAUDE.md, skills, plugins, hooks or MCP from anywhere
 *   --tools ''                no built-in tools: the model answers from what it is given
 *   --strict-mcp-config       no MCP servers, the account's connectors included
 *   --no-session-persistence  nothing written into the toured repo's session history
 *
 * Measured on the same prompt: 37 tools to 0, two hooks to none, the CLAUDE.md answer to the
 * plain one, and a sixth of the cost. Note that this also drops the machine's own settings,
 * effort level included, so the model runs at its default effort.
 */
const ISOLATED = ['--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
/**
 * Whether this machine's claude CLI understands `--include-partial-messages`.
 *
 * Decided once, by trying it, and remembered — not guessed from a version string. Without the
 * flag the CLI still streams, just a whole message at a time instead of token by token: the
 * fetches are still visible and the usage figures are still real, so the fallback is a
 * degraded experience rather than a broken one, and it must never be a crash.
 */
let partialMessagesSupported: boolean | null = null;

/** Forget what was learned about the CLI's flags. For tests, and for a settings change. */
export function resetProviderProbe(): void {
  partialMessagesSupported = null;
}

/** One NDJSON line of `--output-format stream-json`, as far as we care about it. */
interface StreamLine {
  type?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: Array<{ type?: string; text?: string }> };
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
}

const claude: Provider = {
  id: 'claude',
  label: 'Claude',
  note: 'The Claude Code CLI — uses your existing login, and reports real token usage and cost.',
  models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-fable-5'],
  strongest: 'claude-opus-5',

  async available() {
    const bin = resolveBin('claude', 'REPO_TOUR_CLAUDE_BIN');
    if (!bin) return { ok: false, detail: 'not found on PATH' };
    const v = await version(bin);
    return { ok: true, detail: v || bin };
  },

  async run(prompt, { model, cwd, timeoutMs, signal }) {
    const bin = resolveBin('claude', 'REPO_TOUR_CLAUDE_BIN');
    if (!bin) throw new Error('the claude CLI is not installed');

    const r = await runProcess(
      bin, ['-p', '--model', model, '--output-format', 'json', ...ISOLATED],
      prompt, cwd, timeoutMs, signal,
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

  /**
   * The same call, streamed.
   *
   * The event shape below was confirmed against claude 2.1.261 by running it, not recalled:
   * text arrives as `stream_event` → `content_block_delta` → `delta.type === 'text_delta'`,
   * and THINKING arrives through the identical path as `thinking_delta`, which is why the
   * type is checked rather than the presence of `.text`. Streaming a model's thinking into
   * the reader's answer bubble would be a very confusing bug.
   *
   * The final `result` line carries `total_cost_usd` and `usage`, so AC6's promise — that the
   * figures stay real once this stops being one blob — costs nothing.
   */
  async runStream(prompt, { model, cwd, timeoutMs, signal }, onDelta) {
    const bin = resolveBin('claude', 'REPO_TOUR_CLAUDE_BIN');
    if (!bin) throw new Error('the claude CLI is not installed');

    const attempt = async (partial: boolean): Promise<{ r: RunResult; reply: LlmReply; streamed: string }> => {
      const args = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose'];
      if (partial) args.push('--include-partial-messages');
      args.push(...ISOLATED);

      let streamed = '';
      let final = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let usd = 0;

      const r = await streamProcess(bin, args, prompt, cwd, timeoutMs, (line) => {
        let d: StreamLine;
        try { d = JSON.parse(line) as StreamLine; }
        catch { return; }  // hook chatter and blank frames are not our business

        if (d.type === 'stream_event' && d.event?.type === 'content_block_delta') {
          const delta = d.event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            streamed += delta.text;
            onDelta(delta.text);
          }
          return;
        }
        // Without --include-partial-messages this is the only place text appears, so it is
        // the fallback path's delta. With the flag it duplicates what was already streamed,
        // so it is used for the final text only.
        if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
          for (const block of d.message!.content!) {
            if (block?.type === 'text' && block.text) final += block.text;
          }
          return;
        }
        if (d.type === 'result') {
          if (typeof d.result === 'string' && d.result) final = d.result;
          inputTokens = d.usage?.input_tokens ?? 0;
          outputTokens = d.usage?.output_tokens ?? 0;
          usd = d.total_cost_usd ?? 0;
        }
      }, signal);

      const text = (final || streamed).trim();
      return { r, reply: { text, inputTokens, outputTokens, usd, metered: true }, streamed };
    };

    if (partialMessagesSupported !== false) {
      const out = await attempt(true);
      if (out.r.code === 0) { partialMessagesSupported = true; return out.reply; }
      // Only a flag the CLI does not know is worth retrying — anything else is a real error
      // and pretending otherwise would double every failure's wait.
      //
      // Deliberately NOT matching the flag's own name: a CLI that echoes its argv in an error
      // banner would turn any transient failure into a permanent, process-lifetime downgrade
      // to whole-message streaming, with no way back short of a restart.
      if (!/unknown option|unrecognized option|unknown argument|unexpected argument/i.test(out.r.stderr)) {
        throw new Error(`claude exited ${out.r.code}: ${out.r.stderr.trim().slice(0, 200)}`);
      }
      partialMessagesSupported = false;
    }

    const out = await attempt(false);
    if (out.r.code !== 0) throw new Error(`claude exited ${out.r.code}: ${out.r.stderr.trim().slice(0, 200)}`);
    // The non-partial path never called onDelta, so the caller has seen nothing yet.
    if (!out.streamed && out.reply.text) onDelta(out.reply.text);
    return out.reply;
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
  strongest: 'default',

  async available() {
    const bin = resolveBin('codex', 'REPO_TOUR_CODEX_BIN');
    if (!bin) return { ok: false, detail: 'not found on PATH' };
    const v = await version(bin);
    return { ok: true, detail: v || bin };
  },

  async run(prompt, { cwd, timeoutMs, signal }) {
    const bin = resolveBin('codex', 'REPO_TOUR_CODEX_BIN');
    if (!bin) throw new Error('the codex CLI is not installed');

    const out = path.join(os.tmpdir(), `repo-tour-codex-${process.pid}-${Date.now()}.txt`);
    try {
      const r = await runProcess(
        bin,
        ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
          '-C', cwd, '--output-last-message', out, '-'],
        prompt, cwd, timeoutMs, signal,
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
  // The largest of the three, which is the only sense in which a local model is 'strongest'.
  strongest: 'deepseek-coder-v2:16b',

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

  async run(prompt, { model, timeoutMs, signal }) {
    const res = await fetch(`${OLLAMA_URL()}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
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

/**
 * The same call, delivering the answer as it is written.
 *
 * One contract for every provider: a provider that cannot stream is run normally and its
 * whole answer is emitted as a single delta, so a caller never has to ask who is answering.
 * The reply comes back exactly as `runLlm`'s does, usage and cost included — the point of
 * Q4=A was to make the WAIT legible, not to trade away the figures.
 */
export async function runLlmStream(
  prompt: string, choice: LlmChoice, cwd: string, onDelta: LlmDelta, timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<LlmReply> {
  const provider = providerById(choice.provider);
  if (!provider) throw new Error(`no such provider: ${choice.provider}`);
  if (provider.runStream) {
    return provider.runStream(prompt, { model: choice.model, cwd, timeoutMs, signal }, onDelta);
  }
  const reply = await provider.run(prompt, { model: choice.model, cwd, timeoutMs, signal });
  if (reply.text) onDelta(reply.text);
  return reply;
}

/** The best model a provider offers — the tutor's default (T-18 Q5). */
export function strongestModel(providerId: string): string {
  const p = providerById(providerId) ?? providerById(DEFAULT_PROVIDER)!;
  return p.strongest;
}

/**
 * The tutor's choice, which is a SEPARATE setting from the build's.
 *
 * Unset means the provider's strongest model rather than its default one: the build model is
 * picked for what a whole tour costs, and inheriting that for the one thing the reader talks
 * to was exactly the complaint Q5 answered.
 */
export function resolveTutorChoice(
  stored: Partial<LlmChoice> | null, build: LlmChoice,
): LlmChoice {
  const providerId = stored?.provider ?? build.provider;
  const p = providerById(providerId) ?? providerById(DEFAULT_PROVIDER)!;
  const model = stored?.model && p.models.includes(stored.model) ? stored.model : p.strongest;
  return { provider: p.id, model };
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
