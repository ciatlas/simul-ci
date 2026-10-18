import { createContext, type ReactNode, useContext } from 'react';
import { useStore } from 'zustand';
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

/** A slice of the store; the component re-renders when the slice changes. */
export function useSession<T>(selector: (s: SessionState & SessionActions) => T): T {
  return useStore(useApp().store, selector);
}
