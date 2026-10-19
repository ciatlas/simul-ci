import ELK from 'elkjs/lib/elk.bundled.js';
import { answerLayout, isLayoutRequest } from './layout-protocol';

/**
 * The layout worker: ELK off the page's thread and off the engine's queue. It answers each `layout` request with
 * layout-protocol.ts; nothing else is here but the wiring.
 */

/**
 * ELK loads its engine on the first `new ELK()`. Where `self` exists and `document` does not, the engine takes itself
 * for ELK's own worker script: it claims `onmessage`, exports nothing, and the constructor throws. For that one call
 * the worker looks like a page, so the engine exports itself and runs in this thread.
 */
function createElk(): InstanceType<typeof ELK> {
  const scope = globalThis as unknown as { document?: unknown };
  scope.document = {};
  try {
    return new ELK();
  } finally {
    delete scope.document;
  }
}

const elk = createElk();

addEventListener('message', (event: MessageEvent<unknown>) => {
  // A dedicated worker only hears from the page that created it: the event carries no origin and no source.
  if (event.origin !== '' || event.source !== null) return;
  if (!isLayoutRequest(event.data)) return;
  void answerLayout(elk, event.data).then((response) => postMessage(response));
});
