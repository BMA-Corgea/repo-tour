/**
 * T-18 — the /api/ask event stream and the retrieval loop (AC2, AC3, AC6, AC7, AC9).
 *
 * Driven against a FAKE provider, registered by pointing the claude binary at a script we
 * control, so the loop can be exercised without spending a model call and without depending on
 * what a real model would decide to say. What is being tested is the machine around the model:
 * that a fetch is served and SHOWN, that the limits hold, that a `FETCH:` line never reaches
 * the reader as if it were an answer, and that the figures survive streaming.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import type http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

let base: string;
let repo: string;
let state: string;
let scriptPath: string;

/** Events the fake claude will emit, one scripted reply per call. */
function scriptReplies(replies: string[]): void {
  fs.writeFileSync(path.join(base, 'replies.json'), JSON.stringify(replies));
  fs.writeFileSync(path.join(base, 'calls.json'), '0');
}

function callCount(): number {
  return Number(fs.readFileSync(path.join(base, 'calls.json'), 'utf8'));
}

/** What the fake claude saw as it started: its argv, where it stood, what was there, the mode. */
interface Seen { argv: string[]; cwd: string; listing: string[]; mode: number }

/** Every spawn of the fake claude since the last `beforeEach`, in order (T-20). */
function attempts(): Seen[] {
  const file = path.join(base, 'attempts.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Seen);
}

/** `where.json` once it is whole, else null: a reader can catch it between creation and write. */
function whereNow(): Omit<Seen, 'argv'> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(base, 'where.json'), 'utf8')) as Omit<Seen, 'argv'>;
  } catch { return null; }
}

/** True when `p` is the toured repo or anywhere inside it, however the path is spelled. */
function insideRepo(p: string): boolean {
  return [path.resolve(repo), fs.realpathSync(repo)].some((r) => p === r || p.startsWith(r + path.sep));
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-ask-'));
  repo = path.join(base, 'repo');
  state = path.join(base, 'state.json');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'rank.ts'), 'export function rank() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 2;\n');

  // A stand-in for the claude CLI: emits the stream-json shape T-18 was written against,
  // one scripted reply per invocation, streaming it in three chunks so the delta path is
  // genuinely exercised rather than assumed.
  scriptPath = path.join(base, 'fake-claude');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('fs');
