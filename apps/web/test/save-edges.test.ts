import { describe, expect, it } from 'vitest';
import { saveKey } from '../src/app/shortcuts';
import { createSaver } from '../src/app/saver';
import { readFolder } from '../src/input/folder';
import { type Choice, type Choices, type DiskConflict, saveTo } from '../src/input/save';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { sourceStore } from '../src/state/persist';
import { snapshotStore } from '../src/state/snapshot';
import { createSnapshotKeeper } from '../src/state/snapshot-keeper';
import { createSessionStore, dirtyPaths, type SessionStore, type Settling } from '../src/state/store';
import { type FakeFolder, type FakeOptions, fakeFolder } from './fake-folder';

/**
 * The edges the adversarial review of the save found (synthesis § 9.5), one test each: what the replace prompt's Save
 * may drop, a save that outlives its folder, encodings across undo, a reload racing a save, what a choice is bound to,
 * a text that starts with U+FEFF, directories a failed create made, files removed here, and Mod+S under a dialog.
 */

const W = '.github/workflows';
const CI = `${W}/ci.yml`;
const DEPLOY = `${W}/deploy.yml`;
const TEST = '.github/simulci/tests/ci.test.yml';
const enc = (text: string): number[] => Array.from(new TextEncoder().encode(text));
/** `on: push # café` saved as Latin-1: not UTF-8. */
const LATIN1 = new Uint8Array([...enc('on: push # caf'), 0xe9, 0x0a]);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function opened(tree: Record<string, string | Uint8Array<ArrayBuffer>>, options: FakeOptions = {}) {
  const fake = fakeFolder(tree, options);
  return { fake, ...(await withFolder(fake)) };
}

/** A page on a folder: the store, the saver, sources whose prompt answers Save, and the crash snapshot. */
async function withFolder(fake: FakeFolder, store = createSessionStore()) {
  const saver = createSaver({ store, now: () => 0 });
  const snapshots = snapshotStore(memoryStore());
  const keeper = createSnapshotKeeper({ store, snapshots, delayMs: 0 });
  const sources = createSources({
    store,
    persist: sourceStore(memoryStore()),
    ask: () => Promise.resolve('save'),
    save: () => saver.save(),
    settle: (mode, folder, conflicts) => saver.settle(mode, folder, conflicts),
  });
  await open(store, fake);
  return { store, saver, sources, keeper, snapshots, s: () => store.getState() };
}

async function open(store: SessionStore, fake: FakeFolder, name = 'repo'): Promise<void> {
  const walked = await readFolder(fake.handle);
  store
    .getState()
    .setFiles(walked.files, { kind: 'folder', name, handle: fake.handle, readAt: 0 }, walked.meta);
  await settle();
}

function edit(store: SessionStore, path: string, insert = '# mine\n'): void {
  const files = [{ path, edits: [{ from: 0, to: 0, insert }] }];
  expect(store.getState().transact({ label: 'Op', origin: 'op', files }).ok).toBe(true);
}

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

const choose = (conflicts: DiskConflict[], pick: Record<string, Choice>): Choices =>
  Object.fromEntries(conflicts.map((c) => [c.path, { choice: pick[c.path]!, stamp: c.stamp! }]));

describe('the replace prompt’s Save', () => {
  it('keeps the files when a conflict was settled by keeping the folder’s version, so its undo still has the edit', async () => {
    const { fake, store, saver, sources, s } = await opened({ [CI]: 'a\n' });
    edit(store, CI, '# an hour of work\n');
    fake.set(CI, 'theirs\n');
    sources.useSample('starter');
    const { conflicts, seq } = await asked(store);
    saver.answer(choose(conflicts, { [CI]: 'disk' }), seq);
    await settle();
    await settle();
    expect(s().source.kind).toBe('folder');
    expect(s().files.byPath[CI]).toBe('theirs\n');
    expect(s().undo()).toBe(true);
    expect(s().files.byPath[CI]).toBe('# an hour of work\na\n');
  });

  it('keeps the files when an edit was typed while the save ran', async () => {
    let typed = false;
    const store = createSessionStore();
    const fake = fakeFolder(
      { [CI]: 'a\n', [DEPLOY]: 'b\n' },
      {
        before: (call) => {
          if (call !== `close ${CI}` || typed) return;
          typed = true;
          edit(store, DEPLOY, '# typed during the save\n');
        },
      },
    );
    const { sources, s } = await withFolder(fake, store);
    edit(store, CI);
    sources.useSample('starter');
    await settle();
    await settle();
    expect(s().source.kind).toBe('folder');
    expect(dirtyPaths(s().files)).toEqual([DEPLOY]);
  });
});

