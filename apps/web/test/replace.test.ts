import { describe, expect, it, vi } from 'vitest';
import { installLeaveGuard } from '../src/app/leave';
import { createReplacePrompt } from '../src/app/replace';
import { type ReplaceChoice, createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { sampleByName } from '../src/input/samples';
import { sourceStore } from '../src/state/persist';
import { createSessionStore, dirtyPaths } from '../src/state/store';
import { fakeFolder } from './fake-folder';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';

/** Sources whose prompt answers `choice` and records what it was asked, and whose downloads are recorded. */
function setup(choice: ReplaceChoice = 'cancel', load?: Parameters<typeof createSources>[0]['load']) {
  const store = createSessionStore();
  const asked: string[] = [];
  const dropping: (readonly string[])[] = [];
  const downloads: [string, string][] = [];
  const kv = memoryStore();
  const persist = sourceStore(kv);
  const sources = createSources({
    store,
    persist,
    ask: (what, paths) => {
      asked.push(what);
      dropping.push(paths);
      return Promise.resolve(choice);
    },
    download: (name, text) => downloads.push([name, text]),
    ...(load && { load }),
  });
  return { store, sources, asked, dropping, downloads, kv, persist };
}

const edit = (store: ReturnType<typeof createSessionStore>, path: string): void => {
  expect(store.getState().typed(path, [{ from: 0, to: 0, insert: '# edited\n' }]).ok).toBe(true);
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the replace prompt', () => {
  it('replaces files with nothing unsaved at once, asking nothing', () => {
    const { store, sources, asked } = setup();
    sources.useSample('starter');
    sources.useSample('monorepo');
    expect(store.getState().source).toEqual({ kind: 'sample', name: 'monorepo' });
    expect(asked).toEqual([]);
  });

  it('keeps everything as it is when the author cancels', async () => {
    const { store, sources, asked } = setup('cancel');
    sources.useSample('starter');
    edit(store, CI);
    const before = store.getState().files;
    sources.useSample('monorepo');
    await settle();
    expect(asked).toEqual(['Opening the monorepo sample']);
    expect(store.getState().files).toBe(before);
    expect(store.getState().source).toMatchObject({
      kind: 'paste',
      name: 'edited copy of the starter sample',
    });
  });

  it('replaces the files when the author lets the edits go, and downloads them first when asked to', async () => {
    const discard = setup('discard');
    discard.sources.useSample('starter');
    edit(discard.store, CI);
    discard.sources.useSample('monorepo');
    await settle();
    expect(discard.store.getState().source).toEqual({ kind: 'sample', name: 'monorepo' });
    expect(discard.downloads).toEqual([]);

    const download = setup('download');
    download.store.getState().setFiles(
      { [CI]: 'on: push\r\n' },
      { kind: 'folder', name: 'repo', readAt: 0 },
      {
        [CI]: { bom: true, eol: 'crlf', utf8: true },
      },
    );
    edit(download.store, CI);
    download.sources.useSample('starter');
    await settle();
    // The file as it would be saved: its BOM back, its CRLF kept.
    expect(download.downloads).toEqual([['ci.yml', '﻿# edited\non: push\r\n']]);
    expect(download.store.getState().source).toEqual({ kind: 'sample', name: 'starter' });
  });

  it('downloads one patch of every edit the replacement drops when asked to', async () => {
    const { store, sources, downloads } = setup('patch');
    store
      .getState()
      .setFiles(
        { [CI]: 'on: push\r\n', [RELEASE]: 'on: release\n' },
        { kind: 'folder', name: 'repo', readAt: 0 },
        { [CI]: { bom: true, eol: 'crlf', utf8: true } },
      );
    edit(store, CI);
    edit(store, RELEASE);
    sources.useSample('starter');
    // The patch is made by the dialogs chunk, fetched on the answer.
    await vi.waitFor(() => expect(downloads.map(([name]) => name)).toEqual(['simulci-changes.patch']));
    const patch = downloads[0]![1];
    expect(patch).toContain(`diff --git a/${CI} b/${CI}\n`);
    // Both sides of the BOM file's first line carry it; its CRLF is kept.
    expect(patch).toContain('-\uFEFFon: push\r\n+\uFEFF# edited\n+on: push\r\n');
    expect(patch).toContain(`diff --git a/${RELEASE} b/${RELEASE}\n`);
    expect(store.getState().source).toEqual({ kind: 'sample', name: 'starter' });
  });

  it('keeps the files when the patch cannot be made, and says so', async () => {
    const { store, sources, downloads } = setup('patch', () => Promise.reject(new Error('offline')));
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'folder', name: 'repo', readAt: 0 });
    edit(store, CI);
    sources.useSample('starter');
    await vi.waitFor(() =>
      expect(store.getState().notices.map((n) => n.text)).toEqual([
        'The patch could not be made, so nothing was replaced: try again',
      ]),
    );
    expect(downloads).toEqual([]);
    expect(store.getState().source).toEqual({ kind: 'folder', name: 'repo', readAt: 0 });
  });

  it('asks only for edits a paste would overwrite: a paste of another file keeps the edited buffers', async () => {
    const { store, sources, asked, dropping } = setup('cancel');
    sources.paste(CI, 'on: push\n');
    sources.paste(RELEASE, 'on: release\n');
    edit(store, CI);
    sources.paste('.github/workflows/third.yml', 'on: pull_request\n');
    await settle();
    expect(asked).toEqual([]);
    // The buffers carry the edit into the new paste, still unsaved against the text as pasted.
    expect(store.getState().files.byPath[CI]).toBe('# edited\non: push\n');
    expect(store.getState().files.base[CI]).toBe('on: push\n');
    expect(dirtyPaths(store.getState().files)).toEqual([CI]);
    edit(store, RELEASE);
    const pasted = sources.paste(RELEASE, 'on: [release]\n');
    expect(pasted).toMatchObject({ ok: true });
    expect(await (pasted.ok && pasted.done)).toBe(false);
    // The prompt names the file the paste drops, not the edited one it leaves standing.
    expect(asked).toEqual([`Pasting ${RELEASE}`]);
    expect(dropping).toEqual([[RELEASE]]);
    expect(store.getState().files.byPath[RELEASE]).toBe('# edited\non: release\n');
  });

  it('keeps edited buffers unsaved across a reload, so replacing them still asks', async () => {
    const before = setup('cancel');
    before.sources.useSample('starter');
    edit(before.store, CI);
    // What the buffer writer writes behind the edits.
    const s = before.store.getState();
    await before.persist.save(s.source, s.files.byPath, s.files.meta, s.files.base);

    const store = createSessionStore();
    const asked: string[] = [];
    const sources = createSources({
      store,
      persist: sourceStore(before.kv),
      ask: (what) => {
        asked.push(what);
        return Promise.resolve('cancel');
      },
    });
    await sources.restore();
    expect(store.getState().source).toMatchObject({ name: 'edited copy of the starter sample' });
    expect(dirtyPaths(store.getState().files)).toEqual([CI]);
    expect(store.getState().files.base[CI]).toBe(sampleByName('starter')!.files[CI]);
    sources.useSample('monorepo');
    await settle();
    expect(asked).toEqual(['Opening the monorepo sample']);
    expect(store.getState().source).toMatchObject({ kind: 'paste' });
  });

  it('asks before Forget; Reload asks nothing, since it keeps the edits of files the disk did not change', async () => {
    const { store, sources, asked } = setup('cancel');
    const files = sampleByName('starter')!.files;
    store.getState().setFiles(files, { kind: 'folder', name: 'repo', readAt: 0 });
    edit(store, CI);
    await sources.forget();
    expect(store.getState().source).toMatchObject({ kind: 'folder', name: 'repo' });
    store.setState({ source: { kind: 'folder', name: 'repo', handle: fakeFolder(files).handle, readAt: 0 } });
    await sources.reload();
    expect(asked).toEqual(['Forgetting repo']);
    expect(store.getState().notices.map((n) => n.text)).toEqual(['repo: no changes']);
    expect(store.getState().files.byPath[CI]).toMatch(/^# edited\n/);
  });

  it('replaces the files after Save only once every edited file is in the folder', async () => {
    const store = createSessionStore();
    let saved = false;
    const sources = createSources({
      store,
      persist: sourceStore(memoryStore()),
      ask: () => Promise.resolve('save'),
      save: () => {
        if (saved) store.getState().saved(store.getState().files.epoch, { ...store.getState().files.byPath });
        return Promise.resolve(saved);
      },
    });
    const handle = fakeFolder({}).handle;
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'folder', name: 'repo', handle, readAt: 0 });
    edit(store, CI);
    sources.useSample('starter');
    await settle();
    expect(store.getState().source).toMatchObject({ kind: 'folder', name: 'repo' });
    saved = true;
    sources.useSample('starter');
    await settle();
    expect(store.getState().source).toEqual({ kind: 'sample', name: 'starter' });
  });

  it('is one question at a time, answered through the store', async () => {
    const store = createSessionStore();
    const prompt = createReplacePrompt(store);
    const first = prompt.ask('Opening the starter sample', [CI]);
    expect(store.getState().replacing).toMatchObject({ what: 'Opening the starter sample', paths: [CI] });
    const second = prompt.ask('Opening the monorepo sample', [CI]);
    expect(await first).toBe('cancel');
    expect(store.getState().replacing).toMatchObject({ what: 'Opening the monorepo sample' });
    prompt.answer('discard');
    expect(await second).toBe('discard');
    expect(store.getState().replacing).toBeUndefined();
  });
});