const dir = ${JSON.stringify(base)};
if (process.argv.includes('--version')) { process.stdout.write('fake 1.0\\n'); process.exit(0); }
// T-20: every invocation leaves one line saying how it was called, where it stood, what was in
// that directory and who else could get into it, before anything below can exit.
const here = process.cwd();
const seen = { cwd: here, listing: fs.readdirSync(here), mode: fs.statSync(here).mode & 0o777 };
fs.appendFileSync(dir + '/attempts.jsonl', JSON.stringify({ argv: process.argv.slice(2), ...seen }) + '\\n');
// A CLI too old for one of the flags repo-tour sends, when the fixture names one (T-20). It
// refuses ahead of everything else, the call counter included, as the real CLI does.
if (fs.existsSync(dir + '/reject-flag')) {
  const reject = JSON.parse(fs.readFileSync(dir + '/reject-flag', 'utf8'));
  if (process.argv.includes(reject.flag)) { process.stderr.write(reject.stderr); process.exit(1); }
}
// A CLI too old for --include-partial-messages, when the fixture asks for one.
if (fs.existsSync(dir + '/no-partial') && process.argv.includes('--include-partial-messages')) {
  process.stderr.write('error: unknown option \\'--include-partial-messages\\'\\n');
  process.exit(2);
}
// A CLI that fails for an unrelated reason but echoes its argv, which must NOT be read as
// "this flag is unsupported".
if (fs.existsSync(dir + '/echo-argv-fail')) {
  process.stderr.write('fatal: could not reach the API\\nargv: ' + process.argv.join(' ') + '\\n');
  process.exit(3);
}
const replies = JSON.parse(fs.readFileSync(dir + '/replies.json', 'utf8'));
const n = Number(fs.readFileSync(dir + '/calls.json', 'utf8'));
fs.writeFileSync(dir + '/calls.json', String(n + 1));
// What the 2026-10-07 tests read: how it was called, and which process to watch die.
fs.writeFileSync(dir + '/argv.json', JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(dir + '/cwd.json', JSON.stringify(process.cwd()));
// T-20: the same, with what was in it and its mode, taken while the call runs. Its directory is
// gone once the call settles, so afterwards is too late to look.
fs.writeFileSync(dir + '/where.json', JSON.stringify(seen));
fs.writeFileSync(dir + '/pid', String(process.pid));
// A model that thinks before it speaks, for as many ms as the fixture says.
const slow = fs.existsSync(dir + '/slow') ? Number(fs.readFileSync(dir + '/slow', 'utf8')) : 0;
const text = replies[Math.min(n, replies.length - 1)];
// read stdin so the parent's write never blocks
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => setTimeout(reply, slow));
function reply() {
  // T-20 review: a CLI that leaves something in the directory it stood in, when the fixture says.
  if (fs.existsSync(dir + '/litter')) fs.writeFileSync(process.cwd() + '/litter.txt', 'left behind');
  if (text === '__EXIT1__') { process.stderr.write('boom\\n'); process.exit(1); }
  // The one-shot shape \`run\` asks for: a single JSON envelope.
  if (process.argv[process.argv.indexOf('--output-format') + 1] === 'json') {
    process.stdout.write(JSON.stringify({ result: text, usage: { input_tokens: 11, output_tokens: 22 }, total_cost_usd: 0.5 }));
    process.exit(0);
  }
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'system', subtype: 'init' });
  // The fixture MODELS the flag, and that is what makes the fallback test able to fail:
  // with --include-partial-messages it emits token deltas, without it a single whole
  // message, exactly like the real CLI. An always-streaming fake made the latch
  // undetectable and the test that guarded it vacuous (review attempt 2).
  const partial = process.argv.includes('--include-partial-messages');
  if (partial) {
    // thinking must never reach the reader — emitted here on purpose
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } });
    const third = Math.ceil(text.length / 3) || 1;
    for (let i = 0; i < text.length; i += third) {
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + third) } } });
    }
  } else {
    emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: text }] } });
  }
  emit({ type: 'result', result: text, usage: { input_tokens: 11, output_tokens: 22 }, total_cost_usd: 0.5 });
  process.exit(0);
}
`);
  fs.chmodSync(scriptPath, 0o755);
  process.env['REPO_TOUR_CLAUDE_BIN'] = scriptPath;
});

afterAll(() => {
  delete process.env['REPO_TOUR_CLAUDE_BIN'];
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(state, { force: true });
  fs.rmSync(path.join(path.dirname(state), 'llm.json'), { force: true });
  fs.rmSync(path.join(base, 'slow'), { force: true });
  for (const f of ['reject-flag', 'attempts.jsonl', 'where.json', 'cwd.json', 'litter']) {
    fs.rmSync(path.join(base, f), { force: true });
  }
});

interface Frame { kind: string; data: Record<string, unknown> }

/** POST to /api/ask and collect the event stream it writes. */
async function ask(
  server: { handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> },
  body: unknown,
  headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
): Promise<Frame[]> {
  let written = '';
  let status = 0;
  const res = {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    writeHead(code: number) { status = code; return this; },
    flushHeaders() {},
    on() { return this; },
    write(chunk: string) { written += chunk; return true; },
    end() { (this as { writableEnded: boolean }).writableEnded = true; return this; },
  } as unknown as http.ServerResponse;

  const payload = JSON.stringify(body);
  const req = {
    url: '/api/ask',
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  } as unknown as http.IncomingMessage;

  await server.handler(req, res);
  expect(status).toBe(200);

  return written
    .split('\n\n')
    // A heartbeat is a comment block, and carries no event.
    .filter((b) => b.trim() && !b.startsWith(':'))
    .map((block) => {
      const kind = /^event: (.+)$/m.exec(block)![1]!;
      const data = /^data: (.+)$/m.exec(block)![1]!;
      return { kind, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function newServer(): Promise<{ handler: http.RequestListener; addRepo: (p: string) => unknown; getTutorChoice: () => { provider: string; model: string }; setTutorChoice: (c: Record<string, string>) => unknown; setChoice: (c: Record<string, string>) => unknown; getChoice: () => { provider: string; model: string } }> {
  const { RepoTourServer } = await import('../src/server.js');
  const s = new RepoTourServer({ statePath: state, interpret: false });
  s.addRepo(repo);
  return s as never;
}

const text = (frames: Frame[]): string =>
  frames.filter((f) => f.kind === 'delta').map((f) => String(f.data['text'])).join('');

describe('the answer streams (AC6)', () => {
  it('arrives in pieces and ends with the figures', async () => {
    scriptReplies(['rank.ts scores files by churn and in-degree.']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'what does it do?' }],
      context: { repoPath: repo, file: 'src/rank.ts' },
    });

    expect(frames.filter((f) => f.kind === 'delta').length).toBeGreaterThan(1);
    expect(text(frames)).toBe('rank.ts scores files by churn and in-degree.');
    const done = frames.find((f) => f.kind === 'done')!;
    expect(done.data['inputTokens']).toBe(11);
    expect(done.data['outputTokens']).toBe(22);
    expect(done.data['usd']).toBe(0.5);
  });

  it('never streams the model thinking into the answer', async () => {
    scriptReplies(['the answer']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    });
    expect(text(frames)).toBe('the answer');
    expect(text(frames)).not.toContain('hmm');
  });

  it('reports a provider failure as an error event rather than hanging', async () => {
    scriptReplies(['__EXIT1__']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    });
    expect(frames.some((f) => f.kind === 'error')).toBe(true);
    expect(frames.some((f) => f.kind === 'done')).toBe(false);
  });

  it('refuses an empty question before spending anything', async () => {
    scriptReplies(['unused']);
    const server = await newServer();
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; return this; },
      end() { return this; },
      setHeader() { return this; },
    } as unknown as http.ServerResponse;
    const req = {
      url: '/api/ask', method: 'POST', headers: { 'sec-fetch-site': 'same-origin' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ messages: [] })); },
    } as unknown as http.IncomingMessage;
    await (server as { handler: (a: http.IncomingMessage, b: http.ServerResponse) => Promise<void> }).handler(req, res);
    expect(status).toBe(400);
    expect(callCount()).toBe(0);
  });
});

describe('the retrieval loop (AC2, AC3)', () => {
  it('serves a fetch, shows it, and answers on the next pass', async () => {
    scriptReplies(['FETCH: file src/other.ts', 'other.ts exports a constant, src/other.ts:1.']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'what is in other.ts?' }],
      context: { repoPath: repo, file: 'src/rank.ts' },
    });

    const fetches = frames.filter((f) => f.kind === 'fetch');
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.data['what']).toBe('file src/other.ts');
    expect(fetches[0]!.data['ok']).toBe(true);
    // the reader sees the lookup BEFORE the answer it produced
    expect(frames.indexOf(fetches[0]!)).toBeLessThan(frames.findIndex((f) => f.kind === 'delta'));
    expect(text(frames)).toContain('exports a constant');
    expect(callCount()).toBe(2);
  });

  it('never shows the reader the FETCH line itself', async () => {
    scriptReplies(['FETCH: file src/other.ts', 'here is the answer']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    });
    expect(text(frames)).toBe('here is the answer');
    expect(text(frames)).not.toContain('FETCH');
  });

  it('shows a refusal as a failed lookup, and keeps going', async () => {
    scriptReplies(['FETCH: file ../../etc/passwd', 'I could not see that file.']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    });
    const fetch = frames.find((f) => f.kind === 'fetch')!;
    expect(fetch.data['ok']).toBe(false);
    expect(String(fetch.data['detail'])).toContain('outside the repository');
    expect(text(frames)).toBe('I could not see that file.');
  });

  it('stops at the hop cap and tells the model so, instead of looping', async () => {
    // Always asks for another file. Without the cap this would never return.
    scriptReplies(['FETCH: file src/other.ts']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    });
    const { MAX_FETCH_HOPS } = await import('../src/ask.js');
    const fetches = frames.filter((f) => f.kind === 'fetch');
    expect(fetches.length).toBeGreaterThanOrEqual(MAX_FETCH_HOPS);
    expect(fetches.some((f) => String(f.data['detail'] ?? '').includes('lookup limit'))).toBe(true);
    // it ends: an error or a done, never an unterminated stream
    expect(frames.some((f) => f.kind === 'done' || f.kind === 'error')).toBe(true);
  }, 30_000);

  it('refuses to fetch when the page is not attached to a loaded repository', async () => {
    scriptReplies(['FETCH: file src/other.ts', 'nothing to read from here']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: '/somewhere/never/loaded' },
    });
    const fetch = frames.find((f) => f.kind === 'fetch')!;
    expect(fetch.data['ok']).toBe(false);
    expect(String(fetch.data['detail'])).toContain('no repository');
  });
});

describe('citations ride along with the answer (AC9)', () => {
  it('marks what it read, what it did not, and what does not exist', async () => {
    scriptReplies(['src/rank.ts:2 returns 1, src/other.ts differs, src/ghost.ts is gone.']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo, file: 'src/rank.ts' },
    });
    const cites = frames.find((f) => f.kind === 'done')!.data['citations'] as Array<{ path: string; verdict: string }>;
    expect(cites.map((c) => [c.path, c.verdict])).toEqual([
      ['src/rank.ts', 'supplied'],
      ['src/other.ts', 'unshown'],
      ['src/ghost.ts', 'unknown'],
    ]);
  });

  it('counts a file it fetched as one it was shown', async () => {
    scriptReplies(['FETCH: file src/other.ts', 'src/other.ts exports a constant.']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo, file: 'src/rank.ts' },
    });
    const cites = frames.find((f) => f.kind === 'done')!.data['citations'] as Array<{ path: string; verdict: string }>;
    expect(cites).toEqual([expect.objectContaining({ path: 'src/other.ts', verdict: 'supplied' })]);
  });
});

describe('the tutor has its own model (AC7)', () => {
  it('defaults to the provider strongest, not to the build model', async () => {
    const server = await newServer();
    expect(server.getChoice().model).toBe('claude-sonnet-5');
    expect(server.getTutorChoice().model).toBe('claude-opus-5');
  });

  it('moves independently of the build model, in both directions', async () => {
    const server = await newServer();
    server.setTutorChoice({ provider: 'claude', model: 'claude-haiku-4-5-20251001' });
    server.setChoice({ provider: 'claude', model: 'claude-fable-5' });
    expect(server.getTutorChoice().model).toBe('claude-haiku-4-5-20251001');
    expect(server.getChoice().model).toBe('claude-fable-5');

    server.setTutorChoice({ provider: 'claude', model: 'claude-opus-5' });
    expect(server.getChoice().model).toBe('claude-fable-5');
  });

  it('survives a restart', async () => {
    const first = await newServer();
    first.setTutorChoice({ provider: 'claude', model: 'claude-haiku-4-5-20251001' });
    const { RepoTourServer } = await import('../src/server.js');
    const second = new RepoTourServer({ statePath: state, interpret: false });
    expect(second.getTutorChoice().model).toBe('claude-haiku-4-5-20251001');
  });
});

describe('exactly one terminal event, always (the auto-review regression)', () => {
  it('gives up loudly when the page has no repository and the model never answers', async () => {
    // The bug: the `!root` refusal `continue`d BEFORE the give-up check, so the loop ran to
    // exhaustion and fell out past every send — no done, no error. The panel clears its
    // in-flight bubble on those two events and nothing else, so the reader watched eight
    // lookups scroll past and was then left with their own question and a deleted answer,
    // after eight tutor-model calls had been paid for.
    scriptReplies(['FETCH: file src/other.ts']);            // never answers
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: '/somewhere/never/loaded' },
    });
    const terminal = frames.filter((f) => f.kind === 'done' || f.kind === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.kind).toBe('error');
    expect(String(terminal[0]!.data['message'])).toContain('kept asking for files');
  }, 30_000);

  it('gives up loudly with no context at all', async () => {
    scriptReplies(['FETCH: search anything']);
    const server = await newServer();
    const frames = await ask(server, { messages: [{ role: 'user', content: 'q' }], context: {} });
    expect(frames.filter((f) => f.kind === 'done' || f.kind === 'error')).toHaveLength(1);
  }, 30_000);

  it('reports what was already spent when it gives up (AC6)', async () => {
    // The most expensive failure is the one that reports zero cost.
    scriptReplies(['FETCH: file src/other.ts']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    });
    const terminal = frames.find((f) => f.kind === 'error')!;
    expect(Number(terminal.data['usd'])).toBeGreaterThan(0);
    expect(Number(terminal.data['inputTokens'])).toBeGreaterThan(0);
    expect(terminal.data['model']).toBe('claude-opus-5');
  }, 30_000);

  it('sends one terminal event, not two, when the provider fails mid-answer', async () => {
    scriptReplies(['__EXIT1__']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    });
    expect(frames.filter((f) => f.kind === 'done' || f.kind === 'error')).toHaveLength(1);
  });
});

describe('the --include-partial-messages fallback (the plan\'s number-one risk)', () => {
  it('falls back to whole-message streaming on a CLI that does not know the flag', async () => {
    const { resetProviderProbe } = await import('../src/llm.js');
    resetProviderProbe();
    fs.writeFileSync(path.join(base, 'no-partial'), '');
    try {
      scriptReplies(['the older CLI still answers']);
      const server = await newServer();
      const frames = await ask(server, {
        messages: [{ role: 'user', content: 'q' }],
        context: { repoPath: repo },
      });
      expect(text(frames)).toBe('the older CLI still answers');
      // one whole-message delta, not three: the downgrade is visible, which is the only
      // reason this test can fail if the fallback breaks
      expect(frames.filter((f) => f.kind === 'delta')).toHaveLength(1);
      const done = frames.find((f) => f.kind === 'done')!;
      expect(done.data['outputTokens']).toBe(22);
    } finally {
      fs.rmSync(path.join(base, 'no-partial'), { force: true });
      resetProviderProbe();
    }
  }, 30_000);

  it('does NOT latch the downgrade on an unrelated failure that echoes the flag name', async () => {
    // A CLI that prints its argv in an error banner would otherwise pin every later question
    // to whole-message streaming for the life of the process, with no way back but a restart.
    const { resetProviderProbe } = await import('../src/llm.js');
    resetProviderProbe();
    fs.writeFileSync(path.join(base, 'echo-argv-fail'), '');
    try {
      scriptReplies(['unused']);
      const server = await newServer();
      const frames = await ask(server, {
        messages: [{ role: 'user', content: 'q' }],
        context: { repoPath: repo },
      });
      expect(frames.some((f) => f.kind === 'error')).toBe(true);
    } finally {
      fs.rmSync(path.join(base, 'echo-argv-fail'), { force: true });
    }

    // and the next question still streams token by token
    scriptReplies(['back to normal streaming']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    });
    expect(frames.filter((f) => f.kind === 'delta').length).toBeGreaterThan(1);
    resetProviderProbe();
  }, 30_000);
});

describe('a provider that cannot stream (AC6, second half)', () => {
  it('produces one delta and the same done shape', async () => {
    // codex has no runStream, so runLlmStream drives it through run() and emits the whole
    // answer as a single delta — one contract for the panel regardless of who answered.
    const script = path.join(base, 'fake-codex');
    fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv;
const i = args.indexOf('--output-last-message');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (i !== -1) fs.writeFileSync(args[i + 1], 'the whole answer arrives at once');
  process.exit(0);
});
`);
    fs.chmodSync(script, 0o755);
    process.env['REPO_TOUR_CODEX_BIN'] = script;
    try {
      const server = await newServer();
      server.setTutorChoice({ provider: 'codex', model: 'default' });
      const frames = await ask(server, {
        messages: [{ role: 'user', content: 'q' }],
        context: { repoPath: repo },
      });
      expect(frames.filter((f) => f.kind === 'delta')).toHaveLength(1);
      expect(text(frames)).toBe('the whole answer arrives at once');
      const done = frames.find((f) => f.kind === 'done')!;
      expect(done.data['provider']).toBe('codex');
      expect(done.data['metered']).toBe(false);
      expect(done.data['usd']).toBe(0);
      expect(done.data).toHaveProperty('citations');
    } finally {
      delete process.env['REPO_TOUR_CODEX_BIN'];
    }
  }, 30_000);
});

