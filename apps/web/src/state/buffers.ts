import { type BehindOptions, behind } from './behind';
import type { SourceStore } from './persist';
import type { SessionStore } from './store';

/**
 * Edited paste buffers survive a reload (synthesis § 5.5). `persist.save` runs when a source is accepted; every edit
 * after that rewrites `source.buffers` in the store (`writtenThrough`), and this writes them 500 ms after the last
 * one, and at least every 2 s while the author keeps typing, so a crash loses little; at once when the page is
 * hidden or left. A new source drops a write still waiting: its own was saved when it was accepted, and the old
 * buffers must not land over it.
 */
export interface BufferWriter {
  /** A write is waiting or under way: leaving the page now could lose the last edits. */
  pending(): boolean;
  /** Writes what waits now. */
  flush(): Promise<void>;
  dispose(): void;
}

export interface BufferWriterOptions extends BehindOptions {
  store: SessionStore;
  persist: Pick<SourceStore, 'save'>;
}

export function createBufferWriter({ store, persist, ...options }: BufferWriterOptions): BufferWriter {
  const writer = behind(() => {
    const s = store.getState();
    return s.source.kind === 'paste'
      ? persist.save(s.source, s.files.byPath, s.files.meta, s.files.base)
      : undefined;
  }, options);
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.files.epoch !== prev.files.epoch) writer.cancel();
    else if (s.source !== prev.source && s.source.kind === 'paste') writer.call();
  });
  return {
    pending: () => writer.pending(),
    flush: () => writer.flush(),
    dispose: () => {
      unsubscribe();
      writer.dispose();
    },
  };
}
