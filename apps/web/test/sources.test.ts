import { describe, expect, it } from 'vitest';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { type SourceStore, type StoredSource, sourceStore } from '../src/state/persist';
import { createSessionStore } from '../src/state/store';

/** A tree as `{ name: text | subtree }`. */
type Tree = { [name: string]: string | Tree };

const fileOf = (text: string) => ({ size: text.length, text: () => Promise.resolve(text) });

interface FolderOptions {
  /** The browser's answer to whether the folder may be read without a click. */
  permission?: () => Promise<PermissionState>;
  /** Waited for before the walk lists the folder; a rejection is a folder that no longer reads. */
  walk?: () => Promise<void>;
}

/** A folder handle as Chromium gives it, permission included. */
function folder(name: string, tree: Tree, options: FolderOptions = {}): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    queryPermission: options.permission ?? (() => Promise.resolve('granted')),
    requestPermission: () => Promise.resolve('denied'),
    async *entries() {
      await options.walk?.();
      for (const [n, v] of Object.entries(tree))
        yield [
          n,
          typeof v === 'string'
            ? { kind: 'file', name: n, getFile: () => Promise.resolve(fileOf(v)) }
            : folder(n, v),
        ];
    },
  } as unknown as FileSystemDirectoryHandle;
}

const dropOf = (...items: unknown[]) => ({ items }) as unknown as DataTransfer;
const folderItem = (handle: FileSystemDirectoryHandle) => ({
  kind: 'file',
  getAsFileSystemHandle: () => Promise.resolve(handle),
  webkitGetAsEntry: () => null,
  getAsFile: () => null,
});
const fileItem = (name: string, text: string) => ({
  kind: 'file',
  webkitGetAsEntry: () => null,
  getAsFile: () => ({ name, ...fileOf(text) }),
});

/** A promise settled from outside. */
function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const workflows = (files: Tree): Tree => ({ '.github': { workflows: files } });
const BIG = 'x'.repeat(2.5 * 1024 * 1024);
const BIG_LEFT_OUT = 'left out .github/workflows/big.yml (2.5 MB); a file may be at most 2 MB';

function setup(persistOf: (kv: ReturnType<typeof memoryStore>) => SourceStore = sourceStore) {
  const store = createSessionStore();
  const kv = memoryStore();
  const sources = createSources({ store, persist: persistOf(kv) });
  const notices = () => store.getState().notices.map((n) => n.text);
  return { store, kv, sources, notices };
}

