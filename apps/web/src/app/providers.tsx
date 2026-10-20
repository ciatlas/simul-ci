import { createContext, type ReactNode, useCallback, useContext, useSyncExternalStore } from 'react';
import type { SessionActions, SessionState } from '../state/store';
import type { App } from './boot';

const AppContext = createContext<App | null>(null);

export function AppProvider({ app, children }: { app: App; children: ReactNode }) {
  return <AppContext.Provider value={app}>{children}</AppContext.Provider>;
}

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp outside AppProvider');
  return app;
}

/**
 * A slice of the store; the component re-renders when the slice changes. It is zustand's `useStore`, written with
 * React's own subscription: with zustand's React binding shared by the page, the YAML pane and the edit runtime,
 * rolldown 1.2.14 moves that binding and React out of the page into a chunk of their own, which the bundle check
 * refuses (`scripts/test/check-web-bundle.test.ts` builds the app and asserts its chunks).
 */
export function useSession<T>(selector: (s: SessionState & SessionActions) => T): T {
  const { store } = useApp();
  const slice = useCallback(() => selector(store.getState()), [store, selector]);
  return useSyncExternalStore(store.subscribe, slice, slice);
}
