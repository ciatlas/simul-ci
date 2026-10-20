import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBufferWriter } from '../src/state/buffers';
import type { SourceStore } from '../src/state/persist';
import { createSessionStore } from '../src/state/store';

const CI = '.github/workflows/ci.yml';

/** A window whose visibility and page events the test fires. */
function fakeWindow() {
  const listeners = new Map<string, () => void>();
  const win = {
    document: { visibilityState: 'visible' as DocumentVisibilityState },
    addEventListener: (type: string, l: () => void) => listeners.set(type, l),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const fire = (type: string, visibility?: DocumentVisibilityState): void => {
    if (visibility) win.document.visibilityState = visibility;
    listeners.get(type)?.();
  };
  return { win: win as never, fire, listeners };
}

function setup() {
  const store = createSessionStore();
  const saved: Parameters<SourceStore['save']>[] = [];
  const persist = {
    save: (...args: Parameters<SourceStore['save']>) => {
      saved.push(args);
      return Promise.resolve();
    },
  };
  const page = fakeWindow();
  const writer = createBufferWriter({ store, persist, win: page.win });
  store
    .getState()
    .setFiles({ [CI]: 'on: push\n' }, { kind: 'paste', buffers: [{ path: CI, text: 'on: push\n' }] });
  return { store, saved, writer, page };
}

describe('the buffer writer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes edited buffers 500 ms after the last edit, and says a write waits until then', async () => {
    const { store, saved, writer } = setup();
    // Accepting a source saves it; the writer leaves that to the source.
    expect(saved).toEqual([]);
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#' }]);
    await vi.advanceTimersByTimeAsync(300);
    store.getState().typed(CI, [{ from: 1, to: 1, insert: '!' }]);
    await vi.advanceTimersByTimeAsync(499);
    expect(writer.pending()).toBe(true);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]![0]).toEqual({ kind: 'paste', buffers: [{ path: CI, text: '#!on: push\n' }] });
    expect(saved[0]![1]).toEqual({ [CI]: '#!on: push\n' });
    expect(writer.pending()).toBe(false);
  });

  it('writes at least every 2 s while the edits keep coming', async () => {
    const { store, saved } = setup();
    for (let i = 0; i < 6; i++) {
      store.getState().typed(CI, [{ from: 0, to: 0, insert: '#' }]);
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]![1][CI]).toBe('######on: push\n');
  });

  it('writes at once when the page is hidden or left', async () => {
    const { store, saved, page } = setup();
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#' }]);
    page.fire('visibilitychange', 'visible');
    expect(saved).toHaveLength(0);
    page.fire('visibilitychange', 'hidden');
    expect(saved).toHaveLength(1);
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#' }]);
    page.fire('pagehide');
    expect(saved).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toHaveLength(2);
  });

  it('drops a waiting write when a new source comes, and writes nothing for a folder', async () => {
    const { store, saved, writer, page } = setup();
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#' }]);
    store.getState().setFiles({ [CI]: 'on: pull_request\n' }, { kind: 'folder', name: 'repo', readAt: 0 });
    expect(writer.pending()).toBe(false);
    store.getState().typed(CI, [{ from: 0, to: 0, insert: '#' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual([]);
    writer.dispose();
    expect(page.listeners.size).toBe(0);
  });
});
