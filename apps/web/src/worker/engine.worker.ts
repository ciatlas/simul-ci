import { handle } from './handle';
import type { WorkerRequest } from './protocol';

addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  postMessage(handle(event.data));
});
