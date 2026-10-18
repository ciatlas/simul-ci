import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineClient, type WorkerLike } from '../src/worker/client';
import { PROTOCOL, type ReadyResponse } from '../src/worker/protocol';

/** A worker that records what it was sent and answers when the test says. */
class FakeWorker implements WorkerLike {
  sent: { id: number; type: string }[] = [];
  terminated = false;
  private listeners: ((event: { data: unknown }) => void)[] = [];
  postMessage(message: unknown): void {
    this.sent.push(message as { id: number; type: string });
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.push(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    for (const l of this.listeners) l({ data });
  }
  ready(over: Partial<ReadyResponse> = {}): void {
    this.reply({
      type: 'ready',
      protocol: PROTOCOL,
      engine: { version: '0.0.0', runPlan: 1 },
      models: [],
      ...over,
    });
  }
}

const plan = (id: number) => ({
  id,
  type: 'plan',
  project: 1,
  plan: {},
  derived: {},
  text: '',
  ms: { simulate: 1, derive: 1 },
});

describe('the engine client', () => {
  const workers: FakeWorker[] = [];
  const spawn = () => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    workers.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('holds requests until ready, keeps one in flight and one waiting per kind, and drops stale replies', async () => {
    const client = createEngineClient({ spawn });
    const w = workers[0]!;
    const load = client.load({ files: {} });
    expect(w.sent).toEqual([]);
    w.ready();
    await client.ready;
    expect(w.sent).toEqual([{ id: 1, type: 'load', files: {} }]);
    const a = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    const b = client.simulate({
      project: 1,
      scenario: { event: 'push', branch: 'x' },
      assume: [],
      detail: 'steps',
    });
    const c = client.simulate({
      project: 1,
      scenario: { event: 'push', branch: 'y' },
      assume: [],
      detail: 'steps',
    });
    expect(w.sent.map((m) => m.type)).toEqual(['load', 'simulate']);
    expect(await b).toEqual({ type: 'superseded' });
    w.reply({ id: 1, type: 'loaded', project: 1, outline: {}, ms: 1 });
    expect((await load).type).toBe('loaded');
    w.reply(plan(99));
    w.reply(plan(2));
    expect((await a).type).toBe('plan');
    expect(w.sent.map((m) => m.id)).toEqual([1, 2, 3]);
    w.reply(plan(3));
    expect((await c).type).toBe('plan');
  });

  it('restarts a stalled worker, replays the load and the request, and gives up after two restarts', async () => {
    const client = createEngineClient({ spawn });
    const restarts: number[] = [];
    client.onRestart((n) => restarts.push(n));
    workers[0]!.ready();
    await client.ready;
    void client.load({ files: { a: '' } });
    workers[0]!.reply({ id: 1, type: 'loaded', project: 1, outline: {}, ms: 1 });
    const stalled = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    await vi.advanceTimersByTimeAsync(3001);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(restarts).toEqual([1]);
    workers[1]!.ready();
    await client.ready;
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent.map((m) => m.type)).toEqual(['load', 'simulate']);
    workers[1]!.reply({ ...plan(workers[1]!.sent[1]!.id) });
    expect((await stalled).type).toBe('plan');
    const again = client.simulate({ project: 1, scenario: { event: 'push' }, assume: [], detail: 'steps' });
    await vi.advanceTimersByTimeAsync(3001);
    workers[2]!.ready();
    await client.ready;
    await vi.advanceTimersByTimeAsync(3001);
    expect(await again).toMatchObject({
      type: 'error',
      kind: 'engine',
      message: 'the engine stopped responding',
    });
    expect(client.restarts()).toBe(3);
  });

  it('rejects ready on a protocol mismatch and when the worker never starts', async () => {
    const client = createEngineClient({ spawn });
    workers[0]!.ready({ protocol: 2 as never });
    await expect(client.ready).rejects.toThrow(/protocol 2/);
    const slow = createEngineClient({ spawn, readyTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    await expect(slow.ready).rejects.toThrow(/did not start/);
  });
});
