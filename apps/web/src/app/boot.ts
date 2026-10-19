import { createSession, type Session } from '../engine/session';
import { createSources, type Sources } from '../input/sources';
import { sourceStore } from '../state/persist';
import { readPrefs, writePrefs } from '../state/prefs';
import { createSessionStore, initialSessionState, type SessionStore } from '../state/store';
import { createEngineClient, type EngineClient, spawnEngineWorker } from '../worker/client';
import { applyTheme } from './theme';

/** Everything the screen needs, made once per page. */
export interface App {
  store: SessionStore;
  client: EngineClient;
  session: Session;
  sources: Sources;
}

export function bootApp(): App {
  const prefs = readPrefs();
  const store = createSessionStore(initialSessionState(prefs));
  const client = createEngineClient({ spawn: spawnEngineWorker });
  const session = createSession({ store, client });
  const sources = createSources({ store, persist: sourceStore() });
  applyTheme(prefs.theme);
  store.subscribe((s, prev) => {
    if (s.ui.prefs !== prev.ui.prefs) {
      writePrefs(s.ui.prefs);
      if (s.ui.prefs.theme !== prev.ui.prefs.theme) applyTheme(s.ui.prefs.theme);
    }
  });
  void sources.restore();
  return { store, client, session, sources };
}
