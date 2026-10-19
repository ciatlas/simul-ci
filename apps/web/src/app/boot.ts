import { createSession, type Session } from '../engine/session';
import { loadedMetrics } from '../graph/metrics';
import { createGraphSession, type GraphSession } from '../graph/session';
import { createSources, type Sources } from '../input/sources';
import { sourceStore } from '../state/persist';
import { readPrefs, writePrefs } from '../state/prefs';
import { createSessionStore, initialSessionState, type SessionStore } from '../state/store';
import { createEngineClient, type EngineClient, spawnEngineWorker } from '../worker/client';
import { createLayoutClient, type LayoutClient, spawnLayoutWorker } from '../worker/layout-client';
import { installShortcuts } from './shortcuts';
import { applyTheme } from './theme';

/** Everything the screen needs, made once per page. */
export interface App {
  store: SessionStore;
  client: EngineClient;
  session: Session;
  /** The layout worker, which places the graph's cards. */
  layout: LayoutClient;
  /** Lays out each new plan and commits it to the store with its positions. */
  graph: GraphSession;
  sources: Sources;
}

export function bootApp(): App {
  const prefs = readPrefs();
  const store = createSessionStore(initialSessionState(prefs));
  const client = createEngineClient({ spawn: spawnEngineWorker });
  const session = createSession({ store, client });
  const layout = createLayoutClient({ spawn: spawnLayoutWorker });
  // Cards are measured in their own faces, so the first layout waits for the fonts.
  const graph = createGraphSession({ store, layout, metrics: loadedMetrics() });
  const sources = createSources({ store, persist: sourceStore() });
  applyTheme(prefs.theme);
  store.subscribe((s, prev) => {
    if (s.ui.prefs !== prev.ui.prefs) {
      writePrefs(s.ui.prefs);
      if (s.ui.prefs.theme !== prev.ui.prefs.theme) applyTheme(s.ui.prefs.theme);
    }
  });
  installShortcuts(store);
  void sources.restore();
  return { store, client, session, layout, graph, sources };
}
