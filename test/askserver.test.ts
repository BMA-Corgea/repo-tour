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
const replies = JSON.parse(fs.readFileSync(dir + '/replies.json', 'utf8'));
const n = Number(fs.readFileSync(dir + '/calls.json', 'utf8'));
fs.writeFileSync(dir + '/calls.json', String(n + 1));
const text = replies[Math.min(n, replies.length - 1)];
// read stdin so the parent's write never blocks
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (text === '__EXIT1__') { process.stderr.write('boom\\n'); process.exit(1); }
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'system', subtype: 'init' });
  // thinking must never reach the reader — emitted here on purpose
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } });
  const third = Math.ceil(text.length / 3) || 1;
  for (let i = 0; i < text.length; i += third) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + third) } } });
  }
  emit({ type: 'result', result: text, usage: { input_tokens: 11, output_tokens: 22 }, total_cost_usd: 0.5 });
  process.exit(0);
});
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
});

interface Frame { kind: string; data: Record<string, unknown> }

/** POST to /api/ask and collect the event stream it writes. */
async function ask(
  server: { handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> },
  body: unknown,
): Promise<Frame[]> {
  let written = '';
  let status = 0;
  const res = {
    writableEnded: false,
    writeHead(code: number) { status = code; return this; },
    write(chunk: string) { written += chunk; return true; },
    end() { (this as { writableEnded: boolean }).writableEnded = true; return this; },
  } as unknown as http.ServerResponse;

  const payload = JSON.stringify(body);
  const req = {
    url: '/api/ask',
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  } as unknown as http.IncomingMessage;

  await server.handler(req, res);
  expect(status).toBe(200);

  return written
    .split('\n\n')
    .filter((b) => b.trim())
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
      url: '/api/ask', method: 'POST',
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
