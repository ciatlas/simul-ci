import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/engine/session';
import { createSessionStore } from '../src/state/store';
import { createEngineClient, type WorkerLike } from '../src/worker/client';
import { type Outline, PROTOCOL, SUPPORTED_RUN_PLAN } from '../src/worker/protocol';

/**
 * The hold (synthesis § 7.2) against the real client's restart replay (§ 9.4 row 22): whatever the watchdog restarts
 * while an edit loads or a simulate is out, the screen never shows a plan of texts it did not commit, and of broken
 * texts never at all; a load that stalled and is answered once replayed does not count against the engine.
 */

class FakeWorker implements WorkerLike {
  sent: { id: number; type: string; files?: Record<string, string>; project?: number }[] = [];
  private listeners: Record<string, ((event: { data: unknown }) => void)[]> = { message: [], error: [] };
  postMessage(message: unknown): void {
    this.sent.push(message as FakeWorker['sent'][number]);
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners[type]?.push(listener);
  }
  terminate(): void {}
  reply(data: unknown): void {
    for (const l of this.listeners.message!) l({ data });
  }
  ready(): void {
    this.reply({
      type: 'ready',
      protocol: PROTOCOL,
      engine: { version: '0.1.0', runPlan: SUPPORTED_RUN_PLAN },
      models: [],
    });
  }
}

const CI = '.github/workflows/ci.yml';

const outlineWith = (yaml: boolean): Outline => ({
  files: [
    {
      path: CI,
      kind: 'workflow',
      errors: yaml ? [{ line: 1, column: 1, message: 'bad', source: 'yaml' }] : [],
    },
  ],
  workflows: [{ path: CI, callable: false, events: [{ event: 'push' }], jobs: [], onLine: 1 }],
  events: {},
});

const planReply = (id: number, project: number, text: string) => ({
  id,
  type: 'plan',
  project,
  plan: { workflows: [], unknowns: [], detail: 'steps' },
  derived: {},
  text,
  ms: { simulate: 1, derive: 0 },
});

