import { describe, expect, it } from 'vitest';
import { createSaver, targetsOf } from '../src/app/saver';
import { readFolder } from '../src/input/folder';
import { type Choice, type Choices, diskStamp, type DiskConflict, saveTo } from '../src/input/save';
import { memoryStore } from '../src/lib/idb';
import { snapshotStore } from '../src/state/snapshot';
import { createSnapshotKeeper } from '../src/state/snapshot-keeper';
import { createSessionStore, dirtyPaths, type SessionStore, type Settling } from '../src/state/store';
import { type FakeOptions, fakeFolder, withBom } from './fake-folder';

/**
 * Saving to the folder (synthesis § 5.3, § 5.4) over a fake directory with Chromium's write semantics: one test per
 * failure mode of § 9.4 that A7 guards (rows 1, 2, 3, 8, 19 and 20), and the choices of a conflict.
 */

const CI = '.github/workflows/ci.yml';
const DEPLOY = '.github/workflows/deploy.yml';
const LINT = '.github/workflows/lint.yml';
const TEST = '.github/simulci/tests/ci.test.yml';

/** The folder opened as the page opens it, with a saver over the store. */
async function opened(tree: Record<string, string | Uint8Array<ArrayBuffer>>, options: FakeOptions = {}) {
  const fake = fakeFolder(tree, options);
  const store = createSessionStore();
  const read = await readFolder(fake.handle);
  store
    .getState()
    .setFiles(read.files, { kind: 'folder', name: 'repo', handle: fake.handle, readAt: 0 }, read.meta);
  const saver = createSaver({ store, now: () => 0 });
  return { fake, store, saver, s: () => store.getState() };
}

/** Inserts text at the start of a file, as one undoable entry. */
function edit(store: SessionStore, path: string, insert = '# edited\n'): void {
  expect(
    store
      .getState()
      .transact({ label: 'Op', origin: 'op', files: [{ path, edits: [{ from: 0, to: 0, insert }] }] }).ok,
  ).toBe(true);
}

function create(store: SessionStore, path: string, text: string): void {
  const files = [{ path, edits: [{ from: 0, to: 0, insert: text }], create: true as const }];
  expect(store.getState().transact({ label: 'Create', origin: 'op', files }).ok).toBe(true);
}

/** The conflicts the saver asks about, once it asks. */
const asked = (store: SessionStore): Promise<Settling> =>
  new Promise((resolve) => {
    const now = store.getState().settling;
    if (now) return resolve(now);
    const stop = store.subscribe((s) => {
      if (!s.settling) return;
      stop();
      resolve(s.settling);
    });
  });

/** The author's answer: one choice per conflict, made against the folder's file as it was asked about. */
const choose = (conflicts: DiskConflict[], pick: Record<string, Choice>): Choices =>
  Object.fromEntries(conflicts.map((c) => [c.path, { choice: pick[c.path]!, stamp: diskStamp(c.disk) }]));

const report = (store: SessionStore) => store.getState().saving;

