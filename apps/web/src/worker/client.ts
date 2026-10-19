import {
  type CaseRequest,
  type CaseResponse,
  type EngineRequest,
  type EngineResponse,
  type ErrorResponse,
  type InvalidResponse,
  type LoadedResponse,
  type LoadRequest,
  type PlanResponse,
  PROTOCOL,
  type ReadyResponse,
  type SimulateRequest,
  SUPPORTED_RUN_PLAN,
} from './protocol';

/**
 * The engine worker as promises. Requests wait for `ready`; per kind at most one is in flight and one waits (a newer
 * waiting request replaces the older one, which is answered `superseded`); a reply that is not for the request in
 * flight is dropped; a request that takes longer than the watchdog allows restarts the worker, replays the last
 * `load` and the request, and after two restarts for the same files gives up with an error.
 */

export type Superseded = { type: 'superseded' };
export type LoadResult = LoadedResponse | ErrorResponse | Superseded;
export type SimulateResult = PlanResponse | InvalidResponse | ErrorResponse | Superseded;
export type CaseResult = CaseResponse | InvalidResponse | ErrorResponse | Superseded;

export interface EngineClient {
  ready: Promise<ReadyResponse>;
  load(body: Omit<LoadRequest, 'id' | 'type'>): Promise<LoadResult>;
  simulate(body: Omit<SimulateRequest, 'id' | 'type'>): Promise<SimulateResult>;
  case(body: Omit<CaseRequest, 'id' | 'type'>): Promise<CaseResult>;
  /** Called after the worker was restarted by the watchdog and the files were loaded again under `project`. */
  onRestart(listener: (restarts: number, project: number | undefined) => void): void;
  restarts(): number;
  terminate(): void;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  terminate(): void;
}

