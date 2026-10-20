import { debounce, type Timers } from '../lib/debounce';
import type { SourceStore } from './persist';
import type { SessionStore } from './store';

/**
 * Edited paste buffers survive a reload (synthesis § 5.5). `persist.save` runs when a source is accepted; every edit
 * after that rewrites `source.buffers` in the store (`writtenThrough`), and this writes them 500 ms after the last
 * one, at once when the page is hidden or left. A new source drops a write still waiting: its own was saved when it
 * was accepted, and the old buffers must not land over it.
 */
export interface BufferWriter {
  /** A write is waiting or under way: leaving the page now could lose the last edits. */
  pending(): boolean;
  /** Writes what waits now. */
  flush(): Promise<void>;
  dispose(): void;
}

export interface BufferWriterOptions {
  store: SessionStore;
  persist: Pick<SourceStore, 'save'>;
  timers?: Timers;
  delayMs?: number;
  /** Where `visibilitychange` and `pagehide` come from; none in tests that do not need them. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> & {
    document: Pick<Document, 'visibilityState'>;
  };
}

export function createBufferWriter({
  store,
  persist,
  timers,
  delayMs = 500,
  win,
}: BufferWriterOptions): BufferWriter {
  let writing = 0;
  let last: Promise<void> = Promise.resolve();

  const write = (): void => {
    const s = store.getState();
    if (s.source.kind !== 'paste') return;
    writing++;
    last = persist.save(s.source, s.files.byPath, s.files.meta).finally(() => {
      writing--;
    });
  };
  const waiting = debounce(write, delayMs, timers);

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.files.epoch !== prev.files.epoch) waiting.cancel();
    else if (s.source !== prev.source && s.source.kind === 'paste') waiting.call();
  });

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
    pending: () => waiting.pending() || writing > 0,
    flush,
    dispose: () => {
      unsubscribe();
      waiting.cancel();
      win?.removeEventListener('visibilitychange', onHidden);
      win?.removeEventListener('pagehide', onPageHide);
    },
  };
}
