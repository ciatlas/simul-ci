import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../src/lib/idb';
import { stampOf } from '../src/state/history';
import { type EditsSnapshot, restorePlan, snapshotOf, snapshotStore } from '../src/state/snapshot';
import { createSnapshotKeeper } from '../src/state/snapshot-keeper';
import { createSessionStore, type Source } from '../src/state/store';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const TEST = '.github/simulci/tests/ci.test.yml';
const DISK = { [CI]: 'on: push\r\n', [RELEASE]: 'on: release\n' };

/** A folder handle that is the same entry as another made with the same `id`, as handles restored from IndexedDB are. */
function handle(id: string): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: id,
    id,
    isSameEntry: (other: { id?: string }) => Promise.resolve(other.id === id),
  } as unknown as FileSystemDirectoryHandle;
}

const folder = (id = 'repo'): Source => ({ kind: 'folder', name: 'repo', handle: handle(id), readAt: 0 });
const copy: Source = { kind: 'folder', name: 'repo', readAt: 0 };

/** A page: a store and the snapshot keeper over one key-value store, as boot makes them. */
function page(kv = memoryStore()) {
  const store = createSessionStore();
  const snapshots = snapshotStore(kv);
  const keeper = createSnapshotKeeper({ store, snapshots, now: () => Date.UTC(2026, 9, 20, 14, 2) });
  return { store, snapshots, keeper, kv };
}

const type = (store: ReturnType<typeof createSessionStore>, path: string, insert: string, at = 0): void => {
  const outcome = store.getState().typed(path, [{ from: at, to: at, insert }]);
  expect(outcome.ok).toBe(true);
};

