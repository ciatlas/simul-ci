/**
 * When the page fetches the dialogs chunk (the Changes and save dialogs, the diff, the patch, Save's and Reload's
 * code): on idle once a file has an unsaved edit, and not before; a store that only plans and pins fetches nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { installDialogsPrefetch } from '../src/app/dialogs-load';
import { createSessionStore } from '../src/state/store';

const CI = '.github/workflows/ci.yml';

function opened() {
  const store = createSessionStore();
  store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'folder', name: 'repo', readAt: 0 });
  const load = vi.fn(() => Promise.resolve());
  const idle: (() => void)[] = [];
  installDialogsPrefetch(store, { load, idle: (run) => idle.push(run) });
  const edit = (insert = '#') =>
    store
      .getState()
      .transact({ label: 'Op', origin: 'op', files: [{ path: CI, edits: [{ from: 0, to: 0, insert }] }] });
  return { store, load, idle, edit };
}

describe('the dialogs chunk’s prefetch', () => {
  it('waits for a file with an unsaved edit, then for the browser to be idle, and fetches once', () => {
    const { store, load, idle, edit } = opened();
    store.getState().setEdit(true);
    expect(idle).toHaveLength(0);
    edit();
    expect([idle.length, load.mock.calls.length]).toEqual([1, 0]);
    idle[0]!();
    edit('##');
    expect([idle.length, load.mock.calls.length]).toEqual([1, 1]);
  });

  it('fetches on idle when the files it starts with already have unsaved edits', () => {
    const { store, edit } = opened();
    edit();
    const load = vi.fn(() => Promise.resolve());
    const idle: (() => void)[] = [];
    installDialogsPrefetch(store, { load, idle: (run) => idle.push(run) });
    expect(idle).toHaveLength(1);
    idle[0]!();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('lets a failed fetch go quietly: the dialog or the save that needs the chunk asks again', async () => {
    const { store, edit } = opened();
    edit();
    const load = vi.fn(() => Promise.reject(new Error('offline')));
    const idle: (() => void)[] = [];
    installDialogsPrefetch(store, { load, idle: (run) => idle.push(run) });
    idle[0]!();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
