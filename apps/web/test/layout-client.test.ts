import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerLike } from '../src/worker/client';
import { createLayoutClient, type LayoutResult, spawnLayoutWorker } from '../src/worker/layout-client';
import type { LayoutRequest, LayoutResponse } from '../src/worker/layout-protocol';

/** A worker that records what it was sent and answers when the test says. */
class FakeWorker implements WorkerLike {
  sent: LayoutRequest[] = [];
  terminated = false;
  private listeners: Record<string, ((event: { data: unknown }) => void)[]> = { message: [], error: [] };
  postMessage(message: unknown): void {
    this.sent.push(message as LayoutRequest);
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners[type]?.push(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    for (const l of this.listeners.message!) l({ data });
  }
  /** Lays out the request it was sent at `index`. */
  answer(index: number): void {
    this.reply({ id: this.sent[index]!.id, type: 'layout', scopes: {}, ms: 3 });
  }
  crash(message?: string): void {
    for (const l of this.listeners.error!) l({ message } as never);
  }
}

const body = (scope: string) => ({ scopes: [{ id: scope, nodes: [], edges: [] }], known: {} });

/** Settles what a promise holds by now, without waiting for it. */
async function settled<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ]);
}

describe('the layout client', () => {
  it('keeps one request in flight and the newest waiting, and answers the one it replaces superseded', async () => {
    const w = new FakeWorker();
    const client = createLayoutClient({ spawn: () => w });
    const a = client.layout(body('a'));
    const b = client.layout(body('b'));
    const c = client.layout(body('c'));
    expect(w.sent).toEqual([{ id: 1, type: 'layout', ...body('a') }]);
    expect(await b).toEqual({ type: 'superseded' });
    w.answer(0);
    expect(await a).toEqual({ id: 1, type: 'layout', scopes: {}, ms: 3 });
    expect(w.sent.map((r) => r.scopes[0]!.id)).toEqual(['a', 'c']);
    w.answer(1);
    expect(await c).toMatchObject({ id: 2, type: 'layout' });
  });

  it('drops a reply that is not for the request in flight', async () => {
    const w = new FakeWorker();
    const client = createLayoutClient({ spawn: () => w });
    const a = client.layout(body('a'));
    w.reply({ id: 99, type: 'layout', scopes: {}, ms: 1 });
    w.reply(null);
    expect(await settled(a)).toBe('pending');
    w.answer(0);
    expect(await settled(a)).toMatchObject({ id: 1, type: 'layout' });
    w.answer(0);
    expect(w.sent).toHaveLength(1);
  });

  it("passes the worker's error on and goes on with the waiting request", async () => {
    const w = new FakeWorker();
    const client = createLayoutClient({ spawn: () => w });
    const a = client.layout(body('a'));
    const b = client.layout(body('b'));
    w.reply({ id: 1, type: 'error', message: 'Referenced shape does not exist: x' });
    expect(await a).toEqual({ id: 1, type: 'error', message: 'Referenced shape does not exist: x' });
    w.answer(1);
    expect(await b).toMatchObject({ id: 2, type: 'layout' });
  });

  it('answers everything with an error once the worker fails, and later requests at once', async () => {
    const w = new FakeWorker();
    const client = createLayoutClient({ spawn: () => w });
    const a = client.layout(body('a'));
    const b = client.layout(body('b'));
    w.crash('Failed to fetch a dynamically imported module');
    const failed = { type: 'error', message: 'Failed to fetch a dynamically imported module' };
    expect(await a).toMatchObject(failed);
    expect(await b).toMatchObject(failed);
    expect(await client.layout(body('c'))).toMatchObject(failed);
    expect(w.sent).toHaveLength(1);
    const v = new FakeWorker();
    const other = createLayoutClient({ spawn: () => v });
    const d = other.layout(body('d'));
    v.crash();
    expect(await d).toMatchObject({ type: 'error', message: 'the layout worker failed' });
  });

  it('answers what it holds superseded when it is shut down', async () => {
    const w = new FakeWorker();
    const client = createLayoutClient({ spawn: () => w });
    const a = client.layout(body('a'));
    const b = client.layout(body('b'));
    client.terminate();
    expect(await a).toEqual({ type: 'superseded' });
    expect(await b).toEqual({ type: 'superseded' });
    expect(w.terminated).toBe(true);
    expect(await client.layout(body('c'))).toMatchObject({ type: 'error' });
  });
});

describe('the layout worker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is spawned from its own module as an ES module worker, which makes it a chunk of its own', () => {
    const made: { url: URL; options: unknown }[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        constructor(url: URL, options: unknown) {
          made.push({ url, options });
        }
        terminate(): void {}
      },
    );
    spawnLayoutWorker();
    expect(made).toHaveLength(1);
    expect(made[0]!.url.pathname).toMatch(/\/src\/worker\/layout\.worker\.ts$/);
    expect(made[0]!.options).toEqual({ type: 'module' });
  });

  it("answers a request from its page with ELK's positions, where a worker's global scope has no document", async () => {
    const listeners: ((event: { origin: string; source: unknown; data: unknown }) => void)[] = [];
    const posted: LayoutResponse[] = [];
    vi.stubGlobal('self', globalThis);
    vi.stubGlobal('addEventListener', (_: string, l: (typeof listeners)[number]) => listeners.push(l));
    vi.stubGlobal('postMessage', (m: LayoutResponse) => posted.push(m));
    await import('../src/worker/layout.worker');
    expect(listeners).toHaveLength(1);
    const request: LayoutRequest = {
      id: 4,
      type: 'layout',
      scopes: [
        {
          id: 'ci.yml',
          nodes: [
            { id: 'ci.yml#a', width: 168, height: 50 },
            { id: 'ci.yml#b', width: 168, height: 50 },
          ],
          edges: [{ id: 'ci.yml#a->ci.yml#b', source: 'ci.yml#a', target: 'ci.yml#b' }],
        },
      ],
      known: {},
    };
    const page = { origin: '', source: null };
    listeners[0]!({ ...page, data: { type: 'simulate' } });
    listeners[0]!({ origin: 'https://example.com', source: {}, data: request });
    listeners[0]!({ ...page, data: request });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const answer = posted[0] as LayoutResult & { type: 'layout' };
    expect(answer).toMatchObject({ id: 4, type: 'layout' });
    expect(answer.scopes['ci.yml']!.positions).toEqual({
      'ci.yml#a': { x: 16, y: 40 },
      'ci.yml#b': { x: 16 + 168 + 48, y: 40 },
    });
    expect('document' in globalThis).toBe(false);
  });
});