describe('the route is only reachable from its own page', () => {
  // /api/ask became materially more powerful in T-18: it reads files out of a loaded
  // repository and spends tutor-model tokens. A page on another origin cannot read the
  // answer (no CORS headers), but it could still make the server do the work and pay for it.
  it('refuses an explicitly cross-site caller', async () => {
    scriptReplies(['unused']);
    const server = await newServer();
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; return this; },
      end() { return this; },
      setHeader() { return this; },
    } as unknown as http.ServerResponse;
    const req = {
      url: '/api/ask', method: 'POST', headers: { 'sec-fetch-site': 'cross-site' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'q' }] })); },
    } as unknown as http.IncomingMessage;
    await (server as { handler: (a: http.IncomingMessage, b: http.ServerResponse) => Promise<void> }).handler(req, res);
    expect(status).toBe(403);
    expect(callCount()).toBe(0);
  });

  it('allows a caller that sends no such header at all', async () => {
    // curl, a test harness, an older browser: absence is not evidence of cross-origin, and
    // refusing it would break every non-browser client of a local tool.
    scriptReplies(['answered anyway']);
    const server = await newServer();
    const frames = await ask(server, {
      messages: [{ role: 'user', content: 'q' }],
      context: { repoPath: repo },
    }, {});
    expect(text(frames)).toBe('answered anyway');
  });
});