describe('saving to the folder', () => {
  it('asks for write access first, in the gesture, and with access refused writes nothing and keeps the edits (row 19)', async () => {
    const { fake, store, saver, s } = await opened({ [CI]: 'on: push\n' }, { permission: 'denied' });
    edit(store, CI);
    const saving = saver.save();
    // Asked before anything was awaited: the click's activation is transient.
    expect(fake.calls).toEqual(['requestPermission']);
    expect(s().saving).toEqual({ status: 'running', folder: 'repo' });
    expect(await saving).toBe(false);
    expect(fake.calls).toEqual(['requestPermission']);
    expect(fake.text(CI)).toBe('on: push\n');
    expect(dirtyPaths(s().files)).toEqual([CI]);
    expect(report(store)).toEqual({
      status: 'done',
      folder: 'repo',
      at: 0,
      denied: true,
      files: [],
      sentence: 'Saving to repo was not allowed: nothing was written',
      open: true,
    });
  });

  it('takes a request the browser refuses outside a gesture as refused', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'on: push\n' }, { permission: 'throws' });
    edit(store, CI);
    expect(await saver.save()).toBe(false);
    expect(fake.written).toEqual([]);
    expect(report(store)).toMatchObject({ denied: true, open: true });
  });

  it('writes nothing, and asks for nothing, when no file has an unsaved edit (row 20)', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'on: push\n', [DEPLOY]: 'on: push\n' });
    expect(await saver.save()).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(report(store)).toMatchObject({
      status: 'done',
      files: [],
      sentence: 'Nothing to save',
      open: false,
    });
    // Undoing back to the base leaves nothing to write either.
    edit(store, CI);
    store.getState().undo();
    expect(await saver.save()).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it('writes only the edited files, moves their base, and says so', async () => {
    const { fake, store, saver, s } = await opened({ [CI]: 'on: push\n', [DEPLOY]: 'on: push\n' });
    edit(store, CI);
    expect(await saver.save()).toBe(true);
    expect(fake.written).toEqual([CI]);
    expect(fake.text(CI)).toBe('# edited\non: push\n');
    expect(s().files.base[CI]).toBe('# edited\non: push\n');
    expect(s().files.opened[CI]).toBe('on: push\n');
    expect(dirtyPaths(s().files)).toEqual([]);
    expect(report(store)).toMatchObject({
      files: [{ path: CI, status: 'saved' }],
      sentence: 'Saved ci.yml',
      open: false,
    });
    // The history is untouched: undo after a save makes the file unsaved again.
    expect(s().undo()).toBe(true);
    expect(dirtyPaths(s().files)).toEqual([CI]);
  });

  it('keeps a BOM and CRLF line endings as read (row 8)', async () => {
    const { fake, store, saver } = await opened({
      [CI]: withBom('on: push\r\njobs: {}\r\n'),
      [DEPLOY]: 'on: push\r\n',
    });
    edit(store, CI, 'name: CI\r\n');
    edit(store, DEPLOY, 'name: Deploy\r\n');
    expect(await saver.save()).toBe(true);
    expect(Array.from(fake.files.get(CI)!.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(fake.text(CI)).toBe('﻿name: CI\r\non: push\r\njobs: {}\r\n');
    expect(fake.text(DEPLOY)).toBe('name: Deploy\r\non: push\r\n');
  });

  it('writes nothing over a file that changed on disk, and nothing else either, until the author chooses (row 1)', async () => {
    const { fake, store, saver, s } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n' });
    edit(store, CI);
    edit(store, DEPLOY);
    fake.set(CI, 'changed elsewhere\n');
    const saving = saver.save();
    const { mode, folder, conflicts } = await asked(store);
    expect({ mode, folder }).toEqual({ mode: 'save', folder: 'repo' });
    expect(conflicts).toEqual([
      {
        path: CI,
        reason: 'changed-on-disk',
        mine: '# edited\na\n',
        base: 'a\n',
        disk: { text: 'changed elsewhere\n', meta: { bom: false, eol: 'lf', utf8: true } },
      },
    ]);
    expect(fake.written).toEqual([]);
    saver.answer(undefined);
    expect(await saving).toBe(false);
    expect(fake.written).toEqual([]);
    expect(fake.text(CI)).toBe('changed elsewhere\n');
    expect(dirtyPaths(s().files).sort()).toEqual([CI, DEPLOY]);
    expect(s().settling).toBeUndefined();
    expect(report(store)).toMatchObject({
      sentence: 'Save cancelled: nothing was written to repo',
      open: false,
    });
  });

  it('writes mine over the disk, keeps the disk version as one undoable entry, or skips, as the author chose', async () => {
    const { fake, store, saver, s } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n', [LINT]: 'c\n' });
    for (const path of [CI, DEPLOY, LINT]) {
      edit(store, path);
      fake.set(path, `disk ${path}\n`);
    }
    const saving = saver.save();
    const { conflicts } = await asked(store);
    expect(conflicts.map((c) => c.path)).toEqual([CI, DEPLOY, LINT]);
    saver.answer(choose(conflicts, { [CI]: 'mine', [DEPLOY]: 'disk', [LINT]: 'skip' }));
    expect(await saving).toBe(false);
    expect(fake.written).toEqual([CI]);
    expect(fake.text(CI)).toBe('# edited\na\n');
    expect(fake.text(LINT)).toBe(`disk ${LINT}\n`);
    expect(s().files.byPath[DEPLOY]).toBe(`disk ${DEPLOY}\n`);
    expect(s().files.base[DEPLOY]).toBe(`disk ${DEPLOY}\n`);
    expect(dirtyPaths(s().files)).toEqual([LINT]);
    expect(report(store)).toMatchObject({ sentence: 'Saved ci.yml; skipped: lint.yml', open: true });
    // Keep the disk version is one undo away from the author's text, which is then unsaved against the disk.
    expect(s().undo()).toBe(true);
    expect(s().files.byPath[DEPLOY]).toBe('# edited\nb\n');
    expect(dirtyPaths(s().files).sort()).toEqual([DEPLOY, LINT]);
    expect(s().edit.lastOrigin).toBe('undo');
    expect(s().edit.future.at(-1)).toMatchObject({
      origin: 'disk',
      label: 'Kept the disk version of deploy.yml',
    });
  });

  it('asks again about a file that changed again while the author chose', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'a\n' });
    edit(store, CI);
    fake.set(CI, 'first\n');
    const saving = saver.save();
    const first = await asked(store);
    fake.set(CI, 'second\n');
    saver.answer(choose(first.conflicts, { [CI]: 'mine' }));
    const second = await asked(store);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.conflicts[0]?.disk?.text).toBe('second\n');
    expect(fake.written).toEqual([]);
    saver.answer(choose(second.conflicts, { [CI]: 'mine' }));
    expect(await saving).toBe(true);
    expect(fake.text(CI)).toBe('# edited\na\n');
  });

  it('says a file deleted on disk is a conflict, and writes it again on Overwrite with mine', async () => {
    const { fake, store, saver, s } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n' });
    edit(store, CI);
    edit(store, DEPLOY);
    fake.remove(CI);
    fake.remove(DEPLOY);
    const saving = saver.save();
    const { conflicts } = await asked(store);
    expect(conflicts).toEqual([
      { path: CI, reason: 'deleted-on-disk', mine: '# edited\na\n', base: 'a\n' },
      { path: DEPLOY, reason: 'deleted-on-disk', mine: '# edited\nb\n', base: 'b\n' },
    ]);
    saver.answer(choose(conflicts, { [CI]: 'mine', [DEPLOY]: 'disk' }));
    expect(await saving).toBe(true);
    expect(fake.text(CI)).toBe('# edited\na\n');
    // Keeping the folder's version of a deleted file removes it here, undoably.
    expect(s().files.byPath[DEPLOY]).toBeUndefined();
    expect(s().files.base[DEPLOY]).toBeUndefined();
    expect(s().undo()).toBe(true);
    expect(s().files.byPath[DEPLOY]).toBe('# edited\nb\n');
    expect(dirtyPaths(s().files)).toEqual([DEPLOY]);
  });

  it('says a file created here that is in the folder now exists, and writes nothing', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'a\n' });
    create(store, TEST, 'cases: []\n');
    fake.set(TEST, 'cases: [theirs]\n');
    const saving = saver.save();
    const { conflicts } = await asked(store);
    expect(conflicts).toEqual([
      {
        path: TEST,
        reason: 'exists',
        mine: 'cases: []\n',
        disk: { text: 'cases: [theirs]\n', meta: { bom: false, eol: 'lf', utf8: true } },
      },
    ]);
    saver.answer(undefined);
    expect(await saving).toBe(false);
    expect(fake.text(TEST)).toBe('cases: [theirs]\n');
  });

  it('stops at the first failure: the files before it saved, it and the ones after unsaved, the report exact (rows 2, 3)', async () => {
    const { fake, store, saver, s } = await opened(
      { [CI]: 'a\n', [DEPLOY]: 'b\n', [LINT]: 'c\n' },
      { fail: [{ op: 'write', path: DEPLOY, error: 'NoModificationAllowedError' }] },
    );
    for (const path of [LINT, CI, DEPLOY]) edit(store, path);
    expect(await saver.save()).toBe(false);
    expect(report(store)).toMatchObject({
      files: [
        { path: CI, status: 'saved' },
        { path: DEPLOY, status: 'failed', error: 'NoModificationAllowedError' },
        { path: LINT, status: 'not-attempted' },
      ],
      sentence:
        'Saved ci.yml; deploy.yml failed (NoModificationAllowedError, is it open elsewhere?); not attempted: lint.yml',
      open: true,
    });
    // The failed write was aborted before close: its swap file went, and the folder's bytes stayed.
    expect(fake.calls).toEqual(['requestPermission', `close ${CI}`, `abort ${DEPLOY}`]);
    expect([fake.text(CI), fake.text(DEPLOY), fake.text(LINT)]).toEqual(['# edited\na\n', 'b\n', 'c\n']);
    expect(dirtyPaths(s().files).sort()).toEqual([DEPLOY, LINT]);
    // Retry runs it all again, the check included, and only the unsaved files are written.
    expect(await saver.save()).toBe(true);
    expect(fake.written).toEqual([CI, DEPLOY, LINT]);
    expect(report(store)).toMatchObject({ sentence: 'Saved deploy.yml and lint.yml', open: false });
  });

  it('keeps the old bytes when the write fails at close', async () => {
    const { fake, store, saver, s } = await opened(
      { [CI]: withBom('a\r\n') },
      { fail: [{ op: 'close', path: CI, error: 'QuotaExceededError' }] },
    );
    edit(store, CI, 'b\r\n');
    expect(await saver.save()).toBe(false);
    expect(fake.text(CI)).toBe('﻿a\r\n');
    expect(s().files.base[CI]).toBe('a\r\n');
    expect(report(store)).toMatchObject({ sentence: 'ci.yml failed (QuotaExceededError, the disk is full)' });
  });

  it('checks every file before it writes any: a file it cannot read stops the save before the first write', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n' });
    fake.fail({ op: 'getFile', path: DEPLOY, error: 'NotReadableError' });
    edit(store, CI);
    edit(store, DEPLOY);
    expect(await saver.save()).toBe(false);
    expect(fake.written).toEqual([]);
    expect(report(store)).toMatchObject({
      files: [
        { path: DEPLOY, status: 'failed', error: 'NotReadableError' },
        { path: CI, status: 'not-attempted' },
      ],
    });
  });

  it('reads every written file back: other bytes leave it unsaved, and the next save sees the change', async () => {
    const { store, saver, s } = await opened(
      { [CI]: 'a\n', [DEPLOY]: 'b\n' },
      { rewrite: { [CI]: 'a\nmangled\n' } },
    );
    edit(store, CI);
    edit(store, DEPLOY);
    expect(await saver.save()).toBe(false);
    expect(report(store)).toMatchObject({
      files: [
        { path: CI, status: 'failed', error: 'VerifyFailed' },
        { path: DEPLOY, status: 'not-attempted' },
      ],
      sentence:
        'ci.yml failed (VerifyFailed, the folder holds other bytes than were written); not attempted: deploy.yml',
    });
    expect(s().files.base[CI]).toBe('a\n');
    expect(dirtyPaths(s().files).sort()).toEqual([CI, DEPLOY]);
    const again = saver.save();
    expect((await asked(store)).conflicts[0]).toMatchObject({ path: CI, reason: 'changed-on-disk' });
    saver.answer(undefined);
    await again;
  });

  it('writes updates first and created files after them, and makes a created file’s directories just before it', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'a\n' });
    create(store, TEST, 'cases: []\n');
    edit(store, CI);
    expect(await saver.save()).toBe(true);
    expect(fake.calls).toEqual([
      'requestPermission',
      `close ${CI}`,
      'mkdir .github/simulci',
      'mkdir .github/simulci/tests',
      `create ${TEST}`,
      `close ${TEST}`,
    ]);
    expect(fake.text(TEST)).toBe('cases: []\n');
  });

  it('leaves no directory behind when a conflict is cancelled', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'a\n' });
    create(store, TEST, 'cases: []\n');
    edit(store, CI);
    fake.set(CI, 'changed\n');
    const saving = saver.save();
    await asked(store);
    saver.answer(undefined);
    await saving;
    expect(fake.dirs.has('.github/simulci')).toBe(false);
    expect(fake.calls).toEqual(['requestPermission']);
  });

  it('takes back the empty file and the directories a failed create made', async () => {
    const { fake, store, saver } = await opened(
      { [CI]: 'a\n' },
      { fail: [{ op: 'write', path: TEST, error: 'NotAllowedError' }] },
    );
    create(store, TEST, 'cases: []\n');
    expect(await saver.save()).toBe(false);
    expect(fake.calls).toEqual([
      'requestPermission',
      'mkdir .github/simulci',
      'mkdir .github/simulci/tests',
      `create ${TEST}`,
      `abort ${TEST}`,
      `remove ${TEST}`,
      'rmdir .github/simulci/tests',
      'rmdir .github/simulci',
    ]);
    expect(fake.dirs.has('.github/simulci')).toBe(false);
  });

  it('moves the base to the text written, so an edit made during the save stays unsaved', async () => {
    let typed = false;
    const { fake, store, saver, s } = await opened(
      { [CI]: 'a\n' },
      {
        before: (call) => {
          if (call === `close ${CI}` && !typed) {
            typed = true;
            edit(store, CI, '# more\n');
          }
        },
      },
    );
    edit(store, CI);
    expect(await saver.save()).toBe(false);
    expect(fake.text(CI)).toBe('# edited\na\n');
    expect(s().files.base[CI]).toBe('# edited\na\n');
    expect(s().files.byPath[CI]).toBe('# more\n# edited\na\n');
    expect(dirtyPaths(s().files)).toEqual([CI]);
  });

  it('moves nothing when the files were replaced while it saved', async () => {
    const { store, saver, s } = await opened(
      { [CI]: 'a\n' },
      {
        before: (call) => {
          if (call === `close ${CI}`)
            store.getState().setFiles({ [CI]: 'other\n' }, { kind: 'sample', name: 'x' });
        },
      },
    );
    edit(store, CI);
    expect(await saver.save()).toBe(false);
    expect(s().files.base[CI]).toBe('other\n');
    // The new files have no save to speak of.
    expect(s().saving).toBeUndefined();
  });

  it('runs one save at a time', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'a\n' });
    edit(store, CI);
    const first = saver.save();
    expect(saver.save()).toBe(first);
    expect(await first).toBe(true);
    expect(fake.calls.filter((c) => c === 'requestPermission')).toHaveLength(1);
  });

  it('never writes a file that is not UTF-8, nor deletes one removed here', async () => {
    const files = { [CI]: 'a\n', [DEPLOY]: 'b\n' };
    const { store } = await opened(files);
    const s = store.getState();
    store.setState({
      files: { ...s.files, meta: { ...s.files.meta, [CI]: { ...s.files.meta[CI]!, utf8: false } } },
    });
    edit(store, CI);
    store
      .getState()
      .transact({ label: 'Rm', origin: 'op', files: [{ path: DEPLOY, edits: [], remove: true }] });
    expect(targetsOf(store.getState().files)).toEqual({ targets: [], removed: [DEPLOY] });
  });
});