describe('a save that outlives its folder', () => {
  it('writes nothing of the next folder’s files into the one it was for', async () => {
    const a = fakeFolder({ [CI]: 'on: push\n' });
    const b = fakeFolder({ [CI]: 'on: push\n' });
    let grant!: (state: PermissionState) => void;
    (a.handle as unknown as { requestPermission: () => Promise<PermissionState> }).requestPermission = () =>
      new Promise((resolve) => {
        grant = resolve;
      });
    const store = createSessionStore();
    const saver = createSaver({ store, now: () => 0 });
    await open(store, a, 'a');
    edit(store, CI, '# in a\n');
    const saving = saver.save();
    await open(store, b, 'b');
    edit(store, CI, '# in b\n');
    // A Save of the new folder is a save of its own, not the one waiting for access.
    const other = saver.save();
    expect(other).not.toBe(saving);
    grant('granted');
    expect(await saving).toBe(false);
    expect(await other).toBe(true);
    expect(a.text(CI)).toBe('on: push\n');
    expect(b.text(CI)).toBe('# in b\non: push\n');
    expect(store.getState().saving).toMatchObject({ folder: 'b', sentence: 'Saved ci.yml' });
  });
});

describe('the encoding across an undo', () => {
  it('never writes the replaced bytes of a file that was not UTF-8, once an undo brings its text back', async () => {
    const { fake, sources, saver, s } = await opened({ [CI]: LATIN1 });
    expect(s().files.meta[CI]?.utf8).toBe(false);
    fake.set(CI, 'on: push # café\n');
    await sources.reload();
    expect(s().files.meta[CI]?.utf8).toBe(true);
    expect(s().undo()).toBe(true);
    expect(s().files.meta[CI]?.utf8).toBe(false);
    expect(await saver.save()).toBe(true);
    expect(fake.text(CI)).toBe('on: push # café\n');
    expect(fake.calls).toEqual([]);
    expect(s().saving).toMatchObject({ sentence: 'not UTF-8, never written: ci.yml', open: false });
    expect(s().redo()).toBe(true);
    expect(s().files.meta[CI]?.utf8).toBe(true);
  });

  it('lets the author save their text again after undoing a take of bytes that are not UTF-8', async () => {
    const { fake, store, sources, saver, s } = await opened({ [CI]: 'on: push\n' });
    fake.set(CI, LATIN1);
    await sources.reload();
    expect(s().files.meta[CI]?.utf8).toBe(false);
    expect(s().undo()).toBe(true);
    expect(s().files.meta[CI]?.utf8).toBe(true);
    const saving = saver.save();
    const { conflicts, seq } = await asked(store);
    expect(conflicts).toMatchObject([{ path: CI, reason: 'changed-on-disk' }]);
    saver.answer(choose(conflicts, { [CI]: 'mine' }), seq);
    expect(await saving).toBe(true);
    expect(fake.text(CI)).toBe('on: push\n');
  });
});

describe('a reload racing a save', () => {
  it('reads the folder again when a save moved the base while it read', async () => {
    const tree: Record<string, string> = { [`${W}/a-ci.yml`]: 'a\n' };
    for (let i = 0; i < 10; i++) tree[`${W}/w${i}.yml`] = `on: push # ${i}\n`;
    let walking = false;
    let saving: Promise<boolean> | undefined;
    const store = createSessionStore();
    const fake = fakeFolder(tree, {
      before: (call) => {
        if (walking && call === `getFile ${W}/w0.yml` && !saving) saving = saver.save();
      },
    });
    const { saver, sources, s } = await withFolder(fake, store);
    edit(store, `${W}/a-ci.yml`);
    walking = true;
    await sources.reload();
    expect(await saving).toBe(true);
    expect(fake.text(`${W}/a-ci.yml`)).toBe('# mine\na\n');
    expect(s().files.byPath[`${W}/a-ci.yml`]).toBe('# mine\na\n');
    expect(s().files.base[`${W}/a-ci.yml`]).toBe('# mine\na\n');
    expect(s().notices.map((n) => n.text)).toEqual(['repo: no changes']);
  });
});

describe('a choice', () => {
  it('holds for the folder’s bytes it was made against, not for a text they decode to', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'a\n' });
    edit(store, CI);
    fake.set(CI, new Uint8Array([...enc('on: '), 0xe9, 0x0a]));
    const saving = saver.save();
    const first = await asked(store);
    fake.set(CI, new Uint8Array([...enc('on: '), 0xe8, 0x0a]));
    saver.answer(choose(first.conflicts, { [CI]: 'mine' }), first.seq);
    const second = await asked(store);
    expect(second.seq).toBeGreaterThan(first.seq);
    saver.answer(undefined, second.seq);
    expect(await saving).toBe(false);
    expect(fake.written).toEqual([]);
  });

  it('holds for those bytes even when their 32-bit hashes collide', async () => {
    const { fake, store, saver } = await opened({ [CI]: 'a\n' });
    edit(store, CI);
    fake.set(CI, 'on: push # 0329599\n');
    const saving = saver.save();
    const first = await asked(store);
    fake.set(CI, 'on: push # 0532382\n');
    saver.answer(choose(first.conflicts, { [CI]: 'mine' }), first.seq);
    const second = await asked(store);
    saver.answer(undefined, second.seq);
    await saving;
    expect(fake.text(CI)).toBe('on: push # 0532382\n');
  });
});

