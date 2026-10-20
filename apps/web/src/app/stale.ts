import type { Timers } from '../lib/debounce';
import type { SessionState, SessionStore } from '../state/store';

/** How long the plan of the newest texts may take after the last edit before the screen says it is stale (§ 4.11). */
const EDIT_STALE_MS = 300;

const browserTimers: Timers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * What the screen says of a stale plan (`staleShown`, read by the canvas, the top bar, the status line and the text
 * view): `inputs`, the last good plan, at once for changed inputs, and for edits no plan is coming for (the YAML is
 * held, the worker refused an input, the files did not load); `edit`, a plan on its way, which shows a running line
 * instead. An edit says so only once the plan of the newest texts has taken `EDIT_STALE_MS` since the last edit, so
 * ordinary typing, answered within that, never flickers; once the screen says stale, a later cause never takes it
 * back before a current plan comes. One clock for the page, so a view that mounts late says what the others say.
 */
export function installStaleClock({
  store,
  timers = browserTimers,
}: {
  store: SessionStore;
  timers?: Timers;
}): () => void {
  let timer: unknown;
  const stop = (): void => {
    if (timer !== undefined) timers.clearTimer(timer);
    timer = undefined;
  };
  const show = (shown: SessionState['staleShown']): void => {
    if (store.getState().staleShown !== shown) store.setState({ staleShown: shown });
  };
  const sync = (s: SessionState, prev?: SessionState): void => {
    if (s.stale !== 'edit') {
      stop();
      show(s.stale);
      return;
    }
    if (s.staleShown) {
      show(coming(s) ? 'edit' : 'inputs');
      return;
    }
    // Not shown yet: the quiet runs from the last edit.
    if (timer === undefined || s.files.version !== prev?.files.version) {
      stop();
      timer = timers.setTimer(() => {
        timer = undefined;
        const now = store.getState();
        if (now.stale === 'edit') show(coming(now) ? 'edit' : 'inputs');
      }, EDIT_STALE_MS);
    }
  };
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.stale !== prev.stale || s.files.version !== prev.files.version || s.staleShown) sync(s, prev);
  });
  sync(store.getState());
  return () => {
    unsubscribe();
    stop();
  };
}

/** Whether a plan of the newest texts is on its way: not held off, refused or failed. */
const coming = (s: SessionState): boolean =>
  s.project.held === undefined && s.project.status !== 'error' && s.error === undefined;
