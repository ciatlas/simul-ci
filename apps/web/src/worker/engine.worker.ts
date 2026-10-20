/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
// oxlint-disable-next-line import/no-unassigned-import -- first, so it hears what the CSP refuses below
import './csp';
// oxlint-disable-next-line import/no-unassigned-import -- before the engine's schemas are built
import './jitless';
import { SCHEMA_VERSIONS, SHIPPED_MODELS, VERSION } from '@simulci/engine';
import { eventTable } from './events';
import { handle, initialState } from './handle';
import { type EngineResponse, isEngineRequest, PROTOCOL } from './protocol';

let state = initialState();

addEventListener('message', (event: MessageEvent<unknown>) => {
  // A dedicated worker only hears from the page that created it: the event carries no origin and no source. Anything
  // else, and anything that is not a request, is ignored.
  if (event.origin !== '' || event.source !== null) return;
  if (!isEngineRequest(event.data)) return;
  const result = handle(state, event.data);
  state = result.state;
  postMessage(result.response);
});

const ready: EngineResponse = {
  type: 'ready',
  protocol: PROTOCOL,
  engine: { version: VERSION, runPlan: SCHEMA_VERSIONS.runPlan },
  models: SHIPPED_MODELS.map((m) => ({ id: m.id, version: m.version, presets: [...m.presets] })),
  events: eventTable(),
};
postMessage(ready);