// ---------------------------------------------------------------- 2026-10-07, the owner's test drive
//
// He asked a question and got one lookup, then "Error in input stream". The model thought for
// 34 s between the lookup and its next words, so nothing crossed the wire; a Docker container
// restarting changed the machine's network, and Firefox closed every connection with no
// traffic over the next five seconds. The server never noticed: it finished the answer, and
// paid for it, after the reader had already been shown an error. These run over a REAL
// socket, because the fake response above can neither go quiet on a wire nor hang up.

/** Start a listening server; each test chooses how often it beats. */
async function liveServer(heartbeatMs: number): Promise<{ port: number; close: () => Promise<void> }> {
  const { RepoTourServer } = await import('../src/server.js');
  const s = new RepoTourServer({ statePath: state, interpret: false, port: 0, heartbeatMs });
  s.addRepo(repo);
  return s.listen();
}

const askBody = (): string =>
  JSON.stringify({ messages: [{ role: 'user', content: 'q' }], context: { repoPath: repo } });

/** POST a question over a real socket, noting when each piece of the body arrived. */
function postAsk(port: number): Promise<{ status: number; chunks: Array<{ ms: number; text: string }> }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = request({
      host: '127.0.0.1', port, path: '/api/ask', method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    }, (res) => {
      const chunks: Array<{ ms: number; text: string }> = [];
      res.setEncoding('utf8');
      res.on('data', (d: string) => { chunks.push({ ms: Date.now() - t0, text: d }); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, chunks }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(askBody());
  });
}

const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return ok();
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe('a silent model does not leave a silent stream (2026-10-07)', () => {
  it('sends a byte at once, because Firefox waits for one before fetch() resolves', async () => {
    scriptReplies(['the answer']);
    fs.writeFileSync(path.join(base, 'slow'), '800');
    // Beats far apart, so only the opening byte can arrive before the model speaks. Headers
    // alone would not do: Firefox resolves fetch() at the first BODY byte (review attempt 3).
    const { port, close } = await liveServer(60_000);
    try {
      const got = await postAsk(port);
      expect(got.status).toBe(200);
      expect(got.chunks[0]!.ms).toBeLessThan(500);
      expect(got.chunks[0]!.text.startsWith(': open')).toBe(true);
    } finally {
      await close();
    }
  }, 30_000);

  it('beats while the model thinks, and the beats never reach the answer', async () => {
    scriptReplies(['the answer']);
    fs.writeFileSync(path.join(base, 'slow'), '800');
    const { port, close } = await liveServer(25);
    try {
      const body = (await postAsk(port)).chunks.map((c) => c.text).join('');
      // The wire is never quiet while it waits: beats come before the first event.
      const beforeFirstEvent = body.slice(0, body.indexOf('event: '));
      expect(beforeFirstEvent.match(/^: working$/gm)?.length ?? 0).toBeGreaterThanOrEqual(5);
      // And the answer still arrives whole and finishes.
      const frames = body.split('\n\n').filter((b) => b.startsWith('event: '));
      expect(frames.filter((b) => b.startsWith('event: delta')).map((b) => JSON.parse(/^data: (.+)$/m.exec(b)![1]!).text).join(''))
        .toBe('the answer');
      expect(frames.at(-1)).toMatch(/^event: done/);
    } finally {
      await close();
    }
  }, 30_000);

  it('stops the model, and spends nothing more, when the reader hangs up', async () => {
    // Left alone, this thinks for 3 s, looks a file up and goes round again: two paid calls.
    scriptReplies(['FETCH: file src/other.ts', 'an answer nobody will read']);
    fs.writeFileSync(path.join(base, 'slow'), '3000');
    fs.rmSync(path.join(base, 'pid'), { force: true });
    const { port, close } = await liveServer(25);
    try {
      const t0 = Date.now();
      const req = request({
        host: '127.0.0.1', port, path: '/api/ask', method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      });
      req.on('error', () => { /* we are the ones hanging up */ });
      req.end(askBody());

      expect(await until(() => fs.existsSync(path.join(base, 'pid')), 5000)).toBe(true);
      const pid = Number(fs.readFileSync(path.join(base, 'pid'), 'utf8'));
      expect(alive(pid)).toBe(true);

      req.destroy();

      // Killed now, well inside the 3 s it would have taken to finish on its own.
      expect(await until(() => !alive(pid), 1000)).toBe(true);
      // And past the moment it would have finished, nothing has gone round again.
      await new Promise((r) => setTimeout(r, Math.max(0, 4000 - (Date.now() - t0))));
      expect(callCount()).toBe(1);
    } finally {
      await close();
    }
  }, 30_000);

  it('says nothing more to a reader who has left', async () => {
    // Node drops writes to a destroyed socket without complaint, so on a real wire this guard
    // is invisible. Here it is not: once the reader is gone, no error and no backstop event
    // is even attempted. (Do not "simplify" the guards in askStream away.)
    scriptReplies(['FETCH: file src/other.ts', 'unused']);
    fs.writeFileSync(path.join(base, 'slow'), '3000');
    fs.rmSync(path.join(base, 'pid'), { force: true });
    const server = await newServer();
    let written = '';
    const closers: Array<() => void> = [];
    const res = {
      writableEnded: false,
      writableFinished: false,
      destroyed: false,
      writeHead() { return this; },
      on(event: string, fn: () => void) { if (event === 'close') closers.push(fn); return this; },
      write(chunk: string) { written += chunk; return true; },
      end() { this.writableEnded = true; return this; },
    };
    const req = {
      url: '/api/ask', method: 'POST', headers: { 'sec-fetch-site': 'same-origin' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(askBody()); },
    } as unknown as http.IncomingMessage;

    const handled = (server as unknown as { handler: (a: http.IncomingMessage, b: http.ServerResponse) => Promise<void> })
      .handler(req, res as unknown as http.ServerResponse);
    expect(await until(() => fs.existsSync(path.join(base, 'pid')), 5000)).toBe(true);
    const before = written.length;
    res.destroyed = true;
    for (const fn of closers) fn();
    await handled;

    const after = written.slice(before);
    expect(after).not.toContain('event: error');
    expect(after).not.toContain('event: done');
    expect(callCount()).toBe(1);
  }, 30_000);
});

