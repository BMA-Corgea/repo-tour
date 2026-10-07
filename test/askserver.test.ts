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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import type http from 'node:http';

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
fs.writeFileSync(dir + '/pid', String(process.pid));
// A model that thinks before it speaks, for as many ms as the fixture says.
const slow = fs.existsSync(dir + '/slow') ? Number(fs.readFileSync(dir + '/slow', 'utf8')) : 0;
const text = replies[Math.min(n, replies.length - 1)];
// read stdin so the parent's write never blocks
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => setTimeout(reply, slow));
function reply() {
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
    const where = JSON.parse(fs.readFileSync(path.join(base, 'cwd.json'), 'utf8')) as string;
    const inRepo = path.resolve(where) === path.resolve(repo) || where.startsWith(path.resolve(repo) + path.sep);
    expect(inRepo, `ran inside the toured repo: ${where}`).toBe(false);
    expect(fs.readdirSync(where)).toEqual([]);
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
