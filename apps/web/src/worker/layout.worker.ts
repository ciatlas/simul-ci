// oxlint-disable-next-line import/no-unassigned-import -- first, so it hears what the CSP refuses below
import './csp';
import ELK from 'elkjs/lib/elk.bundled.js';
import { answerLayout, isLayoutRequest, WARM_UP } from './layout-protocol';

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

/**
 * ELK's first layouts load its classes and leave V8 to compile its hot paths: cold, a session's first picture took
 * more than twice what the same request takes warm. So the worker lays `WARM_UP` out while the page has nothing to
 * place, a few passes over, and stops once a request comes; the request waits for the warm-up layout on hand, so no
 * throwaway layout runs between a request's own and requests are answered in order. A warm-up that fails answers
 * with an error like any request, which nothing reads.
 */
const WARM_UP_PASSES = 3;
let asked = false;
const warm = (async () => {
  for (let pass = 0; pass < WARM_UP_PASSES; pass++)
    for (const request of WARM_UP) {
      if (asked) return;
      await answerLayout(elk, request);
    }
})();

addEventListener('message', (event: MessageEvent<unknown>) => {
  // A dedicated worker only hears from the page that created it: the event carries no origin and no source.
  if (event.origin !== '' || event.source !== null) return;
  if (!isLayoutRequest(event.data)) return;
  const request = event.data;
  asked = true;
  void warm.then(() => answerLayout(elk, request)).then((response) => postMessage(response));
});