describe('a model call is a plain model call (2026-10-07)', () => {
  // `--allowedTools ''` only ever added to an allow list. Under bypass permissions the CLI it
  // started had 37 tools, ran the toured repo's hooks and obeyed its CLAUDE.md. And standing in
  // the repo let its `.claude/settings.json` run an apiKeyHelper or redirect the API, flags or
  // not (review attempt 3) — so the call also runs somewhere empty.
  const isolated = (argv: string[]): void => {
    expect(argv).toContain('--safe-mode');
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
    expect(argv).toContain('--tools');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--no-session-persistence');
    expect(argv).not.toContain('--allowedTools');
  };
  const argv = (): string[] => JSON.parse(fs.readFileSync(path.join(base, 'argv.json'), 'utf8')) as string[];
  const standsSomewhereEmpty = (): void => {
    const seen = whereNow();
    expect(seen, 'the fake claude never recorded where it stood').not.toBeNull();
    const { cwd: where, listing, mode } = seen!;
    expect(insideRepo(where), `ran inside the toured repo: ${where}`).toBe(false);
    // What was in it while the call ran, the moment it matters. The directory is gone once the
    // call settles (T-20), so looking afterwards would prove nothing.
    expect(listing, `stood somewhere that was not empty: ${where}`).toEqual([]);
    expect(mode, `stood somewhere other users can open (mode ${mode.toString(8)}): ${where}`).toBe(0o700);
    expect(fs.existsSync(where), `its directory outlived the call: ${where}`).toBe(false);
  };

  it('in one shot, the way a tour is written', async () => {
    scriptReplies(['written']);
    const { runLlm } = await import('../src/llm.js');
    const reply = await runLlm('q', { provider: 'claude', model: 'm' }, repo, 10_000);
    expect(reply.text).toBe('written');
    isolated(argv());
    standsSomewhereEmpty();
  });

  it('streamed, the way the tutor answers', async () => {
    scriptReplies(['answered']);
    const { runLlmStream } = await import('../src/llm.js');
    let streamed = '';
    const reply = await runLlmStream('q', { provider: 'claude', model: 'm' }, repo, (t) => { streamed += t; }, 10_000);
    expect(reply.text).toBe('answered');
    expect(streamed).toBe('answered');
    isolated(argv());
    standsSomewhereEmpty();
  });
});

// ---------------------------------------------------------------- T-20, isolation tidy-ups
//
// Three nits from T-18's last review, each pinned here, and the defect found next to one. The
// partial-messages latch and the `claude update` hint had no test. Every process that ever asked
// a model left an empty `repo-tour-llm-*` directory in /tmp for good (the review counted twelve).
// And codex's answer file had a guessable name in shared /tmp.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Make the fake claude a CLI too old for `flag`, refusing it in the CLI's own words. */
function rejectFlag(flag: string, stderr: string): void {
  fs.writeFileSync(path.join(base, 'reject-flag'), JSON.stringify({ flag, stderr }));
}

/** Where a call stood, as it ran: alone, private, in the temp dir, and never the toured repo. */
function stoodAlone(seen: Omit<Seen, 'argv'>, what: string): void {
  expect(insideRepo(seen.cwd), `${what}: ran inside the toured repo: ${seen.cwd}`).toBe(false);
  expect(seen.listing, `${what}: stood somewhere that was not empty: ${seen.cwd}`).toEqual([]);
  expect(seen.mode, `${what}: stood somewhere other users can open (mode ${seen.mode.toString(8)}): ${seen.cwd}`)
    .toBe(0o700);
  expect(path.dirname(seen.cwd), `${what}: not a directory of its own in the temp dir: ${seen.cwd}`)
    .toBe(fs.realpathSync(os.tmpdir()));
  expect(path.basename(seen.cwd), `${what}: not named as one of repo-tour's own: ${seen.cwd}`)
    .toMatch(/^repo-tour-llm-/);
}

/** And once the call has settled, whichever way, its directory is gone. */
function goneAfter(seen: Omit<Seen, 'argv'>, what: string): void {
  expect(fs.existsSync(seen.cwd), `${what}: its directory outlived the call: ${seen.cwd}`).toBe(false);
}

/** A promise's value, or null if it takes longer than `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => { setTimeout(() => r(null), ms); })]);

/**
 * The fake's pid, once its file is whole. Never 0 or 1: `process.kill(0, …)` signals the whole
 * process group, and that group is the test runner.
 */
async function fakePid(ms = 5000): Promise<number | null> {
  let pid: number | null = null;
  await until(() => {
    try {
      const n = Number(fs.readFileSync(path.join(base, 'pid'), 'utf8'));
      if (Number.isInteger(n) && n > 1) pid = n;
    } catch { /* not written yet */ }
    return pid !== null;
  }, ms);
  return pid;
}

/** SIGKILL a fake claude this file started, if it is still running and is still that fake. */
function killFake(pid: number | null): void {
  if (!pid || !alive(pid)) return;
  let cmd = '';
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return; }
  if (cmd.includes(scriptPath)) process.kill(pid, 'SIGKILL');
}

interface Exit { code: number | null; signal: NodeJS.Signals | null }

/**
 * A process that calls `process.exit` while one of its model calls is still running: the end of
 * the server's own stop, and of any program that imports `./llm`. Returns where the call stood.
 * `node --import tsx` adds no signal listener of its own, so nothing stands in between.
 */
async function exitMidCall(): Promise<{ seen: Omit<Seen, 'argv'> | null; exit: Exit | null; stderr: string }> {
  // A record left by an earlier call would let this pass without the child reaching the model.
  for (const f of ['where.json', 'pid']) fs.rmSync(path.join(base, f), { force: true });
  scriptReplies(['nobody will read this']);
  fs.writeFileSync(path.join(base, 'slow'), '10000');
  const script = path.join(base, 'exit-mid-call.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { runLlm } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'src', 'llm.ts')).href)};
const started = ${JSON.stringify(path.join(base, 'where.json'))};
// The moment the model is mid-answer, leave.
setInterval(() => { if (fs.existsSync(started)) process.exit(0); }, 5);
runLlm('q', { provider: 'claude', model: 'm' }, process.cwd(), 60000).then(
  () => { console.error('the call finished before the process could exit mid-call'); process.exit(3); },
  (e) => { console.error('the call failed: ' + e.message); process.exit(4); },
);
`);
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, REPO_TOUR_CLAUDE_BIN: scriptPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
  const exit = await within(new Promise<Exit>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  }), 20_000);
  if (!exit) child.kill('SIGKILL');
  // The fake it started is an orphan now. It writes its pid just after where.json.
  killFake(await fakePid());
  fs.rmSync(path.join(base, 'slow'), { force: true });
  return { seen: whereNow(), exit, stderr };
}

/** What the T-20 fake codex recorded about how it was called. */
interface CodexSeen {
  argv: string[]; cwd: string; listing: string[];
  out: string | null; outDirMode: number | null; outDirReal: string | null; toldReal: string | null;
}

/**
 * A second fake codex, for T-20 only, so the T-18 one above stays exactly as it was. It records
 * its argv, where it stands, and the directory it is told to write its answer into, while all
 * of them still exist, and then answers into that file.
 */
function recordingCodex(): string {
  const script = path.join(base, 'fake-codex-t20');
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake codex 1.0\\n'); process.exit(0); }
const at = args.indexOf('--output-last-message');
const out = at === -1 ? null : args[at + 1];
const c = args.indexOf('-C');
const here = process.cwd();
fs.writeFileSync(${JSON.stringify(path.join(base, 'codex.json'))}, JSON.stringify({
  argv: args, cwd: here, listing: fs.readdirSync(here), out,
  outDirMode: out ? fs.statSync(path.dirname(out)).mode & 0o777 : null,
  outDirReal: out ? fs.realpathSync(path.dirname(out)) : null,
  toldReal: c === -1 ? null : fs.realpathSync(args[c + 1]),
}));
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (out) fs.writeFileSync(out, 'codex answered from a room of its own');
  process.exit(0);
});
`);
  fs.chmodSync(script, 0o755);
  return script;
}

