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
  /** Called after the worker was restarted by the watchdog. */
  onRestart(listener: (restarts: number) => void): void;
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
  let nextId = 1;
  let lastMs = 0;
  let restarts = 0;
  let lastLoad: Body | undefined;
  const inFlight = new Map<Kind, Pending>();
  const waiting = new Map<Kind, Pending>();
  const listeners: ((restarts: number) => void)[] = [];

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
    if (response.type === 'plan') lastMs = response.ms.simulate + response.ms.derive;
    settle(pending, response);
    const next = waiting.get(kind);
    if (next) {
      waiting.delete(kind);
      post(next);
    }
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
    restarts++;
    if (restarts > MAX_RESTARTS) {
      failAll('the engine stopped responding');
      worker.terminate();
      return;
    }
    const replay = [...inFlight.values()].filter((p) => p.body.type !== 'load');
    for (const p of inFlight.values()) if (p.timer !== undefined) clearTimer(p.timer);
    inFlight.clear();
    worker.terminate();
    spawn();
    for (const l of listeners) l(restarts);
    ready.then(
      () => {
        if (lastLoad) post({ body: lastLoad, resolve: () => undefined });
        for (const p of replay) submit(p);
      },
      () => undefined,
    );
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
      worker.terminate();
    },
  };
}

/** The real worker, as the app spawns it. */
export const spawnEngineWorker = (): WorkerLike =>
  new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
