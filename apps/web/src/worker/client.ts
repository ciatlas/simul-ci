import type { SimulateRequest, WorkerRequest, WorkerResponse } from './protocol';

/** The engine worker as a promise per request; a newer request makes an older answer obsolete. */
export class EngineClient {
  private readonly worker: Worker;
  private next = 1;
  private readonly pending = new Map<number, (response: WorkerResponse) => void>();

  constructor(worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })) {
    this.worker = worker;
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const resolve = this.pending.get(event.data.id);
      if (!resolve) return;
      this.pending.delete(event.data.id);
      resolve(event.data);
    });
  }

  simulate(request: Omit<SimulateRequest, 'id' | 'type'>): Promise<WorkerResponse> {
    const id = this.next++;
    const message: WorkerRequest = { ...request, id, type: 'simulate' };
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage has no target origin
      this.worker.postMessage(message);
    });
  }

  /** Whether an answer is the latest one asked for. */
  isCurrent(response: WorkerResponse): boolean {
    return response.id === this.next - 1;
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