describe('T-20: a claude CLI too old for the flags (AC1, AC2)', () => {
  const asked = (): unknown => ({ messages: [{ role: 'user', content: 'q' }], context: { repoPath: repo } });

  it('AC1: falls back once, ends in one error, and streams token by token again after an upgrade', async () => {
    const { resetProviderProbe } = await import('../src/llm.js');
    resetProviderProbe();
    try {
      rejectFlag('--safe-mode', "error: unknown option '--safe-mode'\n");
      scriptReplies(['unused']);
      const frames = await ask(await newServer(), asked());
      const terminal = frames.filter((f) => f.kind === 'done' || f.kind === 'error').map((f) => f.kind);
      expect(terminal, 'a CLI too old for --safe-mode must end the question in exactly one error').toEqual(['error']);
      const tried = attempts();
      expect(tried.length, 'the fallback did not run: expected two spawns, with and without the partial flag').toBe(2);
      expect(tried[0]!.argv, 'the first try must ask for token streaming').toContain('--include-partial-messages');
      expect(tried[1]!.argv, 'the fallback must retry without --include-partial-messages')
        .not.toContain('--include-partial-messages');

      // The upgrade: same process, and now a CLI that knows every flag.
      fs.rmSync(path.join(base, 'reject-flag'));
      scriptReplies(['streams again after the upgrade']);
      const before = attempts().length;
      const again = await ask(await newServer(), asked());
      const next = attempts().slice(before);
      expect(next[0]?.argv ?? [], 'the latch kept the downgrade: the next question did not ask for --include-partial-messages')
        .toContain('--include-partial-messages');
      expect(again.filter((f) => f.kind === 'delta').length, 'token streaming did not come back after the upgrade')
        .toBeGreaterThan(1);
      expect(text(again), 'the answer after the upgrade did not arrive whole').toBe('streams again after the upgrade');
    } finally {
      fs.rmSync(path.join(base, 'reject-flag'), { force: true });
      resetProviderProbe();
    }
  }, 30_000);

  /** Ask the tutor once, against a CLI that refuses `flag` with `stderr`: the error the panel shows. */
  const refusedWith = async (flag: string, stderr: string): Promise<string> => {
    const { resetProviderProbe } = await import('../src/llm.js');
    resetProviderProbe();
    rejectFlag(flag, stderr);
    try {
      scriptReplies(['unused']);
      const errors = (await ask(await newServer(), asked())).filter((f) => f.kind === 'error');
      expect(errors, `a CLI that refuses ${flag} must end the question in one error`).toHaveLength(1);
      return String(errors[0]!.data['message']);
    } finally {
      fs.rmSync(path.join(base, 'reject-flag'), { force: true });
      resetProviderProbe();
    }
  };

  it('AC2: the panel says "run `claude update`" for a one-line complaint', async () => {
    const message = await refusedWith('--safe-mode', "error: unknown option '--safe-mode'\n");
    expect(message, 'the reader was not told to run `claude update`').toContain('run `claude update`');
  }, 30_000);

  it('AC2: and for the real CLI\'s two-line complaint, which used to push the hint off the shown line', async () => {
    const message = await refusedWith(
      '--setting-sources', "error: unknown option '--setting-sources'\n(Did you mean --settings?)\n",
    );
    expect(message, 'the hint fell off the one line the panel shows').toContain('run `claude update`');
  }, 30_000);

  it('AC2: narration\'s one-shot call has the hint on the first line of its error', async () => {
    const { runLlm } = await import('../src/llm.js');
    rejectFlag('--setting-sources', "error: unknown option '--setting-sources'\n(Did you mean --settings?)\n");
    scriptReplies(['unused']);
    const failed = await runLlm('q', { provider: 'claude', model: 'm' }, repo, 10_000)
      .then(() => null, (e: unknown) => e as Error);
    expect(failed, 'a CLI too old for --setting-sources must fail the call').toBeInstanceOf(Error);
    expect(failed!.message.split('\n')[0], 'the hint is not on the first line, the only one the PR judge shows')
      .toContain('run `claude update`');
  }, 30_000);

  it('AC2: a CLI that fails for any other reason is not told to update', async () => {
    scriptReplies(['__EXIT1__']);
    const error = (await ask(await newServer(), asked())).find((f) => f.kind === 'error');
    expect(error, 'a failing provider must end the question in an error').toBeDefined();
    expect(String(error!.data['message']), 'a CLI that is not too old was told to update').not.toContain('claude update');

    const { runLlm } = await import('../src/llm.js');
    scriptReplies(['__EXIT1__']);
    const failed = await runLlm('q', { provider: 'claude', model: 'm' }, repo, 10_000)
      .then(() => null, (e: unknown) => e as Error);
    expect(failed, 'a failing provider must fail the one-shot call').toBeInstanceOf(Error);
    expect(failed!.message, 'a CLI that is not too old was told to update').not.toContain('claude update');
  }, 30_000);
});

