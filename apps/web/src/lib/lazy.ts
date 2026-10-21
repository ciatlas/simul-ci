/** Runs a callback when the browser is idle, or soon where it cannot say. */
export type Idle = (run: () => void) => void;

export const onIdle: Idle = (run) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
};

/**
 * A lazy chunk's `import()`, made once: the browser fetches a module once, so the `React.lazy` views that import it
 * later find it here. A fetch that fails is forgotten, so the next call asks again.
 */
export function fetchOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));
}
