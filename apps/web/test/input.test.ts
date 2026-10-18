import { describe, expect, it } from 'vitest';
import { filesFromDrop } from '../src/input/drop';
import { readFolder } from '../src/input/folder';
import { checkPaste, DEFAULT_PASTE_PATH, nextPastePath } from '../src/input/paste';
import { filesFromList } from '../src/input/picker';
import { SAMPLES } from '../src/input/samples';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { sourceStore, toStored } from '../src/state/persist';
import { createSessionStore } from '../src/state/store';

/** A tree as `{ name: text | subtree }`, served through the handle API and the older entry API. */
type Tree = { [name: string]: string | Tree };

const fileOf = (text: string) => ({ size: text.length, text: () => Promise.resolve(text) });

function handleOf(name: string, tree: Tree): FileSystemDirectoryHandle {
  const h = {
    kind: 'directory',
    name,
    async *entries() {
      for (const [n, v] of Object.entries(tree))
        yield [
          n,
          typeof v === 'string'
            ? { kind: 'file', name: n, getFile: () => Promise.resolve(fileOf(v)) }
            : handleOf(n, v),
        ];
    },
  };
  return h as unknown as FileSystemDirectoryHandle;
}

function entryOf(name: string, tree: Tree): FileSystemDirectoryEntry {
  const children = Object.entries(tree).map(([n, v]) =>
    typeof v === 'string'
      ? { isDirectory: false, isFile: true, name: n, file: (ok: (f: unknown) => void) => ok(fileOf(v)) }
      : entryOf(n, v),
  );
  let served = false;
  return {
    isDirectory: true,
    isFile: false,
    name,
    createReader: () => ({
      readEntries: (ok: (batch: unknown[]) => void) => {
        const batch = served ? [] : children;
        served = true;
        ok(batch);
      },
    }),
  } as unknown as FileSystemDirectoryEntry;
}

const repo: Tree = {
  '.github': {
    workflows: { 'ci.yml': 'on: push', 'notes.md': 'x', nested: { 'deep.yml': 'on: push' } },
    actions: { setup: { 'action.yml': 'runs: {}', 'README.md': 'x' } },
    'dependabot.yml': 'version: 2',
  },
  'action.yml': 'runs: {}',
  node_modules: { x: { 'action.yml': 'nope' } },
  src: { 'index.ts': 'export {}' },
};

const EXPECTED = {
  '.github/workflows/ci.yml': 'on: push',
  '.github/actions/setup/action.yml': 'runs: {}',
  'action.yml': 'runs: {}',
};

describe('the ways in', () => {
  it('walks a folder handle through the directories that can hold project files only', async () => {
    expect(await readFolder(handleOf('repo', repo))).toEqual(EXPECTED);
  });

  it('reads a chosen folder from the relative paths, dropping the folder name', async () => {
    const list = [
      { name: 'ci.yml', webkitRelativePath: 'repo/.github/workflows/ci.yml', ...fileOf('on: push') },
      { name: 'action.yml', webkitRelativePath: 'repo/action.yml', ...fileOf('runs: {}') },
      { name: 'index.ts', webkitRelativePath: 'repo/src/index.ts', ...fileOf('x') },
      {
        name: 'big.yml',
        webkitRelativePath: 'repo/.github/workflows/big.yml',
        size: 3 * 1024 * 1024,
        text: () => Promise.resolve(''),
      },
    ] as unknown as File[];
    expect(await filesFromList(list)).toEqual({
      name: 'repo',
      files: { '.github/workflows/ci.yml': 'on: push', 'action.yml': 'runs: {}' },
    });
    const loose = [
      { name: 'deploy.yml', webkitRelativePath: '', ...fileOf('on: push') },
    ] as unknown as File[];
    expect(await filesFromList(loose)).toEqual({ files: { '.github/workflows/deploy.yml': 'on: push' } });
  });

  it('takes a dropped folder through a handle, through entries, and dropped files by name', async () => {
    const withHandle = {
      items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(handleOf('repo', repo)) }],
    } as unknown as DataTransfer;
    const a = await filesFromDrop(withHandle);
    expect(a.name).toBe('repo');
    expect(a.handle).toBeDefined();
    expect(a.files).toEqual(EXPECTED);
    const withEntries = {
      items: [{ kind: 'file', webkitGetAsEntry: () => entryOf('repo', repo) }],
    } as unknown as DataTransfer;
    const b = await filesFromDrop(withEntries);
    expect(b).toEqual({ name: 'repo', files: EXPECTED });
    const files = {
      items: [
        {
          kind: 'file',
          webkitGetAsEntry: () => null,
          getAsFile: () => ({ name: 'ci.yml', ...fileOf('on: push') }),
        },
        { kind: 'string', getAsFile: () => null },
        {
          kind: 'file',
          webkitGetAsEntry: () => null,
          getAsFile: () => ({ name: 'notes.txt', ...fileOf('x') }),
        },
      ],
    } as unknown as DataTransfer;
    expect(await filesFromDrop(files)).toEqual({ files: { '.github/workflows/ci.yml': 'on: push' } });
  });

  it('checks a paste: the path, the content, a test file', () => {
    expect(checkPaste('', 'on: push')).toEqual({ ok: true, path: DEFAULT_PASTE_PATH });
    expect(checkPaste(' ./.github\\workflows\\a.yml ', 'on: push')).toEqual({
      ok: true,
      path: '.github/workflows/a.yml',
    });
    expect(checkPaste('src/a.yml', 'on: push')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a path'),
    });
    expect(checkPaste('.github/workflows/a.yml', '  ')).toMatchObject({
      ok: false,
      reason: 'nothing to paste',
    });
    expect(checkPaste('.github/workflows/a.yml', 'workflow: ci.yml\ncases:\n  - name: x\n')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('route tests run in the CLI'),
    });
    expect(nextPastePath([])).toBe(DEFAULT_PASTE_PATH);
    expect(nextPastePath([DEFAULT_PASTE_PATH, '.github/workflows/pasted-2.yml'])).toBe(
      '.github/workflows/pasted-3.yml',
    );
  });

  it('stores a source as the next visit needs it', () => {
    const files = { 'action.yml': 'x' };
    expect(toStored({ kind: 'none' }, files)).toBeUndefined();
    expect(toStored({ kind: 'sample', name: 'starter' }, files)).toEqual({ kind: 'sample', name: 'starter' });
    const buffers = [{ path: 'action.yml', text: 'x' }];
    expect(toStored({ kind: 'paste', buffers }, files)).toEqual({ kind: 'paste', buffers });
    expect(toStored({ kind: 'folder', name: 'repo', readAt: 1 }, files)).toEqual({
      kind: 'copy',
      name: 'repo',
      buffers,
    });
    const handle = handleOf('repo', {});
    expect(toStored({ kind: 'folder', name: 'repo', handle, readAt: 1 }, files)).toEqual({
      kind: 'folder',
      name: 'repo',
      handle,
    });
  });
});