describe('the save and the crash snapshot', () => {
  it('drops the saved files from the snapshot, and the snapshot once nothing is unsaved', async () => {
    const { store, saver, fake } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n' });
    const snapshots = snapshotStore(memoryStore());
    const keeper = createSnapshotKeeper({ store, snapshots, now: () => 0 });
    edit(store, CI);
    edit(store, DEPLOY);
    await keeper.flush();
    const source = store.getState().source;
    expect(Object.keys((await snapshots.find(source))!.files).sort()).toEqual([CI, DEPLOY]);
    fake.set(DEPLOY, 'changed\n');
    const saving = saver.save();
    const { conflicts } = await asked(store);
    saver.answer(choose(conflicts, { [DEPLOY]: 'skip' }));
    await saving;
    await keeper.flush();
    expect(Object.keys((await snapshots.find(source))!.files)).toEqual([DEPLOY]);
    const again = saver.save();
    saver.answer(choose((await asked(store)).conflicts, { [DEPLOY]: 'mine' }));
    expect(await again).toBe(true);
    await keeper.flush();
    expect(await snapshots.find(source)).toBeUndefined();
    keeper.dispose();
  });
});

describe('saveTo', () => {
  it('writes project files before tests, and by path within each', async () => {
    const fake = fakeFolder({ [LINT]: 'x\n', [CI]: 'y\n', '.github/simulci/tests/a.test.yml': 'z\n' });
    const run = await saveTo(fake.handle, [
      { path: '.github/simulci/tests/a.test.yml', kind: 'update', text: 'Z\n', base: 'z\n', bom: false },
      { path: LINT, kind: 'update', text: 'X\n', base: 'x\n', bom: false },
      { path: CI, kind: 'update', text: 'Y\n', base: 'y\n', bom: false },
    ]);
    expect(run.kind).toBe('done');
    expect(fake.written).toEqual([CI, LINT, '.github/simulci/tests/a.test.yml']);
  });

  it('takes a folder that already holds the bytes to write as no conflict', async () => {
    const fake = fakeFolder({ [CI]: 'new\n' });
    const run = await saveTo(fake.handle, [
      { path: CI, kind: 'update', text: 'new\n', base: 'old\n', bom: false },
    ]);
    expect(run).toEqual({ kind: 'done', files: [{ path: CI, status: 'saved' }] });
  });

  it('takes a BOM added on disk as a change', async () => {
    const fake = fakeFolder({ [CI]: withBom('a\n') });
    const run = await saveTo(fake.handle, [
      { path: CI, kind: 'update', text: 'b\n', base: 'a\n', bom: false },
    ]);
    expect(run).toMatchObject({ kind: 'conflicts', conflicts: [{ path: CI, reason: 'changed-on-disk' }] });
    expect(fake.written).toEqual([]);
  });
});