describe('T-20: no directory outlives its call (AC3)', () => {
  const claude = { provider: 'claude', model: 'm' };

  it('in one shot: alone and private while it runs, gone once it has answered', async () => {
    const { runLlm } = await import('../src/llm.js');
    scriptReplies(['written']);
    expect((await runLlm('q', claude, repo, 10_000)).text, 'the one-shot call did not answer').toBe('written');
    const tried = attempts();
    expect(tried, 'expected exactly one spawn').toHaveLength(1);
    stoodAlone(tried[0]!, 'runLlm');
    goneAfter(tried[0]!, 'runLlm');
  }, 30_000);

  it('streamed: alone and private while it runs, gone once it has answered', async () => {
    const { runLlmStream } = await import('../src/llm.js');
    scriptReplies(['answered']);
    let streamed = '';
    const reply = await runLlmStream('q', claude, repo, (t) => { streamed += t; }, 10_000);
    expect(reply.text, 'the streamed call did not answer').toBe('answered');
    expect(streamed, 'the answer did not stream').toBe('answered');
    const tried = attempts();
    expect(tried, 'expected exactly one spawn').toHaveLength(1);
    stoodAlone(tried[0]!, 'runLlmStream');
    goneAfter(tried[0]!, 'runLlmStream');
  }, 30_000);

  it('the fallback: each of its two spawns has a directory of its own, and both are gone', async () => {
    const { runLlmStream, resetProviderProbe } = await import('../src/llm.js');
    resetProviderProbe();
    fs.writeFileSync(path.join(base, 'no-partial'), '');
    try {
      scriptReplies(['answered the old way']);
      const reply = await runLlmStream('q', claude, repo, () => {}, 10_000);
      expect(reply.text, 'the fallback did not answer').toBe('answered the old way');
      const tried = attempts();
      expect(tried, 'the fallback did not run: expected two spawns').toHaveLength(2);
      tried.forEach((t, i) => {
        stoodAlone(t, `spawn ${i + 1} of the fallback`);
        goneAfter(t, `spawn ${i + 1} of the fallback`);
      });
      expect(tried[0]!.cwd, 'both spawns of the fallback shared one directory').not.toBe(tried[1]!.cwd);
    } finally {
      fs.rmSync(path.join(base, 'no-partial'), { force: true });
      resetProviderProbe();
    }
  }, 30_000);

  it('a failed call: gone all the same, one-shot and streamed', async () => {
    const { runLlm, runLlmStream } = await import('../src/llm.js');
    scriptReplies(['__EXIT1__']);
    await expect(runLlm('q', claude, repo, 10_000), 'the one-shot call should fail').rejects.toThrow(/claude exited 1/);
    scriptReplies(['__EXIT1__']);
    await expect(runLlmStream('q', claude, repo, () => {}, 10_000), 'the streamed call should fail')
      .rejects.toThrow(/claude exited 1/);
    const tried = attempts();
    expect(tried, 'expected one spawn per failed call').toHaveLength(2);
    tried.forEach((t, i) => {
      stoodAlone(t, `failed call ${i + 1}`);
      goneAfter(t, `failed call ${i + 1}`);
    });
  }, 30_000);

  it('a cancelled call: gone as soon as the reader has, while the model is still thinking', async () => {
    const { runLlmStream } = await import('../src/llm.js');
    scriptReplies(['an answer nobody will read']);
    fs.writeFileSync(path.join(base, 'slow'), '5000');
    fs.rmSync(path.join(base, 'pid'), { force: true });
    const reader = new AbortController();
    const settled = runLlmStream('q', claude, repo, () => {}, 10_000, reader.signal)
      .then(() => 'answered', (e: unknown) => (e as Error).message);
    let pid: number | null = null;
    try {
      expect(await until(() => whereNow() !== null, 5000), 'the fake claude never started').toBe(true);
      pid = await fakePid();
      reader.abort();
      expect(await settled, 'a call whose reader has gone should end as cancelled').toMatch(/cancelled/);
      const seen = whereNow()!;
      stoodAlone(seen, 'a cancelled call');
      goneAfter(seen, 'a cancelled call');
    } finally {
      reader.abort();
      killFake(pid);
    }
  }, 30_000);
});

