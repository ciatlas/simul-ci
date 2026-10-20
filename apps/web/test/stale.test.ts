import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStaleClock } from '../src/app/stale';
import type { PlanState } from '../src/state/store';
import { createSessionStore } from '../src/state/store';

const CI = '.github/workflows/ci.yml';

/** A store showing a plan of `ci.yml`, with the stale clock installed. */
function showing() {
  const store = createSessionStore();
  store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'sample', name: 'x' });
  store.getState().projectReady(1, { files: [], workflows: [], events: {} }, 1);
  const { version, epoch } = store.getState().files;
  store.getState().planReceived({ for: { files: version, epoch, project: 1 } } as PlanState);
  installStaleClock({ store });
  return store;
}

const key = (store: ReturnType<typeof createSessionStore>): void => {
  const { length } = store.getState().files.byPath[CI]!;
  store.getState().typed(CI, [{ from: length, to: length, insert: '#' }]);
};

const answer = (store: ReturnType<typeof createSessionStore>): void => {
  const { version, epoch } = store.getState().files;
  store.getState().planReceived({ for: { files: version, epoch, project: 2 } } as PlanState);
};

describe('the stale clock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says nothing while typing is answered within 300 ms of the last key, however long the burst', () => {
    const store = showing();
    for (let i = 0; i < 10; i++) {
      key(store);
      vi.advanceTimersByTime(100);
      expect(store.getState().staleShown).toBe(false);
    }
    vi.advanceTimersByTime(150);
    answer(store);
    vi.advanceTimersByTime(1000);
    expect(store.getState().staleShown).toBe(false);
  });

  it('says a plan is on its way once it has taken 300 ms since the last key', () => {
    const store = showing();
    key(store);
    vi.advanceTimersByTime(299);
    expect(store.getState().staleShown).toBe(false);
    vi.advanceTimersByTime(1);
    expect(store.getState().staleShown).toBe('edit');
    answer(store);
    expect(store.getState().staleShown).toBe(false);
  });

  it('shows the last good plan, with nothing running, when no plan is coming: held, or an input refused', () => {
    const store = showing();
    key(store);
    store.getState().projectHeld({
      files: store.getState().files.version,
      outline: { files: [], workflows: [], events: {} },
      broken: [],
    });
    vi.advanceTimersByTime(300);
    expect(store.getState().staleShown).toBe('inputs');

    const refused = showing();
    refused.getState().patchScenario({ sha: 'nope' });
    refused.getState().rejected({ kind: 'scenario', message: 'not a sha' });
    expect(refused.getState().staleShown).toBe('inputs');
    key(refused);
    vi.advanceTimersByTime(300);
    expect(refused.getState().staleShown).toBe('inputs');
  });

  it('never takes back a stale mark for a later cause before a plan comes', () => {
    const store = showing();
    store.getState().patchScenario({ branch: 'dev' });
    expect(store.getState().staleShown).toBe('inputs');
    key(store);
    expect(store.getState().staleShown).toBe('edit');
    key(store);
    expect(store.getState().staleShown).toBe('edit');
  });
});
