import { debounce, type Timers } from '../lib/debounce';

/**
 * Writes that follow the edits into IndexedDB (the paste buffers, `state/buffers.ts`; the crash snapshot,
 * `state/snapshot-keeper.ts`): `delayMs` after the last call, at least every `maxWaitMs` while calls keep coming, so
 * a crash loses little, and at once when the page is hidden or left. Each write reads the store when it starts, so
 * it writes the newest edits.
 */
export interface Behind {
  /** Asks for a write: it runs once the edits pause. */
  call(): void;
  /** Drops the write asked for and not yet run. */
  cancel(): void;
  /** Runs `write` now; it lands after the writes started before it. */
  run(write: () => Promise<void>): Promise<void>;
  /** A write is asked for or under way: leaving the page now could lose the last edits. */
  pending(): boolean;
  /** Runs the write asked for now; resolves once every write has finished. */
  flush(): Promise<void>;
  dispose(): void;
}

export interface BehindOptions {
  timers?: Timers;
  delayMs?: number;
  maxWaitMs?: number;
  /** Where `visibilitychange` and `pagehide` come from; none in tests that do not need them. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> & {
    document: Pick<Document, 'visibilityState'>;
  };
}

/** `write` returns nothing when there is nothing to write by the time it runs. */
export function behind(
  write: () => Promise<void> | undefined,
  { timers, delayMs = 500, maxWaitMs = 2000, win }: BehindOptions = {},
): Behind {
  let writing = 0;
  let last: Promise<void> = Promise.resolve();
  /** When the write waiting now was first asked for. */
  let since = 0;

  /**
   * Starts at once, so a write asked for in `pagehide` begins before the page goes. Writes still land in the order
   * they start: each IndexedDB transaction on the store begins in the order it was created.
   */
  const run = (next: () => Promise<void> | undefined): Promise<void> => {
    writing++;
    last = Promise.resolve(next()).finally(() => {
      writing--;
    });
    return last;
  };
  const waiting = debounce(() => void run(write), delayMs, timers);

  const flush = (): Promise<void> => {
    waiting.flush();
    return last;
  };
  const onHidden = (): void => {
    if (win?.document.visibilityState === 'hidden') void flush();
  };
  const onPageHide = (): void => void flush();
  win?.addEventListener('visibilitychange', onHidden);
  win?.addEventListener('pagehide', onPageHide);

  return {
    call: () => {
      if (!waiting.pending()) since = Date.now();
      waiting.call();
      if (Date.now() - since >= maxWaitMs) waiting.flush();
    },
    cancel: () => waiting.cancel(),
    run,
    pending: () => waiting.pending() || writing > 0,
    flush,
    dispose: () => {
      waiting.cancel();
      win?.removeEventListener('visibilitychange', onHidden);
      win?.removeEventListener('pagehide', onPageHide);
    },
  };
}