describe('a restart while an edit loads or a simulate is out', () => {
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

  const planned = async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.reply({
      id: workers[0]!.sent[0]!.id,
      type: 'loaded',
      project: 1,
      outline: outlineWith(false),
      ms: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.reply(planReply(workers[0]!.sent[1]!.id, 1, 'good plan'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan?.text).toBe('good plan');
    return store;
  };

  it('never shows a plan of the broken texts held, from a simulate sent while the broken load was out', async () => {
    const store = await planned();
    // A key breaks the YAML; its load goes out after the quiet and stalls in the worker.
    store.getState().typed(CI, [{ from: 0, to: 0, insert: ':' }]);
    await vi.advanceTimersByTimeAsync(150);
    // While it loads, the project shown is still ready: a scenario change simulates it (project 1).
    store.getState().patchScenario({ branch: 'dev' });
    await vi.advanceTimersByTimeAsync(100);
    expect(workers[0]!.sent.map((m) => [m.type, m.project])).toEqual([
      ['load', undefined],
      ['simulate', 1],
      ['load', undefined],
      ['simulate', 1],
    ]);
    // The load stalls past the watchdog: a new worker gets the newest (broken) texts first.
    await vi.advanceTimersByTimeAsync(3001);
    expect(workers).toHaveLength(2);
    workers[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent).toMatchObject([{ type: 'load', files: { [CI]: ':on: push\n' } }]);
    workers[1]!.reply({
      id: workers[1]!.sent[0]!.id,
      type: 'loaded',
      project: 1,
      outline: outlineWith(true),
      ms: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    // The session holds the broken texts...
    expect(store.getState().project.held).toBeDefined();
    // The scenario's simulate was about the project shown, which went with the old worker: it is not sent again.
    const simulates = workers[1]!.sent.filter((m) => m.type === 'simulate');
    if (simulates.length) {
      workers[1]!.reply(planReply(simulates[0]!.id, 1, 'plan of the broken texts'));
      await vi.advanceTimersByTimeAsync(0);
    }
    // § 7.2 / § 9.4 row 22: a held load never simulates, and the plan shown stays the last good one.
    expect(store.getState().plan?.text).toBe('good plan');
    expect(simulates).toHaveLength(0);
  });

  it('nor from a simulate that stalled before the broken load was in', async () => {
    const store = await planned();
    store.getState().patchScenario({ branch: 'dev' });
    await vi.advanceTimersByTimeAsync(100);
    store.getState().typed(CI, [{ from: 0, to: 0, insert: ':' }]);
    await vi.advanceTimersByTimeAsync(150);
    expect(workers[0]!.sent.map((m) => m.type)).toEqual(['load', 'simulate', 'simulate', 'load']);
    // The simulate stalls (the worker never got to the load): restart, replay the waiting (broken) load.
    await vi.advanceTimersByTimeAsync(3001);
    workers[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    workers[1]!.reply({
      id: workers[1]!.sent[0]!.id,
      type: 'loaded',
      project: 1,
      outline: outlineWith(true),
      ms: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project.held).toBeDefined();
    const simulates = workers[1]!.sent.filter((m) => m.type === 'simulate');
    if (simulates.length) {
      workers[1]!.reply(planReply(simulates[0]!.id, 1, 'plan of the broken texts'));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(store.getState().plan?.text).toBe('good plan');
    expect(simulates).toHaveLength(0);
  });
  it('never takes the replay of an edit the store has moved past for the project shown', async () => {
    const store = await planned();
    // A key breaks the YAML; its load goes out after the quiet and stalls.
    store.getState().typed(CI, [{ from: 0, to: 0, insert: ':' }]);
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(3001);
    expect(workers).toHaveLength(2);
    // The author types on while the new worker starts: that key waits for its 150 ms of quiet.
    store.getState().typed(CI, [{ from: 1, to: 1, insert: ' ' }]);
    workers[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    // The replay is the stalled (broken) load; its answer is for files the store has moved past, so the session drops it.
    expect(workers[1]!.sent).toMatchObject([{ type: 'load', files: { [CI]: ':on: push\n' } }]);
    workers[1]!.reply({
      id: workers[1]!.sent[0]!.id,
      type: 'loaded',
      project: 1,
      outline: outlineWith(true),
      ms: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    const s = store.getState();
    // The replayed texts were never committed: the project shown keeps its files and has no id in the new worker.
    expect(s.project).toMatchObject({ status: 'ready', files: 1, version: undefined });
    // A scenario change within the 150 ms simulates nothing until the newest texts commit.
    store.getState().patchScenario({ branch: 'dev' });
    await vi.advanceTimersByTimeAsync(100);
    const simulates = workers[1]!.sent.filter((m) => m.type === 'simulate');
    if (simulates.length) {
      workers[1]!.reply(planReply(simulates[0]!.id, simulates[0]!.project!, 'plan of the broken texts'));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(store.getState().plan?.text).toBe('good plan');
  });
  it('does not give the engine up for loads that stalled once each and were answered when replayed', async () => {
    const store = await planned();
    let at = 0;
    for (const [round, insert] of [
      [1, ':'],
      [2, ' '],
      [3, ' '],
    ] as const) {
      store.getState().typed(CI, [{ from: at, to: at, insert }]);
      at += 1;
      // This edit's load goes out and stalls; the replacement answers its replay at once, and the session holds it.
      const before = workers.length;
      for (
        let t = 0;
        t < 20_000 && workers.length === before && store.getState().engine.status !== 'failed';
        t += 50
      )
        await vi.advanceTimersByTimeAsync(50);
      if (round === 3) break;
      workers[round]!.ready();
      await vi.advanceTimersByTimeAsync(0);
      workers[round]!.reply({
        id: workers[round]!.sent[0]!.id,
        type: 'loaded',
        project: 1,
        outline: outlineWith(true),
        ms: 1,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getState().project.held).toBeDefined();
    }
    // Each stall was recovered from.
    expect(store.getState().engine.status).not.toBe('failed');
  });
});
