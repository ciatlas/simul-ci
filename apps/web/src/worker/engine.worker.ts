import { handle } from './handle';
import { isWorkerRequest } from './protocol';

addEventListener('message', (event: MessageEvent<unknown>) => {
  // A dedicated worker only hears from the page that created it: the event carries no origin and no source. Anything
  // else, and anything that is not a request, is ignored.
  if (event.origin !== '' || event.source !== null) return;
  if (!isWorkerRequest(event.data)) return;
  postMessage(handle(event.data));
});
