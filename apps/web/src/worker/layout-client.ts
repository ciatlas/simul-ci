import type { Superseded, WorkerLike } from './client';
import type { LayoutRequest, LayoutResponse } from './layout-protocol';

/**
 * The layout worker as promises. One request is in flight and one waits: a newer request replaces the waiting one,
 * which is answered `superseded`, so the worker only ever lays out the latest picture after the one it is on. A reply
 * that is not for the request in flight is dropped. There is no watchdog: a layout takes milliseconds, and a page
 * that never gets one keeps its previous picture. A worker that fails answers this request and every later one with
 * an error.
 */

export type LayoutResult = LayoutResponse | Superseded;

export interface LayoutClient {
  layout(body: Omit<LayoutRequest, 'id' | 'type'>): Promise<LayoutResult>;
  terminate(): void;
}

interface Pending {
  body: Omit<LayoutRequest, 'id' | 'type'>;
  resolve: (result: LayoutResult) => void;
  id?: number;
}

export function createLayoutClient(options: { spawn: () => WorkerLike }): LayoutClient {
  const worker = options.spawn();
  let nextId = 1;
  let inFlight: Pending | undefined;
  let waiting: Pending | undefined;
  let failure: string | undefined;

  const post = (pending: Pending): void => {
    pending.id = nextId++;
    inFlight = pending;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes a transfer list, not an origin
    worker.postMessage({ ...pending.body, id: pending.id, type: 'layout' });
  };

  const failed = (pending: Pending, message: string): void =>
    pending.resolve({ id: pending.id ?? 0, type: 'error', message });

  worker.addEventListener('message', (event) => {
    const response = event.data as LayoutResponse | null;
    if (!inFlight || typeof response !== 'object' || response === null || response.id !== inFlight.id) return;
    const done = inFlight;
    inFlight = undefined;
    done.resolve(response);
    if (waiting) {
      const next = waiting;
      waiting = undefined;
      post(next);
    }
  });

  worker.addEventListener('error', (event) => {
    failure = (event as { message?: string }).message || 'the layout worker failed';
    for (const p of [inFlight, waiting]) if (p) failed(p, failure);
    inFlight = waiting = undefined;
  });

  return {
    layout: (body) =>
      new Promise<LayoutResult>((resolve) => {
        const pending: Pending = { body, resolve };
        if (failure !== undefined) return failed(pending, failure);
        if (!inFlight) return post(pending);
        waiting?.resolve({ type: 'superseded' });
        waiting = pending;
      }),
    terminate: () => {
      for (const p of [inFlight, waiting]) p?.resolve({ type: 'superseded' });
      inFlight = waiting = undefined;
      failure = 'the layout worker was shut down';
      worker.terminate();
    },
  };
}

/** The real worker, as the app spawns it: a chunk of its own, so elkjs stays out of the page. */
export const spawnLayoutWorker = (): WorkerLike =>
  new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
