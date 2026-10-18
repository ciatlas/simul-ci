import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/engine/session';
import { createSessionStore } from '../src/state/store';
import type { CaseResult, EngineClient, LoadResult, SimulateResult } from '../src/worker/client';
import type { Outline, ReadyResponse } from '../src/worker/protocol';

/** A client whose answers the test hands out in order. */
function fakeClient() {
  const loads: ((r: LoadResult) => void)[] = [];
  const simulates: {
    body: { project: number; scenario: { event: string } };
    resolve: (r: SimulateResult) => void;
  }[] = [];
  let readyResolve!: (r: ReadyResponse) => void;
  let readyReject!: (e: Error) => void;
  const restartListeners: ((n: number, project: number | undefined) => void)[] = [];
  const client: EngineClient = {
    ready: new Promise<ReadyResponse>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    }),
    load: () => new Promise<LoadResult>((resolve) => loads.push(resolve)),
    simulate: (body) => new Promise<SimulateResult>((resolve) => simulates.push({ body, resolve })),
    case: () => Promise.resolve({ type: 'superseded' } as CaseResult),
    onRestart: (l) => restartListeners.push(l),
    restarts: () => 0,
    terminate: () => undefined,
  };
  return { client, loads, simulates, readyResolve, readyReject, restartListeners };
}

const outline: Outline = {
  files: [{ path: '.github/workflows/ci.yml', kind: 'workflow', errors: [] }],
  workflows: [
    {
      path: '.github/workflows/ci.yml',
      callable: false,
      events: [{ event: 'push', branches: ['main', 'release/**'] }, { event: 'pull_request' }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: {},
};

const plan = (project: number): SimulateResult =>
  ({
    id: 1,
    type: 'plan',
    project,
    plan: { workflows: [] },
    derived: {},
    text: 'plan',
    ms: { simulate: 1, derive: 0 },
  }) as never;

describe('the session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads new files, applies the defaults, simulates at once and re-simulates after a quiet period', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    f.readyResolve({ type: 'ready', protocol: 1, engine: { version: '0.1.0', runPlan: 1 }, models: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.status).toBe('ready');
    store.getState().setFiles({ '.github/workflows/ci.yml': 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project.status).toBe('loading');
    expect(f.loads).toHaveLength(1);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const s = store.getState();
    expect(s.project).toMatchObject({ status: 'ready', version: 1, files: 1 });
    expect(s.scenario).toEqual({ event: 'push', branch: 'main' });
    expect(s.assumed).toEqual(['event', 'branch']);
    expect(s.focus).toBe('.github/workflows/ci.yml');
    expect(f.simulates).toHaveLength(1);
    expect(f.simulates[0]!.body).toMatchObject({ project: 1, scenario: { event: 'push', branch: 'main' } });
    f.simulates[0]!.resolve(plan(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan?.text).toBe('plan');
    expect(store.getState().stale).toBe(false);
    store.getState().patchScenario({ branch: 'release/1' });
    expect(store.getState().stale).toBe(true);
    expect(store.getState().assumed).toEqual(['event']);
    store.getState().patchScenario({ branch: 'release/2' });
    await vi.advanceTimersByTimeAsync(99);
    expect(f.simulates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.simulates).toHaveLength(2);
    expect(f.simulates[1]!.body.scenario).toEqual({ event: 'push', branch: 'release/2' });
  });

  it('keeps the URL scenario, drops answers to older requests and routes invalid, stale and engine errors', async () => {
    const store = createSessionStore();
    store.getState().setScenario({ event: 'pull_request', base: 'main' }, { from: 'url' });
    const f = fakeClient();
    createSession({ store, client: f.client, debounceMs: 100 });
    store.getState().setFiles({ '.github/workflows/ci.yml': 'on: push' }, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().scenario).toEqual({ event: 'pull_request', base: 'main' });
    expect(store.getState().assumed).toEqual([]);
    const first = f.simulates[0]!;
    store.getState().patchScenario({ base: 'dev' });
    await vi.advanceTimersByTimeAsync(100);
    const second = f.simulates[1]!;
    first.resolve({ ...(plan(1) as object), text: 'old' } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan).toBeUndefined();
    second.resolve({ id: 2, type: 'invalid', what: 'scenario', issues: [{ path: ['base'], message: 'no' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().error).toMatchObject({ kind: 'scenario', message: 'no' });
    store.getState().patchScenario({ base: 'main' });
    expect(store.getState().error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    f.simulates[2]!.resolve({ id: 3, type: 'error', kind: 'stale', message: 'another project' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.loads).toHaveLength(2);
    f.loads[1]!({ id: 4, type: 'loaded', project: 2, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project.version).toBe(2);
    expect(f.simulates[3]!.body.project).toBe(2);
    f.simulates[3]!.resolve({ id: 5, type: 'error', kind: 'engine', message: 'boom', stack: 'at x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().error).toMatchObject({ kind: 'engine', message: 'boom', stack: 'at x' });
  });

  it('reports a boot failure and a restart with its new project id', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client });
    f.readyReject(new Error('the engine did not start'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.status).toBe('failed');
    expect(store.getState().error).toMatchObject({ kind: 'boot', message: 'the engine did not start' });
    store.getState().projectReady(3, outline, 1);
    f.restartListeners[0]!(1, 9);
    expect(store.getState().engine.restarts).toBe(1);
    expect(store.getState().project.version).toBe(9);
    expect(store.getState().notices.map((n) => n.text)).toEqual(['the engine restarted']);
  });
});