describe('the sources of a session, at their edges', () => {
  it('reports a drop with no workflow file in it and leaves the pasted buffers as they were', async () => {
    const { store, sources } = setup();
    sources.paste('', 'on: push');
    const version = store.getState().files.version;
    await sources.drop(dropOf(fileItem('README.md', '# hello')));
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: expect.stringContaining('nothing in the drop is a workflow file'),
    });
    expect(store.getState().files.version).toBe(version);
  });

  it('stores a drop of several items as a copy, so the next visit gets all of it', async () => {
    const { store, kv, sources } = setup();
    const a = folder('repoA', workflows({ 'ci.yml': 'on: push' }));
    const b = folder('repoB', workflows({ 'release.yml': 'on: release' }));
    await sources.drop(dropOf(folderItem(a), folderItem(b), fileItem('hotfix.yml', 'on: push')));
    expect(store.getState().source).toEqual({
      kind: 'folder',
      name: 'repoA + 2 more',
      readAt: expect.any(Number),
    });
    expect(Object.keys(store.getState().files.byPath).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/hotfix.yml',
      '.github/workflows/release.yml',
    ]);
    expect(await kv.get('current')).toMatchObject({ kind: 'copy', name: 'repoA + 2 more' });
    const next = setup(() => sourceStore(kv));
    await next.sources.restore();
    expect(next.store.getState().files.byPath).toEqual(store.getState().files.byPath);
  });

  it('stores a folder dropped beside a file it left out as the folder, not as a copy', async () => {
    const { store, kv, sources, notices } = setup();
    const repo = folder('repo', workflows({ 'ci.yml': 'on: push' }));
    await sources.drop(dropOf(folderItem(repo), fileItem('big.yml', BIG)));
    expect(store.getState().source).toEqual({
      kind: 'folder',
      name: 'repo',
      handle: repo,
      readAt: expect.any(Number),
    });
    expect(store.getState().files.byPath).toEqual({ '.github/workflows/ci.yml': 'on: push' });
    expect(notices()).toEqual([`the drop: ${BIG_LEFT_OUT}`]);
    expect(await kv.get('current')).toEqual({ kind: 'folder', name: 'repo', handle: repo });
  });

  it('forgets a stored folder that no longer reads, after saying so', async () => {
    const { store, kv, sources } = setup();
    const gone = () => Promise.reject(new DOMException('the folder could not be found', 'NotFoundError'));
    await kv.set('current', { kind: 'folder', name: 'repo', handle: folder('repo', {}, { walk: gone }) });
    await sources.restore();
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: 'reading repo failed: the folder could not be found',
    });
    expect(await kv.get('current')).toBeUndefined();

    await kv.set('current', { kind: 'folder', name: 'docs', handle: folder('docs', { 'README.md': 'x' }) });
    await sources.restore();
    expect(store.getState().error).toMatchObject({
      message: expect.stringContaining('no workflow files in the folder docs'),
    });
    expect(await kv.get('current')).toBeUndefined();

    store.getState().clearError();
    await sources.restore();
    expect(store.getState().error).toBeUndefined();
  });

  it('leaves alone what the author chose while the last visit was still being restored', async () => {
    // The stored source arrives after a sample was picked.
    const loaded = later<void>();
    const slow = setup((kv) => {
      const persist = sourceStore(kv);
      const load = async () => {
        const stored = await persist.load();
        await loaded.promise;
        return stored;
      };
      return { ...persist, load };
    });
    await slow.kv.set('current', {
      kind: 'paste',
      buffers: [{ path: '.github/workflows/old.yml', text: 'on: push' }],
    });
    const restoring = slow.sources.restore();
    slow.sources.useSample('starter');
    loaded.resolve();
    await restoring;
    expect(slow.store.getState().source).toEqual({ kind: 'sample', name: 'starter' });

    // A granted folder still walking when the author pastes.
    const walking = later<void>();
    const release = later<void>();
    const walk = () => {
      walking.resolve();
      return release.promise;
    };
    const granted = setup();
    const repo = folder('repo', workflows({ 'ci.yml': 'on: push' }), { walk });
    await granted.kv.set('current', { kind: 'folder', name: 'repo', handle: repo });
    const reading = granted.sources.restore();
    await walking.promise;
    granted.sources.paste('', 'on: pull_request');
    release.resolve();
    await reading;
    expect(granted.store.getState().source).toMatchObject({ kind: 'paste' });
    expect(granted.store.getState().files.byPath).toEqual({
      '.github/workflows/pasted.yml': 'on: pull_request',
    });
    expect(await granted.kv.get('current')).toMatchObject({ kind: 'paste' });

    // A folder that needs a click, answered after the author picked a sample.
    const asking = later<void>();
    const answer = later<PermissionState>();
    const permission = () => {
      asking.resolve();
      return answer.promise;
    };
    const prompt = setup();
    await prompt.kv.set('current', {
      kind: 'folder',
      name: 'repo',
      handle: folder('repo', {}, { permission }),
    });
    const offering = prompt.sources.restore();
    await asking.promise;
    prompt.sources.useSample('starter');
    answer.resolve('prompt');
    await offering;
    expect(prompt.store.getState().source).toEqual({ kind: 'sample', name: 'starter' });
    expect(Object.keys(prompt.store.getState().files.byPath).length).toBeGreaterThan(0);
  });

  it('takes a stored kind named like an Object.prototype key as nothing stored', async () => {
    const stored = memoryStore();
    for (const kind of ['constructor', 'toString']) {
      await stored.set('current', { kind });
      expect(await sourceStore(stored).load()).toBeUndefined();
    }
    const odd = setup((kv) => ({
      ...sourceStore(kv),
      load: () => Promise.resolve({ kind: 'constructor' } as unknown as StoredSource),
    }));
    await odd.sources.restore();
    expect(odd.store.getState().error).toBeUndefined();
    expect(odd.store.getState().source).toEqual({ kind: 'none' });
  });

  it('tells the author which files it left out for their size, and takes the rest', async () => {
    const { store, sources, notices } = setup();
    const repo = folder('repo', workflows({ 'ci.yml': 'on: push', 'big.yml': BIG }));
    await sources.drop(dropOf(folderItem(repo)));
    expect(store.getState().error).toBeUndefined();
    expect(store.getState().files.byPath).toEqual({ '.github/workflows/ci.yml': 'on: push' });
    expect(notices()).toEqual([`the folder repo: ${BIG_LEFT_OUT}`]);
    await sources.reload();
    expect(notices().slice(1)).toEqual(['repo: no changes', `the folder repo: ${BIG_LEFT_OUT}`]);

    await sources.drop(dropOf(folderItem(folder('huge', workflows({ 'big.yml': BIG })))));
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: `nothing in the folder huge fits: ${BIG_LEFT_OUT}`,
    });

    sources.paste('', 'on: push');
    await sources.drop(dropOf(fileItem('big.yml', BIG)));
    expect(store.getState().error).toMatchObject({ message: `nothing in the drop fits: ${BIG_LEFT_OUT}` });
    await sources.drop(dropOf(fileItem('a.yml', 'on: push'), fileItem('big.yml', BIG)));
    expect(Object.keys(store.getState().files.byPath).sort()).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/pasted.yml',
    ]);
    expect(notices().at(-1)).toBe(`the drop: ${BIG_LEFT_OUT}`);

    await sources.chooseFiles([
      { name: 'ci.yml', webkitRelativePath: 'other/.github/workflows/ci.yml', ...fileOf('on: push') },
      { name: 'big.yml', webkitRelativePath: 'other/.github/workflows/big.yml', ...fileOf(BIG) },
    ] as unknown as File[]);
    expect(store.getState().source).toMatchObject({ kind: 'folder', name: 'other' });
    expect(notices().at(-1)).toBe(`other: ${BIG_LEFT_OUT}`);
  });
});
