import { fetchOnce, type Idle, onIdle } from '../lib/lazy';
import { dirtyPaths, type SessionState, type SessionStore } from '../state/store';

/**
 * The dialogs chunk (`app/dialogs.ts`, `dialogs-*`) fetched ahead of need, or when Save, Reload or the replace prompt's
 * patch needs it: what the page calls in it. Its views come by `React.lazy`.
 */
export const loadDialogs = fetchOnce(() =>
  import('./dialogs').then(({ downloadPatch, reloadPlan, runSave, settledReload }) => ({
    downloadPatch,
    reloadPlan,
    runSave,
    settledReload,
  })),
);

export type Dialogs = Awaited<ReturnType<typeof loadDialogs>>;

/**
 * Fetches the chunk on idle once a file has an unsaved edit, so Changes, the save's dialogs and the patch open without
 * a wait. Returns the unsubscribe, which the fetch also calls.
 */
export function installDialogsPrefetch(
  store: SessionStore,
  { idle = onIdle, load = loadDialogs }: { idle?: Idle; load?: () => Promise<unknown> } = {},
): () => void {
  let unsubscribe: () => void = () => undefined;
  const check = (s: SessionState): boolean => {
    if (dirtyPaths(s.files).length === 0) return false;
    unsubscribe();
    idle(() => void load().catch(() => undefined));
    return true;
  };
  if (!check(store.getState()))
    unsubscribe = store.subscribe((s, prev) => {
      if (s.files !== prev.files) check(s);
    });
  return () => unsubscribe();
}
