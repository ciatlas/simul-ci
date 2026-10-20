/**
 * When the page fetches the edit runtime (synthesis § 4.1): on entering edit mode at once, and on idle after the first
 * plan of a folder or of pasted files; never for a sample's plan, which most visits only look at.
 */
import { describe, expect, it, vi } from 'vitest';
import { installEditPrefetch } from '../src/edit/load';
import { createSessionStore, type PlanState, type Source } from '../src/state/store';

const CI = '.github/workflows/ci.yml';

function showing(source: Source) {
  const store = createSessionStore();
  const load = vi.fn(() => Promise.resolve());
  const idle: (() => void)[] = [];
  installEditPrefetch(store, { load, idle: (run) => idle.push(run) });
  store.getState().setFiles({ [CI]: 'on: push\n' }, source);
  const plan = () => {
    const { version, epoch } = store.getState().files;
    store.getState().planReceived({ for: { files: version, epoch, project: 1 } } as PlanState);
  };
  return { store, load, idle, plan };
}

describe('the edit runtime’s prefetch', () => {
  it('waits for the browser to be idle after a folder’s first plan, then fetches once', () => {
    const { load, idle, plan } = showing({ kind: 'folder', name: 'repo', readAt: 0 });
    expect(idle).toHaveLength(0);
    plan();
    expect([idle.length, load.mock.calls.length]).toEqual([1, 0]);
    idle[0]!();
    plan();
    expect([idle.length, load.mock.calls.length]).toEqual([1, 1]);
  });

  it('fetches for pasted files too', () => {
    const { load, idle, plan } = showing({ kind: 'paste', buffers: [{ path: CI, text: 'on: push\n' }] });
    plan();
    idle[0]!();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing for a sample’s plan, and at once when the author turns edit mode on', () => {
    const { store, load, idle, plan } = showing({ kind: 'sample', name: 'starter' });
    plan();
    expect([idle.length, load.mock.calls.length]).toEqual([0, 0]);
    store.getState().setEdit(true);
    expect([idle.length, load.mock.calls.length]).toEqual([0, 1]);
    store.getState().setEdit(false);
    store.getState().setEdit(true);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
