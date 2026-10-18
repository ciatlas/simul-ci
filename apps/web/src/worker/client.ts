import type { SimulateRequest, WorkerRequest, WorkerResponse } from './protocol';

/** The engine worker as a promise per request; a newer request makes an older answer obsolete. */
export interface EngineClient {
  simulate(request: Omit<SimulateRequest, 'id' | 'type'>): Promise<WorkerResponse>;
  /** Whether an answer is the latest one asked for. */
  isCurrent(response: WorkerResponse): boolean;
  terminate(): void;
}

export function createEngineClient(
  worker: Worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' }),
): EngineClient {
  let next = 1;
  const pending = new Map<number, (response: WorkerResponse) => void>();
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    resolve(event.data);
  });
  return {
    simulate(request) {
      const id = next++;
      const message: WorkerRequest = { ...request, id, type: 'simulate' };
      return new Promise((resolve) => {
        pending.set(id, resolve);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage has no target origin
        worker.postMessage(message);
      });
    },
    isCurrent: (response) => response.id === next - 1,
    terminate() {
      worker.terminate();
      pending.clear();
    },
  };
}
