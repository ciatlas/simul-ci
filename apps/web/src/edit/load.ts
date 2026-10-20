import type { SessionState, SessionStore } from '../state/store';

/**
 * The edit runtime (`edit/edit.ts`, the `edit-*` chunk) fetched ahead of need. The browser fetches a module once, so
 * the `React.lazy` views that import it later find it here. A fetch that fails is forgotten, so the next asks again.
 */

let loading: Promise<unknown> | undefined;

function loadEdit(): Promise<unknown> {
  loading ??= import('./edit').catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

/** Runs a callback when the browser is idle, or soon where it cannot say. */
export type Idle = (run: () => void) => void;

const onIdle: Idle = (run) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
};

/**
 * Fetches the runtime before the author needs it (synthesis § 4.1): at once on entering edit mode, and on idle once
 * a plan of a folder or of pasted files is on screen, where editing is likely. A sample's plan fetches nothing: most
 * visits only look. Returns the unsubscribe, which the fetch also calls.
 */
export function installEditPrefetch(
  store: SessionStore,
  { idle = onIdle, load = loadEdit }: { idle?: Idle; load?: () => Promise<unknown> } = {},
): () => void {
  let unsubscribe: () => void = () => undefined;
  const fetch = (when: 'now' | 'idle'): void => {
    unsubscribe();
    const go = (): void => void load().catch(() => undefined);
    if (when === 'now') go();
    else idle(go);
  };
  const check = (s: SessionState): boolean => {
    if (s.edit.on) fetch('now');
    else if (s.plan && (s.source.kind === 'folder' || s.source.kind === 'paste')) fetch('idle');
    else return false;
    return true;
  };
  if (!check(store.getState())) unsubscribe = store.subscribe(check);
  return () => unsubscribe();
}