describe('the bytes as written', () => {
  it('takes a text that starts with U+FEFF, written without a BOM, as the bytes it is', async () => {
    const fake = fakeFolder({ [CI]: 'on: push\n' });
    const text = '﻿on: push\n';
    const run = await saveTo(fake.handle, [
      { path: CI, kind: 'update', text, base: 'on: push\n', bom: false },
    ]);
    expect(run).toEqual({ kind: 'done', files: [{ path: CI, status: 'saved' }] });
    // Read again it is a BOM and the text after it: the same file.
    const again = await saveTo(fake.handle, [
      { path: CI, kind: 'update', text: 'x\n', base: text, bom: false },
    ]);
    expect(again).toEqual({ kind: 'done', files: [{ path: CI, status: 'saved' }] });
  });

  it('takes back the directories a create made when making the next one fails', async () => {
    const fake = fakeFolder(
      { [CI]: 'a\n' },
      {
        before: (call, folder) => {
          if (call === 'getDirectoryHandle .github/simulci/tests' && folder.dirs.has('.github/simulci'))
            throw new DOMException('no room', 'QuotaExceededError');
        },
      },
    );
    const run = await saveTo(fake.handle, [{ path: TEST, kind: 'create', text: 'cases: []\n', bom: false }]);
    expect(run).toMatchObject({ files: [{ path: TEST, status: 'failed', error: 'QuotaExceededError' }] });
    expect(fake.dirs.has('.github/simulci')).toBe(false);
  });
});

describe('a file removed here', () => {
  it('is no longer unsaved once the folder has none either, and the save asks for no write access', async () => {
    const { fake, store, saver, sources, s } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n' });
    store
      .getState()
      .transact({ label: 'Rm', origin: 'op', files: [{ path: DEPLOY, edits: [], remove: true }] });
    expect(await saver.save()).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(s().saving).toMatchObject({
      sentence: 'removed here, not from the folder (a save deletes nothing): deploy.yml',
      open: false,
    });
    // It holds no text of the author's, so the replace prompt's Save lets the files go.
    sources.useSample('starter');
    await settle();
    expect(s().source).toEqual({ kind: 'sample', name: 'starter' });
  });

  it('loses its base once the folder lost the file too', async () => {
    const { fake, store, saver, s } = await opened({ [CI]: 'a\n', [DEPLOY]: 'b\n' });
    store
      .getState()
      .transact({ label: 'Rm', origin: 'op', files: [{ path: DEPLOY, edits: [], remove: true }] });
    fake.remove(DEPLOY);
    expect(await saver.save()).toBe(true);
    expect(dirtyPaths(s().files)).toEqual([]);
    expect(s().saving).toMatchObject({ sentence: 'removed here and from the folder: deploy.yml' });
  });
});

describe('the report', () => {
  it('says which files kept the folder’s version', async () => {
    const { fake, store, saver, s } = await opened({ [CI]: 'a\n' });
    edit(store, CI);
    fake.set(CI, 'theirs\n');
    const saving = saver.save();
    const { conflicts, seq } = await asked(store);
    saver.answer(choose(conflicts, { [CI]: 'disk' }), seq);
    expect(await saving).toBe(false);
    expect(s().saving).toMatchObject({ sentence: 'Kept the disk version of ci.yml', open: false });
  });
});

describe('Mod+S', () => {
  it('does nothing more than keep the browser’s Save Page while a dialog is open, wherever the focus is', () => {
    const store = createSessionStore();
    const handle = {} as FileSystemDirectoryHandle;
    store.getState().setFiles({ [CI]: 'a\n' }, { kind: 'folder', name: 'repo', handle, readAt: 0 });
    let saves = 0;
    const dialogs = new Set<string>();
    const doc = {
      querySelector: (q: string) => (dialogs.size > 0 && q.includes('dialog[open]') ? {} : null),
    };
    const body = { closest: () => null, ownerDocument: doc } as unknown as EventTarget;
    const key = {
      key: 's',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      target: body,
    };
    expect(saveKey(key, store.getState(), () => saves++)).toBe(true);
    expect(saves).toBe(1);
    dialogs.add('Reload repo: changed on both sides');
    expect(saveKey(key, store.getState(), () => saves++)).toBe(true);
    expect(saves).toBe(1);
  });
});

describe('the crash snapshot after a save from the replace prompt', () => {
  it('keeps the edit the replacement did not drop', async () => {
    const { fake, store, saver, sources, keeper, snapshots, s } = await opened({ [CI]: 'a\n' });
    edit(store, CI, '# keep me\n');
    fake.set(CI, 'theirs\n');
    sources.useSample('starter');
    const { conflicts, seq } = await asked(store);
    saver.answer(choose(conflicts, { [CI]: 'skip' }), seq);
    await settle();
    await keeper.flush();
    expect(s().source.kind).toBe('folder');
    expect(JSON.stringify(await snapshots.find(s().source))).toContain('# keep me');
  });
});