describe('the sources of a session', () => {
  const setup = () => {
    const store = createSessionStore();
    const kv = memoryStore();
    const persist = sourceStore(kv);
    const sources = createSources({ store, persist });
    return { store, kv, persist, sources };
  };

  it('loads a sample, pastes and removes buffers, forgets, and restores', async () => {
    const { store, kv, sources } = setup();
    sources.useSample('starter');
    expect(store.getState().source).toEqual({ kind: 'sample', name: 'starter' });
    expect(Object.keys(store.getState().files.byPath)).toEqual(Object.keys(SAMPLES[0]!.files));
    await Promise.resolve();
    expect(await kv.get('current')).toEqual({ kind: 'sample', name: 'starter' });

    expect(sources.paste('', 'on: push\njobs: {}')).toEqual({ ok: true, path: DEFAULT_PASTE_PATH });
    expect(store.getState().source).toEqual({
      kind: 'paste',
      buffers: [{ path: DEFAULT_PASTE_PATH, text: 'on: push\njobs: {}' }],
    });
    expect(store.getState().files.version).toBe(2);
    expect(sources.paste('x.yml', 'on: push')).toMatchObject({ ok: false });
    sources.paste('.github/actions/a/action.yml', 'runs: {}');
    expect(Object.keys(store.getState().files.byPath).sort()).toEqual([
      '.github/actions/a/action.yml',
      DEFAULT_PASTE_PATH,
    ]);
    sources.removeBuffer(DEFAULT_PASTE_PATH);
    expect(Object.keys(store.getState().files.byPath)).toEqual(['.github/actions/a/action.yml']);
    sources.removeBuffer('.github/actions/a/action.yml');
    expect(store.getState().source).toEqual({ kind: 'none' });

    sources.useSample('monorepo');
    await sources.forget();
    expect(store.getState().files.byPath).toEqual({});
    expect(await kv.get('current')).toBeUndefined();

    await kv.set('current', {
      kind: 'copy',
      name: 'repo',
      buffers: [
        { path: 'action.yml', text: 'runs: {}' },
        { path: 'src/a.ts', text: 'x' },
      ],
    });
    await sources.restore();
    expect(store.getState().source).toEqual({ kind: 'folder', name: 'repo', readAt: 0 });
    expect(store.getState().files.byPath).toEqual({ 'action.yml': 'runs: {}' });
  });

  it('refuses what holds no workflow files or too much, and takes a drop', async () => {
    const { store, sources } = setup();
    await sources.drop({ items: [{ kind: 'string', getAsFile: () => null }] } as unknown as DataTransfer);
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: expect.stringContaining('nothing in the drop'),
    });
    await sources.drop({
      items: [
        {
          kind: 'file',
          getAsFileSystemHandle: () => Promise.resolve(handleOf('repo', { src: { 'a.ts': 'x' } })),
        },
      ],
    } as unknown as DataTransfer);
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: expect.stringContaining('no workflow files in the folder repo'),
    });
    await sources.drop({
      items: [{ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(handleOf('repo', repo)) }],
    } as unknown as DataTransfer);
    expect(store.getState().error).toBeUndefined();
    expect(store.getState().source).toMatchObject({ kind: 'folder', name: 'repo' });
    expect(store.getState().files.byPath).toEqual(EXPECTED);
    await sources.chooseFiles([
      { name: 'ci.yml', webkitRelativePath: 'other/.github/workflows/ci.yml', ...fileOf('on: push') },
    ] as unknown as File[]);
    expect(store.getState().source).toMatchObject({ kind: 'folder', name: 'other' });
    expect(store.getState().files.version).toBe(2);
  });
});