describe('T-20: no directory outlives the process (AC4)', () => {
  it('(b) a process that exits mid-call takes the call\'s directory with it', async () => {
    const { seen, exit, stderr } = await exitMidCall();
    expect(exit, `the child did not exit mid-call as planned: ${stderr}`).toEqual({ code: 0, signal: null });
    expect(seen, 'the call never reached the model').not.toBeNull();
    expect(fs.existsSync(seen!.cwd), `a call cut off by process.exit left its directory behind: ${seen!.cwd}`).toBe(false);
  }, 30_000);

  it('(a) Ctrl-C on the real serve command, mid-answer, leaves no directory (the owner\'s path)', async () => {
    for (const f of ['where.json', 'pid']) fs.rmSync(path.join(base, f), { force: true });
    scriptReplies(['an answer nobody will read']);
    fs.writeFileSync(path.join(base, 'slow'), '5000');
    const child = spawn(process.execPath, [
      '--import', 'tsx', path.join(REPO_ROOT, 'src', 'cli.ts'),
      'serve', '--port', '0', '--state', path.join(base, 'serve-state.json'),
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, REPO_TOUR_CLAUDE_BIN: scriptPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
    const exited = new Promise<Exit>((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); });
    let pid: number | null = null;
    // Another process's directories, the owner's live server among them: the stop's
    // killLlmChildren must take only what this server made (review suggestion 1).
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-llm-'));
    const full = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-llm-'));
    fs.writeFileSync(path.join(full, 'theirs.txt'), 'another process stands here');
    try {
      const listening = /running at http:\/\/127\.0\.0\.1:(\d+)/;
      expect(await until(() => listening.test(out), 30_000), `serve never came up: ${out}`).toBe(true);
      const port = Number(listening.exec(out)![1]);
      const req = request({
        host: '127.0.0.1', port, path: '/api/ask', method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      }, (res) => { res.on('error', () => { /* the server goes away under it */ }); res.resume(); });
      req.on('error', () => { /* the server goes away under it */ });
      req.end(JSON.stringify({ messages: [{ role: 'user', content: 'q' }], context: {} }));

      expect(await until(() => whereNow() !== null, 15_000), `the tutor never reached the model: ${out}`).toBe(true);
      pid = await fakePid();
      const seen = whereNow()!;
      child.kill('SIGINT');
      const exit = await within(exited, 10_000);
      expect(exit, `serve did not stop cleanly on one Ctrl-C: ${out}`).toEqual({ code: 0, signal: null });
      expect(fs.existsSync(seen.cwd), `Ctrl-C on serve left the in-flight call's directory behind: ${seen.cwd}`).toBe(false);
      expect(fs.existsSync(empty), `serve's stop removed another process's empty directory: ${empty}`).toBe(true);
      expect(fs.existsSync(path.join(full, 'theirs.txt')), `serve's stop emptied another process's directory: ${full}`)
        .toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      killFake(pid);
      fs.rmSync(path.join(base, 'slow'), { force: true });
      fs.rmSync(path.join(full, 'theirs.txt'), { force: true });
      for (const d of [empty, full]) {
        try { fs.rmdirSync(d); } catch { /* already gone, which the assertions above report */ }
      }
    }
  }, 60_000);
});

describe('T-20: the cleanup takes only what this process made (AC5)', () => {
  it('leaves another process\'s repo-tour-llm-* directories alone, empty or not', async () => {
    // Decoys standing in for other repo-tour processes, the owner's live server among them.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-llm-'));
    const full = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-tour-llm-'));
    fs.writeFileSync(path.join(full, 'theirs.txt'), 'another process stands here');
    try {
      const { runLlm, runLlmStream } = await import('../src/llm.js');
      scriptReplies(['one shot']);
      await runLlm('q', { provider: 'claude', model: 'm' }, repo, 10_000);
      scriptReplies(['streamed']);
      await runLlmStream('q', { provider: 'claude', model: 'm' }, repo, () => {}, 10_000);
      process.env['REPO_TOUR_CODEX_BIN'] = recordingCodex();
      await runLlm('q', { provider: 'codex', model: 'default' }, repo, 10_000);
      const { exit, stderr } = await exitMidCall();
      expect(exit, `the child did not exit mid-call as planned: ${stderr}`).toEqual({ code: 0, signal: null });

      expect(fs.existsSync(empty), `another process's empty directory was removed: ${empty}`).toBe(true);
      expect(fs.existsSync(path.join(full, 'theirs.txt')), `another process's directory was emptied: ${full}`).toBe(true);
    } finally {
      delete process.env['REPO_TOUR_CODEX_BIN'];
      fs.rmSync(path.join(full, 'theirs.txt'), { force: true });
      for (const d of [empty, full]) {
        try { fs.rmdirSync(d); } catch { /* already gone, which the assertions above report */ }
      }
    }
  }, 60_000);
});

describe('T-20: codex writes its answer inside its own directory (AC6)', () => {
  it('names a file in the private directory it stands in, reads it back, and leaves nothing', async () => {
    const record = path.join(base, 'codex.json');
    fs.rmSync(record, { force: true });
    process.env['REPO_TOUR_CODEX_BIN'] = recordingCodex();
    try {
      const { runLlm } = await import('../src/llm.js');
      const reply = await runLlm('q', { provider: 'codex', model: 'default' }, repo, 10_000);
      expect(reply.text, 'codex\'s answer did not come back').toBe('codex answered from a room of its own');

      const seen = JSON.parse(fs.readFileSync(record, 'utf8')) as CodexSeen;
      const told = seen.argv[seen.argv.indexOf('-C') + 1];
      expect(seen.out, 'codex was not given --output-last-message').not.toBeNull();
      expect(seen.outDirReal, `the answer file is not in the directory codex stands in: ${seen.out}`).toBe(seen.cwd);
      expect(seen.toldReal, `-C (${told}) is not the directory codex stands in`).toBe(seen.cwd);
      expect(path.dirname(seen.cwd), `codex's directory is not one of its own in the temp dir: ${seen.cwd}`)
        .toBe(fs.realpathSync(os.tmpdir()));
      expect(path.basename(seen.cwd), `codex's directory is not named as one of repo-tour's own: ${seen.cwd}`)
        .toMatch(/^repo-tour-llm-/);
      expect(seen.outDirMode, 'the answer file\'s directory is open to other users').toBe(0o700);
      expect(seen.listing, 'codex did not start in an empty directory').toEqual([]);
      expect(seen.outDirReal, 'the answer file sits directly in the shared temp dir, where its name can be taken first')
        .not.toBe(fs.realpathSync(os.tmpdir()));
      expect(insideRepo(seen.cwd), `codex ran inside the toured repo: ${seen.cwd}`).toBe(false);

      expect(fs.existsSync(seen.out!), `the answer file outlived the call: ${seen.out}`).toBe(false);
      expect(fs.existsSync(seen.cwd), `codex's directory outlived the call: ${seen.cwd}`).toBe(false);
    } finally {
      delete process.env['REPO_TOUR_CODEX_BIN'];
    }
  }, 30_000);
});

// ---------------------------------------------------------------- T-20 review round 1

describe('T-20 review: the cleanup is exact on every path', () => {
  it('rmdir only: a directory the CLI left something in stays, and so does what it left (nit 2)', async () => {
    // Defence in depth. A recursive remove here, with any bug that handed it the wrong path,
    // would delete whatever that path held: the toured repo, say.
    const { runLlm } = await import('../src/llm.js');
    scriptReplies(['answered']);
    fs.writeFileSync(path.join(base, 'litter'), '');
    const tried: Seen[] = [];
    try {
      expect((await runLlm('q', { provider: 'claude', model: 'm' }, repo, 10_000)).text, 'the call did not answer')
        .toBe('answered');
      tried.push(...attempts());
      expect(tried, 'expected exactly one spawn').toHaveLength(1);
      const { cwd } = tried[0]!;
      expect(fs.existsSync(cwd), `a directory that was not empty was removed: ${cwd}`).toBe(true);
      expect(fs.existsSync(path.join(cwd, 'litter.txt')), `what the CLI left was removed with it: ${cwd}`).toBe(true);
    } finally {
      for (const t of tried) {
        fs.rmSync(path.join(t.cwd, 'litter.txt'), { force: true });
        try { fs.rmdirSync(t.cwd); } catch { /* already gone, which the assertions above report */ }
      }
    }
  }, 30_000);

  it('a killed codex call takes its answer file and its directory with it at once, and fails (nit 5)', async () => {
    // A codex that has written its answer but not exited. On pr's signal path the process dies
    // straight after killLlmChildren, so whatever that leaves stays: here, the model's answer.
    const record = path.join(base, 'codex-sleeper.json');
    fs.rmSync(record, { force: true });
    const script = path.join(base, 'fake-codex-sleeper');
    fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('fake codex 1.0\\n'); process.exit(0); }
const out = args[args.indexOf('--output-last-message') + 1];
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(out, 'an answer nobody is waiting for');
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, out }));
  setTimeout(() => process.exit(0), 30000);   // answered, and not leaving
});
`);
    fs.chmodSync(script, 0o755);
    process.env['REPO_TOUR_CODEX_BIN'] = script;
    const { runLlm, killLlmChildren } = await import('../src/llm.js');
    const settled = runLlm('q', { provider: 'codex', model: 'default' }, repo, 30_000)
      .then((r) => ({ answered: r.text }), (e: unknown) => ({ failed: (e as Error).message }));
    let seen: { pid: number; out: string } | null = null;
    try {
      expect(await until(() => {
        try { seen = JSON.parse(fs.readFileSync(record, 'utf8')) as { pid: number; out: string }; return true; }
        catch { return false; }
      }, 10_000), 'the fake codex never wrote its answer').toBe(true);
      const { out } = seen!;
      expect(fs.existsSync(out), 'the answer file is not there to begin with').toBe(true);

      killLlmChildren();
      expect.soft(fs.existsSync(out), `killLlmChildren left the model's answer behind: ${out}`).toBe(false);
      expect.soft(fs.existsSync(path.dirname(out)), `killLlmChildren left the call's directory behind: ${path.dirname(out)}`)
        .toBe(false);
      expect(await settled, 'a killed call returned its answer, though nobody is waiting for it')
        .toEqual({ failed: expect.stringMatching(/codex exited/) });
    } finally {
      delete process.env['REPO_TOUR_CODEX_BIN'];
      const pid = (seen as { pid: number } | null)?.pid;
      if (pid && pid > 1 && alive(pid)) {
        try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(script)) process.kill(pid, 'SIGKILL'); }
        catch { /* gone */ }
      }
      await settled;
    }
  }, 30_000);

  it('a stale leave never touches a path this process no longer owns (nit 6)', async () => {
    // killLlmChildren removes the directory and forgets it. The call's own cleanup runs a few
    // ms later, when the killed child closes. If the same name has been drawn again in between,
    // that directory belongs to someone else now.
    const { runLlm, killLlmChildren } = await import('../src/llm.js');
    scriptReplies(['nobody will read this']);
    fs.writeFileSync(path.join(base, 'slow'), '10000');
    fs.rmSync(path.join(base, 'pid'), { force: true });
    const settled = runLlm('q', { provider: 'claude', model: 'm' }, repo, 30_000).then(() => 'answered', () => 'failed');
    let impostor: string | null = null;
    let pid: number | null = null;
    try {
      expect(await until(() => whereNow() !== null, 10_000), 'the fake claude never started').toBe(true);
      pid = await fakePid();
      const { cwd } = whereNow()!;
      killLlmChildren();
      expect(fs.existsSync(cwd), `killLlmChildren did not remove the call's directory: ${cwd}`).toBe(false);
      fs.mkdirSync(cwd);           // the impostor: the same name, drawn again by someone else
      impostor = cwd;
      await settled;
      expect(fs.existsSync(impostor), `the call's late cleanup removed a directory it no longer owns: ${impostor}`).toBe(true);
    } finally {
      killFake(pid);
      if (impostor) { try { fs.rmdirSync(impostor); } catch { /* already gone, which the assertion above reports */ } }
      await settled;
    }
  }, 30_000);
});
