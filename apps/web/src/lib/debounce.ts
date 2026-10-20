export interface Debounced<A extends unknown[]> {
  /** Runs `fn` with these arguments once `ms` have passed without another call. */
  call(...args: A): void;
  /** Runs a pending call now. */
  flush(): void;
  cancel(): void;
  pending(): boolean;
}

export interface Timers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const browserTimers: Timers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The last call wins after `ms` of quiet; the timers are injectable so tests drive them. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  timers: Timers = browserTimers,
): Debounced<A> {
  let handle: unknown;
  let last: A | undefined;
  const cancel = (): void => {
    if (handle !== undefined) timers.clearTimer(handle);
    handle = undefined;
    last = undefined;
  };
  const flush = (): void => {
    if (last === undefined) return;
    const args = last;
    cancel();
    fn(...args);
  };
  return {
    call: (...args) => {
      if (handle !== undefined) timers.clearTimer(handle);
      last = args;
      handle = timers.setTimer(flush, ms);
    },
    flush,
    cancel,
    pending: () => last !== undefined,
  };
}

export interface Scheduled {
  /**
   * Runs `fn` after `ms` of quiet, or in a microtask for 0, so the edits of one tick run it once. A call replaces a
   * pending timer, and nothing replaces a pending microtask: it runs this tick, with whatever is newest by then.
   */
  schedule(ms: number): void;
  cancel(): void;
  pending(): boolean;
}

/** `fn` at the delay each call names: the session's edit cadence (synthesis § 7.1). */
export function scheduler(fn: () => void, timers: Timers = browserTimers): Scheduled {
  let handle: unknown;
  let soon = false;
  const clear = (): void => {
    if (handle !== undefined) timers.clearTimer(handle);
    handle = undefined;
  };
  const fire = (): void => {
    clear();
    soon = false;
    fn();
  };
  return {
    schedule: (ms) => {
      if (soon) return;
      clear();
      if (ms > 0) {
        handle = timers.setTimer(fire, ms);
        return;
      }
      soon = true;
      queueMicrotask(() => {
        if (soon) fire();
      });
    },
    cancel: () => {
      clear();
      soon = false;
    },
    pending: () => soon || handle !== undefined,
  };
}