describe('the crash snapshot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a folder’s unsaved edits 500 ms after the last one, and brings them back as one undoable entry', async () => {
    const kv = memoryStore();
    const before = page(kv);
    before.store.getState().setFiles(DISK, folder(), { [CI]: { bom: true, eol: 'crlf', utf8: true } });
    await vi.advanceTimersByTimeAsync(0);
    type(before.store, CI, '# a\r\n');
    await vi.advanceTimersByTimeAsync(499);
    expect(await before.snapshots.load()).toBeUndefined();
    expect(before.keeper.pending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const kept = (await before.snapshots.load())!;
    expect(kept).toMatchObject({
      v: 1,
      source: { kind: 'folder', name: 'repo' },
      files: { [CI]: { base: stampOf(DISK[CI]), text: `# a\r\n${DISK[CI]}`, meta: { bom: true } } },
      created: {},
    });
    expect(Object.keys(kept.files)).toEqual([CI]);

    // The tab closes; the next one opens the same folder, whose disk did not change.
    const after = page(kv);
    after.store.getState().setFiles(DISK, folder(), { [CI]: { bom: true, eol: 'crlf', utf8: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(after.store.getState().files.byPath).toEqual({ ...DISK, [CI]: `# a\r\n${DISK[CI]}` });
    expect(after.store.getState().edit.past.map((t) => [t.label, t.origin])).toEqual([
      ['Restored unsaved edits', 'restore'],
    ]);
    expect(after.store.getState().notices.map((n) => n.text)).toEqual([
      expect.stringMatching(/^Restored unsaved edits to 1 file from .+ · undo starts here$/),
    ]);
    after.store.getState().undo();
    expect(after.store.getState().files.byPath).toEqual(DISK);
    // Nothing unsaved: the snapshot goes.
    await vi.advanceTimersByTimeAsync(500);
    expect(await after.snapshots.load()).toBeUndefined();
  });

  it('asks about a file that changed on disk, and leaves the snapshot alone until every one is settled', async () => {
    const kv = memoryStore();
    const before = page(kv);
    before.store.getState().setFiles(DISK, folder());
    type(before.store, CI, '# a\r\n');
    type(before.store, RELEASE, '# b\n');
    await vi.advanceTimersByTimeAsync(500);

    const after = page(kv);
    after.store.getState().setFiles({ ...DISK, [RELEASE]: 'on: [release]\n' }, folder());
    await vi.advanceTimersByTimeAsync(0);
    const s = after.store.getState();
    expect(s.files.byPath[CI]).toBe(`# a\r\n${DISK[CI]}`);
    expect(s.files.byPath[RELEASE]).toBe('on: [release]\n');
    expect(s.edit.restore?.conflicts).toEqual([
      { path: RELEASE, text: `# b\n${DISK[RELEASE]}`, reason: 'changed' },
    ]);
    // Typing waits to be kept until the conflict is settled: the snapshot still holds the release edit.
    type(after.store, CI, '!');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await after.snapshots.load())!.files[RELEASE]).toBeDefined();
    expect((await after.snapshots.load())!.files[CI]!.text).toBe(`# a\r\n${DISK[CI]}`);

    after.store.getState().settleRestore(RELEASE, 'mine');
    expect(after.store.getState().files.byPath[RELEASE]).toBe(`# b\n${DISK[RELEASE]}`);
    expect(after.store.getState().edit.restore).toBeUndefined();
    expect(after.store.getState().edit.past.at(-1)).toMatchObject({
      label: 'Restored unsaved edits to release.yml',
    });
    await vi.advanceTimersByTimeAsync(500);
    expect((await after.snapshots.load())!.files[CI]!.text).toBe(`!# a\r\n${DISK[CI]}`);
    after.store.getState().undo();
    expect(after.store.getState().files.byPath[RELEASE]).toBe('on: [release]\n');
  });

  it('keeps the disk version when asked to, and drops the row', async () => {
    const kv = memoryStore();
    const before = page(kv);
    before.store.getState().setFiles(DISK, folder());
    type(before.store, RELEASE, '# b\n');
    await vi.advanceTimersByTimeAsync(500);
    const after = page(kv);
    after.store.getState().setFiles({ ...DISK, [RELEASE]: 'on: [release]\n' }, folder());
    await vi.advanceTimersByTimeAsync(0);
    after.store.getState().settleRestore(RELEASE, 'disk');
    expect(after.store.getState().files.byPath[RELEASE]).toBe('on: [release]\n');
    expect(after.store.getState().edit).toMatchObject({ past: [], restore: undefined });
    await vi.advanceTimersByTimeAsync(500);
    expect(await after.snapshots.load()).toBeUndefined();
  });

  it('belongs to the folder it was taken of, or to a copy by its name, and to nothing else', async () => {
    const kv = memoryStore();
    const before = page(kv);
    before.store.getState().setFiles(DISK, folder('a'));
    type(before.store, CI, '#');
    await vi.advanceTimersByTimeAsync(500);
    const other = page(kv);
    other.store.getState().setFiles(DISK, folder('b'));
    await vi.advanceTimersByTimeAsync(0);
    expect(other.store.getState().files.byPath).toEqual(DISK);
    const asCopy = page(kv);
    asCopy.store.getState().setFiles(DISK, copy);
    await vi.advanceTimersByTimeAsync(0);
    expect(asCopy.store.getState().files.byPath).toEqual(DISK);

    const kv2 = memoryStore();
    const copied = page(kv2);
    copied.store.getState().setFiles(DISK, copy);
    type(copied.store, CI, '#');
    await vi.advanceTimersByTimeAsync(500);
    expect((await copied.snapshots.load())!.source).toEqual({ kind: 'copy', name: 'repo' });
    const again = page(kv2);
    again.store.getState().setFiles(DISK, copy);
    await vi.advanceTimersByTimeAsync(0);
    expect(again.store.getState().files.byPath[CI]).toBe(`#${DISK[CI]}`);
  });

  it('writes the edits made while a restore loaded once it has, and leaves another folder’s snapshot alone', async () => {
    const kv = memoryStore();
    const before = page(kv);
    before.store.getState().setFiles(DISK, folder('a'));
    type(before.store, CI, '#');
    await vi.advanceTimersByTimeAsync(500);

    // Another folder opens and is not edited: the first folder's snapshot stays.
    const other = page(kv);
    other.store.getState().setFiles(DISK, folder('b'));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await other.snapshots.load())!.source).toMatchObject({ name: 'repo' });
    expect((await other.snapshots.load())!.files[CI]!.text).toBe(`#${DISK[CI]}`);

    // The first folder again, typed into before its restore has loaded: the typing is kept, the restore asks.
    const again = page(kv);
    again.store.getState().setFiles(DISK, folder('a'));
    type(again.store, RELEASE, '!');
    await vi.advanceTimersByTimeAsync(0);
    expect(again.store.getState().files.byPath[CI]).toBe(`#${DISK[CI]}`);
    await vi.advanceTimersByTimeAsync(500);
    expect((await again.snapshots.load())!.files[RELEASE]!.text).toBe(`!${DISK[RELEASE]}`);
  });

  it('keeps nothing for pasted files or a sample, whose buffers carry their edits', async () => {
    const { store, snapshots } = page();
    store.getState().setFiles(DISK, { kind: 'sample', name: 'starter' });
    type(store, CI, '#');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await snapshots.load()).toBeUndefined();
  });

  it('lets a folder’s snapshot go with its edits when the folder is replaced or forgotten', async () => {
    const kv = memoryStore();
    const { store, snapshots } = page(kv);
    store.getState().setFiles(DISK, folder());
    type(store, CI, '#');
    await vi.advanceTimersByTimeAsync(500);
    expect(await snapshots.load()).toBeDefined();
    // The replace prompt asked; the author let the edits go.
    store.getState().setFiles(DISK, folder());
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().files.byPath).toEqual(DISK);
    expect(await snapshots.load()).toBeUndefined();
    type(store, CI, '#');
    await vi.advanceTimersByTimeAsync(500);
    store.getState().forgetSource();
    await vi.advanceTimersByTimeAsync(0);
    expect(await snapshots.load()).toBeUndefined();
  });

  it('writes at once when the page is hidden', async () => {
    const store = createSessionStore();
    const snapshots = snapshotStore(memoryStore());
    const listeners = new Map<string, () => void>();
    const win = {
      document: { visibilityState: 'hidden' as DocumentVisibilityState },
      addEventListener: (t: string, l: () => void) => listeners.set(t, l),
      removeEventListener: () => undefined,
    };
    createSnapshotKeeper({ store, snapshots, win: win as never });
    store.getState().setFiles(DISK, folder());
    await vi.advanceTimersByTimeAsync(0);
    type(store, CI, '#');
    listeners.get('visibilitychange')!();
    await Promise.resolve();
    expect(await snapshots.load()).toBeDefined();
  });

  it('plans a restore per file: clean files come back, created ones where the path is free, the rest conflict', () => {
    const store = createSessionStore();
    store.getState().setFiles({ ...DISK, [TEST]: 'cases: [x]\n' }, folder(), {
      [CI]: { bom: false, eol: 'crlf', utf8: true },
    });
    const snapshot: EditsSnapshot = {
      v: 1,
      source: { kind: 'folder', name: 'repo' },
      files: {
        [CI]: { base: stampOf(DISK[CI]), text: `#${DISK[CI]}`, meta: { bom: true, eol: 'crlf', utf8: true } },
        [RELEASE]: {
          base: stampOf(DISK[RELEASE]),
          text: DISK[RELEASE],
          meta: { bom: false, eol: 'lf', utf8: true },
        },
        'gone.yml': { base: stampOf('x'), text: 'y', meta: { bom: false, eol: 'none', utf8: true } },
      },
      created: { '.github/workflows/new.yml': 'on: push\n', [TEST]: 'cases: []\n' },
      at: 0,
    };
    const plan = restorePlan(snapshot, store.getState().files);
    // The BOM changed on disk: that is a change too.
    expect(plan.conflicts).toEqual([
      { path: CI, text: `#${DISK[CI]}`, reason: 'changed' },
      { path: 'gone.yml', text: 'y', reason: 'gone' },
      { path: TEST, text: 'cases: []\n', reason: 'exists' },
    ]);
    expect(plan.files).toEqual([
      { path: '.github/workflows/new.yml', edits: [{ from: 0, to: 0, insert: 'on: push\n' }], create: true },
    ]);
  });

  it('takes a snapshot of the dirty files only, created ones apart', () => {
    const store = createSessionStore();
    store.getState().setFiles(DISK, copy);
    expect(snapshotOf(store.getState(), 1)).toBeUndefined();
    store.getState().transact({
      label: 'Created',
      origin: 'op',
      files: [{ path: TEST, edits: [{ from: 0, to: 0, insert: 'cases: []\n' }], create: true }],
    });
    expect(snapshotOf(store.getState(), 1)).toEqual({
      v: 1,
      source: { kind: 'copy', name: 'repo' },
      files: {},
      created: { [TEST]: 'cases: []\n' },
      at: 1,
    });
  });

  it('reads nothing that is not a snapshot', async () => {
    const kv = memoryStore();
    await kv.set('edits', { v: 2, source: { kind: 'folder', name: 'x' }, files: {}, created: {}, at: 0 });
    expect(await snapshotStore(kv).load()).toBeUndefined();
    await kv.set('edits', {
      v: 1,
      source: { kind: 'folder', name: 'x' },
      files: { a: { base: 1 } },
      created: {},
      at: 0,
    });
    expect(await snapshotStore(kv).load()).toBeUndefined();
  });
});
