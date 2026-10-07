/**
 * The Ask panel when the line drops mid-answer (2026-10-07, the owner's test drive).
 *
 * The other panel tests can only check the script's TEXT. This one runs it: the real script,
 * in a VM, against a few stub elements and a fetch whose body breaks after one lookup, the way
 * Firefox's did. What the reader saw then was the browser's own words, "Error in input stream",
 * which read as the tutor being broken rather than the connection.
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { askPanelScript } from '../src/askpanel.js';

/** Just enough of an element for the panel: it builds, appends, labels and listens. */
class El {
  children: El[] = [];
  parent: El | null = null;
  className = '';
  textContent = '';
  private html = '';
  get innerHTML(): string { return this.html; }
  set innerHTML(v: string) { this.html = v; this.children = []; }
  value = '';
  type = '';
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  private handlers: Record<string, Array<(e: unknown) => void>> = {};
  private attrs: Record<string, string> = {};
  classList = {
    add: (c: string) => { if (!this.className.split(' ').includes(c)) this.className += ' ' + c; },
    remove: (c: string) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); },
  };
  appendChild(c: El): El { c.parent = this; this.children.push(c); return c; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
  addEventListener(type: string, fn: (e: unknown) => void): void { (this.handlers[type] ??= []).push(fn); }
  fire(type: string, e: unknown = {}): void { for (const fn of this.handlers[type] ?? []) fn(e); }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  focus(): void {}
  all(): El[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

/** A response whose body delivers `frames`, then fails the way a pruned connection does. */
function breakingResponse(frames: string): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(frames)); return; }
      controller.error(new TypeError('Error in input stream'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function runPanel(fetchImpl: () => Promise<Response>): { log: El; send: El; input: El } {
  const ids: Record<string, El> = {
    asklog: new El(), askinput: new El(), asksend: new El(), asknote: new El(), askscope: new El(),
  };
  const store = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => ids[id] ?? null,
      createElement: () => new El(),
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    },
    fetch: fetchImpl,
    TextDecoder,
    JSON,
    Date,
  };
  sandbox['window'] = sandbox;
  vm.runInNewContext(askPanelScript({ notesKey: 'n', chatKey: 'c', offlineHint: 'OFFLINE' }), sandbox);
  return { log: ids['asklog']!, send: ids['asksend']!, input: ids['askinput']! };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('the line drops mid-answer', () => {
  it('says so in plain words, not the browser\'s', async () => {
    const { log, send, input } = runPanel(async () =>
      breakingResponse('event: fetch\ndata: {"what":"search parse_path","ok":true}\n\n'));
    input.value = 'why is this normalised twice?';
    send.fire('click');
    await settle();

    const shown = log.all().map((e) => e.textContent).join('\n');
    expect(shown).toContain('read search parse_path');
    expect(shown).toContain('The connection to repo-tour dropped before the answer arrived. Ask again.');
    expect(shown).not.toContain('Error in input stream');
    // and the panel is usable again
    expect(send.disabled).toBe(false);
  });

  it('still says a stopped server is a stopped server', async () => {
    const { log, send, input } = runPanel(async () => { throw new TypeError('Failed to fetch'); });
    input.value = 'q';
    send.fire('click');
    await settle();

    const shown = log.all().map((e) => e.textContent).join('\n');
    expect(shown).toContain('OFFLINE');
    expect(shown).not.toContain('dropped');
  });
});
