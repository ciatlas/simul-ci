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
