import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/engine/session';
import { reportable } from '../src/state/report';
import { createSessionStore, isBlocking } from '../src/state/store';
import {
  type CaseResult,
  createEngineClient,
  type EngineClient,
  type LoadResult,
  type SimulateResult,
  type WorkerLike,
} from '../src/worker/client';
import { type Outline, PROTOCOL, type ReadyResponse, SUPPORTED_RUN_PLAN } from '../src/worker/protocol';

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
  const failureListeners: ((message: string) => void)[] = [];
  const client: EngineClient = {
    ready: new Promise<ReadyResponse>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    }),
    load: () => new Promise<LoadResult>((resolve) => loads.push(resolve)),
    simulate: (body) => new Promise<SimulateResult>((resolve) => simulates.push({ body, resolve })),
    case: () => Promise.resolve({ type: 'superseded' } as CaseResult),
    onRestart: (l) => restartListeners.push(l),
    onFailure: (l) => failureListeners.push(l),
    restarts: () => 0,
    terminate: () => undefined,
  };
  /** The engine never started: `ready` rejects and the failure listeners hear why, as the real client does. */
  const fail = (message: string): void => {
    readyReject(new Error(message));
    for (const l of failureListeners) l(message);
  };
  return { client, loads, simulates, readyResolve, fail, restartListeners };
}

/** A worker for the real client that answers only when the test says. */
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
  /** Answers the load it was sent at `index` with `project`. */
  loaded(index: number, project: number): void {
    this.reply({ id: this.sent[index]!.id, type: 'loaded', project, outline, ms: 1 });
  }
  crash(): void {
    for (const l of this.listeners.error!) l({ data: undefined });
  }
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
    f.fail('the engine did not start');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.status).toBe('failed');
    expect(store.getState().error).toMatchObject({ kind: 'boot', message: 'the engine did not start' });
    store.getState().projectReady(3, outline, 1);
    f.restartListeners[0]!(1, 9);
    expect(store.getState().engine.restarts).toBe(1);
    expect(store.getState().project.version).toBe(9);
    expect(store.getState().notices.map((n) => n.text)).toEqual(['the engine restarted']);
  });

  it('is busy while a load is unanswered and not once the only one left is answered for files gone since', async () => {
    const store = createSessionStore();
    const f = fakeClient();
    createSession({ store, client: f.client });
    f.readyResolve({ type: 'ready', protocol: 1, engine: { version: '0.1.0', runPlan: 1 }, models: [] });
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles({ 'a.yml': 'on: push' }, { kind: 'sample', name: 'a' });
    store.getState().setFiles({ 'b.yml': 'on: push' }, { kind: 'sample', name: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    f.loads[0]!({ id: 1, type: 'loaded', project: 1, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.busy).toBe(true);
    store.getState().forgetSource();
    f.loads[1]!({ id: 2, type: 'loaded', project: 2, outline, ms: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ project: { status: 'idle' }, engine: { busy: false } });
    expect(f.simulates).toHaveLength(0);
    store.getState().setFiles({ 'a.yml': 'on: push' }, { kind: 'sample', name: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.busy).toBe(true);
    // A folder from the last visit that needs a click before it can be read again: no files until then.
    store.setState({
      source: { kind: 'folder', name: 'repo', readAt: 0 },
      files: { version: store.getState().files.version + 1, byPath: {} },
    });
    f.loads[2]!({ id: 3, type: 'error', kind: 'load', message: 'not yaml' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().engine.busy).toBe(false);
    expect(store.getState().error).toBeUndefined();
  });
});

const files = { '.github/workflows/ci.yml': 'on: push' };

const planReply = (id: number, project: number) => ({
  id,
  type: 'plan',
  project,
  plan: { workflows: [] },
  derived: {},
  text: 'plan',
  ms: { simulate: 1, derive: 0 },
});

describe('the session over the real client', () => {
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

  /** A session whose engine is up, with `files` loaded as project 1 and the first simulate in flight. */
  const started = async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles(files, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    workers[0]!.loaded(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0]!.sent.map((m) => m.type)).toEqual(['load', 'simulate']);
    return store;
  };

  it('keeps the blocking boot error when the files came before the engine failed to start', async () => {
    const store = createSessionStore();
    store.getState().setFiles(files, { kind: 'sample', name: 'x' });
    createSession({ store, client: createEngineClient({ spawn }) });
    store.getState().setFiles({ ...files, 'b.yml': 'on: push' }, { kind: 'sample', name: 'y' });
    await vi.advanceTimersByTimeAsync(5001);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'boot', message: 'the engine did not start' },
    });
    expect(isBlocking(store.getState().error)).toBe(true);
    expect(reportable(store.getState().error!)).toBe(false);
    store.getState().forgetSource();
    expect(store.getState().error).toMatchObject({ kind: 'boot' });
  });

  it('keeps the blocking boot error when the files come after the engine failed to start', async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.crash();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles(files, { kind: 'sample', name: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'boot', message: 'the engine failed to load' },
    });
  });

  it('marks the engine failed when the worker that replaces a stalled one never starts', async () => {
    const store = await started();
    await vi.advanceTimersByTimeAsync(3001);
    expect(workers).toHaveLength(2);
    workers[1]!.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'stopped', message: 'the engine failed to load' },
    });
    expect(isBlocking(store.getState().error)).toBe(true);
    expect(reportable(store.getState().error!)).toBe(true);
    store.getState().patchScenario({ branch: 'dev' });
    await vi.advanceTimersByTimeAsync(100);
    expect(store.getState().error).toMatchObject({ kind: 'stopped' });
  });

  it('marks the engine failed when it stalls once more than the restarts allow', async () => {
    const store = await started();
    for (const round of [1, 2]) {
      await vi.advanceTimersByTimeAsync(3001);
      workers[round]!.ready();
      await vi.advanceTimersByTimeAsync(0);
      workers[round]!.loaded(0, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(workers[round]!.sent.map((m) => m.type)).toEqual(['load', 'simulate']);
    }
    await vi.advanceTimersByTimeAsync(3001);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'stopped', message: 'the engine stopped responding' },
    });
    store.getState().setFiles({ 'b.yml': 'on: push' }, { kind: 'sample', name: 'y' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({
      engine: { status: 'failed', busy: false },
      error: { kind: 'stopped', message: 'the engine stopped responding' },
    });
  });

  it('ends ready for the newest files when a restart catches one load in flight and one waiting', async () => {
    const store = createSessionStore();
    createSession({ store, client: createEngineClient({ spawn }) });
    workers[0]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    store.getState().setFiles({ 'a.yml': 'on: push' }, { kind: 'sample', name: 'a' });
    store.getState().setFiles(files, { kind: 'sample', name: 'b' });
    await vi.advanceTimersByTimeAsync(3001);
    workers[1]!.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[1]!.sent).toMatchObject([{ type: 'load', files }]);
    workers[1]!.loaded(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().project).toMatchObject({
      status: 'ready',
      version: 1,
      files: store.getState().files.version,
    });
    expect(workers[1]!.sent.map((m) => [m.type, m.project])).toEqual([
      ['load', undefined],
      ['simulate', 1],
    ]);
    workers[1]!.reply(planReply(workers[1]!.sent[1]!.id, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().plan?.for).toEqual({ files: store.getState().files.version, project: 1 });
    expect(store.getState().engine.busy).toBe(false);
  });
});