export interface ClientOptions {
  spawn: () => WorkerLike;
  /** Milliseconds `ready` may take before the page is told the engine failed to load. */
  readyTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type Kind = EngineRequest['type'];
type Body = Omit<EngineRequest, 'id'>;

interface Pending {
  body: Body;
  resolve: (response: EngineResponse | Superseded) => void;
  id?: number;
  timer?: unknown;
}

const MIN_WATCHDOG_MS = 3000;
const MAX_RESTARTS = 2;

export function createEngineClient(options: ClientOptions): EngineClient {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let worker: WorkerLike;
  let readyResolve!: (r: ReadyResponse) => void;
  let readyReject!: (e: Error) => void;
  let ready = new Promise<ReadyResponse>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let isReady = false;
  let failure: string | undefined;
  /** Between a restart and the replayed load's answer: waiting requests hold, so none is answered `stale`. */
  let replaying = false;
  let nextId = 1;
  let lastMs = 0;
  let restarts = 0;
  let lastLoad: Body | undefined;
  let lastProject: number | undefined;
  const inFlight = new Map<Kind, Pending>();
  const waiting = new Map<Kind, Pending>();
  const listeners: ((restarts: number, project: number | undefined) => void)[] = [];

  const post = (pending: Pending): void => {
    const id = nextId++;
    pending.id = id;
    pending.timer = setTimer(() => stalled(), Math.max(MIN_WATCHDOG_MS, 20 * lastMs));
    inFlight.set(pending.body.type, pending);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes a transfer list, not an origin
    worker.postMessage({ ...pending.body, id });
    if (pending.body.type === 'load') lastLoad = pending.body;
  };

  const settle = (pending: Pending, response: EngineResponse | Superseded): void => {
    if (pending.timer !== undefined) clearTimer(pending.timer);
    pending.resolve(response);
  };

  const onMessage = (data: unknown): void => {
    if (typeof data !== 'object' || data === null) return;
    const response = data as EngineResponse;
    if (response.type === 'ready') return onReady(response);
    if (!('id' in response)) return;
    const kind: Kind | undefined = [...inFlight.entries()].find(([, p]) => p.id === response.id)?.[0];
    if (kind === undefined) return; // not the request in flight: a stale or replayed answer
    const pending = inFlight.get(kind)!;
    inFlight.delete(kind);
    learn(response);
    settle(pending, response);
    const next = waiting.get(kind);
    if (next) {
      waiting.delete(kind);
      post(next);
    }
  };

  /** What a reply teaches the client: how long a plan takes, which project is loaded, that the engine is well. */
  const learn = (response: EngineResponse): void => {
    if (response.type === 'plan') {
      lastMs = response.ms.simulate + response.ms.derive;
      restarts = 0;
    }
    if (response.type === 'loaded') lastProject = response.project;
  };

  const onReady = (response: ReadyResponse): void => {
    if (response.protocol !== PROTOCOL || response.engine.runPlan !== SUPPORTED_RUN_PLAN) {
      readyReject(
        new Error(
          `the engine speaks protocol ${response.protocol} with RunPlan ${response.engine.runPlan}; this page expects ${PROTOCOL} and ${SUPPORTED_RUN_PLAN}: reload`,
        ),
      );
      return;
    }
    isReady = true;
    readyResolve(response);
    if (!replaying) flushWaiting();
  };

  const flushWaiting = (): void => {
    for (const [kind, pending] of waiting) {
      if (!inFlight.has(kind)) {
        waiting.delete(kind);
        post(pending);
      }
    }
  };

  /** Settles everything queued with an engine error; later requests settle at once until a fresh client is made. */
  const failAll = (message: string): void => {
    failure = message;
    const failed = (id: number): ErrorResponse => ({ id, type: 'error', kind: 'engine', message });
    for (const p of inFlight.values()) {
      if (p.timer !== undefined) clearTimer(p.timer);
      settle(p, failed(p.id ?? 0));
    }
    inFlight.clear();
    for (const p of waiting.values()) settle(p, failed(0));
    waiting.clear();
  };

  const stalled = (): void => {
    if (failure !== undefined) return;
    restarts++;
    if (restarts > MAX_RESTARTS) {
      failAll('the engine stopped responding');
      worker.terminate();
      return;
    }
    // The load to replay: the one in flight (its promise is kept), else the newest waiting, else the last one sent.
    const load =
      inFlight.get('load') ??
      waiting.get('load') ??
      (lastLoad ? { body: lastLoad, resolve: () => undefined } : undefined);
    waiting.delete('load');
    const replay = [...inFlight.values()].filter((p) => p.body.type !== 'load');
    for (const p of inFlight.values()) if (p.timer !== undefined) clearTimer(p.timer);
    inFlight.clear();
    worker.terminate();
    replaying = true;
    spawn();
    ready.then(
      () => replayAfterLoad(load, replay),
      (e: Error) => {
        // The replacement never started: failAll (from spawn) settled the queues; these were held aside.
        const failed = (id: number): ErrorResponse => ({
          id,
          type: 'error',
          kind: 'engine',
          message: e.message,
        });
        if (load) settle(load, failed(load.id ?? 0));
        for (const p of replay) settle(p, failed(p.id ?? 0));
        replaying = false;
      },
    );
  };

  /**
   * The fresh worker numbers projects from 1 again: the load is replayed first, its new project id replaces the old
   * one in the replayed and the waiting requests, and the restart listeners learn it so later requests carry it.
   */
  const replayAfterLoad = (load: Pending | undefined, replay: Pending[]): void => {
    const previous = lastProject;
    const resume = (project: number | undefined): void => {
      const remap = (p: Pending): void => {
        const body = p.body as { type: string; project?: number };
        if (body.type !== 'load' && project !== undefined && body.project === previous)
          body.project = project;
      };
      for (const p of replay) remap(p);
      for (const p of waiting.values()) remap(p);
      replaying = false;
      for (const p of replay) submit(p);
      flushWaiting();
      for (const l of listeners) l(restarts, project);
    };
    if (!load) {
      resume(undefined);
      return;
    }
    const resolve = load.resolve;
    post({
      body: load.body,
      resolve: (response) => {
        resolve(response);
        resume(response.type === 'loaded' ? response.project : undefined);
      },
    });
  };

  const submit = (pending: Pending): void => {
    const kind = pending.body.type;
    if (failure !== undefined) {
      settle(pending, { id: 0, type: 'error', kind: 'engine', message: failure });
      return;
    }
    if (!isReady || inFlight.has(kind)) {
      const older = waiting.get(kind);
      if (older) settle(older, { type: 'superseded' });
      waiting.set(kind, pending);
      return;
    }
    post(pending);
  };

  const spawn = (): void => {
    isReady = false;
    ready = new Promise<ReadyResponse>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    worker = options.spawn();
    worker.addEventListener('message', (event) => onMessage(event.data));
    worker.addEventListener('error', () => readyReject(new Error('the engine failed to load')));
    const timeout = setTimer(() => {
      if (!isReady) readyReject(new Error('the engine did not start'));
    }, options.readyTimeoutMs ?? 5000);
    ready.then(
      () => clearTimer(timeout),
      (e: Error) => {
        clearTimer(timeout);
        failAll(e.message);
      },
    );
  };

  const request = <R>(body: Body): Promise<R> =>
    new Promise<R>((resolve) =>
      submit({ body, resolve: resolve as (r: EngineResponse | Superseded) => void }),
    );

  spawn();
  return {
    get ready() {
      return ready;
    },
    load: (body) => request<LoadResult>({ ...body, type: 'load' }),
    simulate: (body) => request<SimulateResult>({ ...body, type: 'simulate' }),
    case: (body) => request<CaseResult>({ ...body, type: 'case' }),
    onRestart: (listener) => {
      listeners.push(listener);
    },
    restarts: () => restarts,
    terminate: () => {
      for (const p of inFlight.values()) settle(p, { type: 'superseded' });
      for (const p of waiting.values()) settle(p, { type: 'superseded' });
      inFlight.clear();
      waiting.clear();
      failure = 'the engine was shut down';
      worker.terminate();
    },
  };
}

/** The real worker, as the app spawns it. */
export const spawnEngineWorker = (): WorkerLike =>
  new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