describe('leaving the page', () => {
  /** A window that records its `beforeunload` listeners and fires them. */
  function fakeWindow() {
    const listeners = new Set<(e: BeforeUnloadEvent) => void>();
    return {
      win: {
        addEventListener: (_: string, l: (e: BeforeUnloadEvent) => void) => listeners.add(l),
        removeEventListener: (_: string, l: (e: BeforeUnloadEvent) => void) => listeners.delete(l),
      } as never,
      listeners,
      leave: () => {
        let prevented = false;
        const event = { preventDefault: () => (prevented = true), returnValue: undefined } as never;
        for (const l of listeners) l(event);
        return prevented;
      },
    };
  }

  it('asks while a folder has unsaved edits or a write is pending, and listens only then', () => {
    const store = createSessionStore();
    let pending = false;
    let flushed = 0;
    const page = fakeWindow();
    installLeaveGuard({ store, pending: () => pending, flush: () => flushed++, win: page.win });
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'folder', name: 'repo', readAt: 0 });
    expect(page.listeners.size).toBe(0);
    edit(store, CI);
    expect(page.listeners.size).toBe(1);
    expect(page.leave()).toBe(true);
    store.getState().undo();
    expect(page.listeners.size).toBe(0);

    // A pasted file carries its edits: only a pending write of them asks.
    store
      .getState()
      .setFiles({ [CI]: 'on: push\n' }, { kind: 'paste', buffers: [{ path: CI, text: 'on: push\n' }] });
    pending = true;
    edit(store, CI);
    // The write that waits starts as the browser asks: one started in `pagehide` would not finish.
    expect(page.leave()).toBe(true);
    expect(flushed).toBe(2);
    pending = false;
    expect(page.leave()).toBe(false);
    expect(flushed).toBe(2);
  });
});
