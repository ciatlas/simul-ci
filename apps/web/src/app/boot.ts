import { installEditPrefetch } from '../edit/load';
import { createSession, type Session } from '../engine/session';
import { loadedMetrics } from '../graph/metrics';
import { createGraphSession, type GraphSession } from '../graph/session';
import { createSources, type Sources } from '../input/sources';
import { openKeyValue } from '../lib/idb';
import { type BufferWriter, createBufferWriter } from '../state/buffers';
import { DB_NAME, STORE_NAME, sourceStore } from '../state/persist';
import { snapshotStore } from '../state/snapshot';
import { createSnapshotKeeper, type SnapshotKeeper } from '../state/snapshot-keeper';
import { readPrefs, writePrefs } from '../state/prefs';
import { createSessionStore, initialSessionState, type SessionStore } from '../state/store';
import { createEngineClient, type EngineClient, spawnEngineWorker } from '../worker/client';
import { createLayoutClient, type LayoutClient, spawnLayoutWorker } from '../worker/layout-client';
import { installLeaveGuard } from './leave';
import { createReplacePrompt, type ReplacePrompt } from './replace';
import { installShortcuts } from './shortcuts';
import { installStaleClock } from './stale';
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
  /** Writes edited paste buffers to IndexedDB behind the edits. */
  buffers: BufferWriter;
  /** Keeps a folder's unsaved edits in IndexedDB, and brings them back when the folder opens again. */
  keeper: SnapshotKeeper;
  /** Asks before files with unsaved edits give way to another source. */
  prompt: ReplacePrompt;
}

export function bootApp(): App {
  const prefs = readPrefs();
  const store = createSessionStore(initialSessionState(prefs));
  const client = createEngineClient({ spawn: spawnEngineWorker });
  const session = createSession({ store, client });
  const layout = createLayoutClient({ spawn: spawnLayoutWorker });
  // Cards are measured in their own faces, so the first layout waits for the fonts.
  const graph = createGraphSession({ store, layout, metrics: loadedMetrics() });
  const kv = openKeyValue(DB_NAME, STORE_NAME);
  const persist = sourceStore(kv);
  const prompt = createReplacePrompt(store);
  const sources = createSources({ store, persist, ask: (what, paths) => prompt.ask(what, paths) });
  const buffers = createBufferWriter({ store, persist, win: window });
  // Before the source is restored below, so the edits of the folder it brings back come back with it.
  const keeper = createSnapshotKeeper({ store, snapshots: snapshotStore(kv), win: window });
  installLeaveGuard({
    store,
    pending: () => buffers.pending() || keeper.pending(),
    flush: () => {
      void buffers.flush();
      void keeper.flush();
    },
  });
  applyTheme(prefs.theme);
  store.subscribe((s, prev) => {
    if (s.ui.prefs !== prev.ui.prefs) {
      writePrefs(s.ui.prefs);
      if (s.ui.prefs.theme !== prev.ui.prefs.theme) applyTheme(s.ui.prefs.theme);
    }
  });
  installShortcuts(store);
  installStaleClock({ store });
  installEditPrefetch(store);
  void sources.restore();
  return { store, client, session, layout, graph, sources, buffers, keeper, prompt };
}
