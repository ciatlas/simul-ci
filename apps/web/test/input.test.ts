import { describe, expect, it } from 'vitest';
import { filesFromDrop } from '../src/input/drop';
import { readFolder } from '../src/input/folder';
import { leftOut } from '../src/input/limits';
import { checkPaste, DEFAULT_PASTE_PATH, nextPastePath } from '../src/input/paste';
import { filesFromList } from '../src/input/picker';
import { type FileMeta, textMeta } from '../src/input/read';
import { SAMPLES } from '../src/input/samples';
import { createSources } from '../src/input/sources';
import { memoryStore } from '../src/lib/idb';
import { sourceStore, toStored } from '../src/state/persist';
import { createSessionStore } from '../src/state/store';

/** A tree as `{ name: text | bytes | subtree }`, served through the handle API and the older entry API. */
type Tree = { [name: string]: string | Uint8Array<ArrayBuffer> | Tree };

const isFile = (v: Tree[string]): v is string | Uint8Array<ArrayBuffer> =>
  typeof v === 'string' || v instanceof Uint8Array;

/** A File as a walk reads it: its size and its bytes. Text is written as UTF-8; bytes are taken as they are. */
const fileOf = (content: string | Uint8Array<ArrayBuffer>) => {
  const blob = new Blob([content]);
  return { size: blob.size, arrayBuffer: () => blob.arrayBuffer() };
};

function handleOf(name: string, tree: Tree): FileSystemDirectoryHandle {
  const h = {
    kind: 'directory',
    name,
    async *entries() {
      for (const [n, v] of Object.entries(tree))
        yield [
          n,
          isFile(v) ? { kind: 'file', name: n, getFile: () => Promise.resolve(fileOf(v)) } : handleOf(n, v),
        ];
    },
  };
  return h as unknown as FileSystemDirectoryHandle;
}

function entryOf(name: string, tree: Tree): FileSystemDirectoryEntry {
  const children = Object.entries(tree).map(([n, v]) =>
    isFile(v)
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

interface FakeItem {
  kind: 'file' | 'string';
  /** Present where the browser has `getAsFileSystemHandle` (Chromium). */
  handle?: unknown;
  entry?: unknown;
  file?: unknown;
}

/**
 * A drop as the browser hands it over: the items read only while the drop event lasts (from the next microtask on,
 * the list is empty, `kind` is '' and the getters give null), and a handle arrives in a later task.
 */
function transferOf(items: FakeItem[]): DataTransfer {
  let live = true;
  queueMicrotask(() => {
    live = false;
  });
  const list = items.map((i) => ({
    get kind() {
      return live ? i.kind : '';
    },
    getAsFile: () => (live ? (i.file ?? null) : null),
    webkitGetAsEntry: () => (live ? (i.entry ?? null) : null),
    ...('handle' in i && {
      getAsFileSystemHandle: () => {
        const h = live ? i.handle : null;
        return new Promise((resolve) => setTimeout(() => resolve(h), 0));
      },
    }),
  }));
  return {
    get items() {
      return live ? list : [];
    },
  } as unknown as DataTransfer;
}

/** A dropped folder: Chromium gives a handle, every browser an entry and a File standing for the directory. */
const folderItem = (name: string, tree: Tree, withHandle = true): FakeItem => ({
  kind: 'file',
  ...(withHandle && { handle: handleOf(name, tree) }),
  entry: entryOf(name, tree),
  file: { name, ...fileOf('') },
});

/** A dropped file: Chromium gives a file handle, every browser a file entry and the File. */
const fileItem = (name: string, text: string | Uint8Array<ArrayBuffer>, withHandle = true): FakeItem => ({
  kind: 'file',
  ...(withHandle && { handle: { kind: 'file', name } }),
  entry: { isDirectory: false, isFile: true, name },
  file: { name, ...fileOf(text) },
});

/** Bigger than a file may be. */
const BIG = 'x'.repeat(2.5 * 1024 * 1024);

const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));
/** A workflow saved by an editor that writes a BOM and CR LF. */
const BOM_CRLF = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('on: push\r\njobs: {}\r\n')]);
/** A workflow saved as Latin-1: its é is no UTF-8. */
const LATIN1 = new Uint8Array([...utf8('name: caf'), 0xe9, ...utf8('\non: push\n')]);
/** What a walk reads of the two. */
const ODD = {
  files: {
    '.github/workflows/bom.yml': 'on: push\r\njobs: {}\r\n',
    '.github/workflows/latin1.yml': 'name: caf\uFFFD\non: push\n',
  },
  meta: {
    '.github/workflows/bom.yml': { bom: true, eol: 'crlf', utf8: true },
    '.github/workflows/latin1.yml': { bom: false, eol: 'lf', utf8: false },
  },
};

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

/** What reading these files finds: each one is written as UTF-8 without a BOM, so its meta is its string's. */
const metaOf = (files: Record<string, string>): Record<string, FileMeta> =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path, textMeta(text)]));

describe('the ways in', () => {
  it('walks a folder handle through the directories that can hold project files only', async () => {
    expect(await readFolder(handleOf('repo', repo))).toEqual({
      files: EXPECTED,
      meta: metaOf(EXPECTED),
      skipped: [],
    });
  });

  it('leaves out a project file over the per-file limit and says which, on every walk', async () => {
    const tree: Tree = {
      '.github': { workflows: { 'ci.yml': 'on: push', 'big.yml': BIG }, 'dependabot.yml': BIG },
    };
    const skipped = [{ path: '.github/workflows/big.yml', bytes: BIG.length }];
    const files = { '.github/workflows/ci.yml': 'on: push' };
    const meta = metaOf(files);
    expect(await readFolder(handleOf('repo', tree))).toEqual({ files, meta, skipped });
    expect(await filesFromDrop(transferOf([folderItem('repo', tree)]))).toMatchObject({ files, skipped });
    expect(await filesFromDrop(transferOf([folderItem('repo', tree, false)]))).toMatchObject({
      files,
      skipped,
    });
    expect(
      await filesFromDrop(transferOf([fileItem('ci.yml', 'on: push'), fileItem('big.yml', BIG)])),
    ).toMatchObject({ files, skipped });
    const list = [
      { name: 'ci.yml', webkitRelativePath: 'repo/.github/workflows/ci.yml', ...fileOf('on: push') },
      { name: 'big.yml', webkitRelativePath: 'repo/.github/workflows/big.yml', ...fileOf(BIG) },
      { name: 'dependabot.yml', webkitRelativePath: 'repo/.github/dependabot.yml', ...fileOf(BIG) },
    ] as unknown as File[];
    expect(await filesFromList(list)).toEqual({ name: 'repo', files, meta, skipped });
  });

  it('records what reading found of each file on every walk: a BOM, the line endings, bytes that are no UTF-8', async () => {
    const tree: Tree = { '.github': { workflows: { 'bom.yml': BOM_CRLF, 'latin1.yml': LATIN1 } } };
    expect(await readFolder(handleOf('repo', tree))).toEqual({ ...ODD, skipped: [] });
    expect(await filesFromDrop(transferOf([folderItem('repo', tree)]))).toMatchObject(ODD);
    expect(await filesFromDrop(transferOf([folderItem('repo', tree, false)]))).toMatchObject(ODD);
    expect(
      await filesFromDrop(transferOf([fileItem('bom.yml', BOM_CRLF), fileItem('latin1.yml', LATIN1)])),
    ).toMatchObject(ODD);
    const list = [
      { name: 'bom.yml', webkitRelativePath: 'repo/.github/workflows/bom.yml', ...fileOf(BOM_CRLF) },
      { name: 'latin1.yml', webkitRelativePath: 'repo/.github/workflows/latin1.yml', ...fileOf(LATIN1) },
    ] as unknown as File[];
    expect(await filesFromList(list)).toMatchObject(ODD);
  });

  it('words the files a walk left out as the per-file limit does', () => {
    const skipped = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `.github/workflows/${i}.yml`, bytes: 3 * 1024 * 1024 }));
    expect(leftOut(skipped(1))).toBe('left out .github/workflows/0.yml (3 MB); a file may be at most 2 MB');
    expect(leftOut(skipped(5))).toBe(
      'left out .github/workflows/0.yml (3 MB), .github/workflows/1.yml (3 MB), .github/workflows/2.yml (3 MB) and 2 more; a file may be at most 2 MB',
    );
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
    const read = { '.github/workflows/ci.yml': 'on: push', 'action.yml': 'runs: {}' };
    expect(await filesFromList(list)).toEqual({
      name: 'repo',
      files: read,
      meta: metaOf(read),
      skipped: [{ path: '.github/workflows/big.yml', bytes: 3 * 1024 * 1024 }],
    });
    const loose = [
      { name: 'deploy.yml', webkitRelativePath: '', ...fileOf('on: push') },
    ] as unknown as File[];
    expect(await filesFromList(loose)).toEqual({
      files: { '.github/workflows/deploy.yml': 'on: push' },
      meta: metaOf({ '.github/workflows/deploy.yml': 'on: push' }),
      skipped: [],
    });
  });

  it('takes a dropped folder through a handle, through entries, and dropped files by name', async () => {
    const a = await filesFromDrop(transferOf([folderItem('repo', repo)]));
    expect(a.name).toBe('repo');
    expect(a.where).toBe('the folder repo');
    expect(a.handle).toBeDefined();
    expect(a.files).toEqual(EXPECTED);
    const b = await filesFromDrop(transferOf([folderItem('repo', repo, false)]));
    expect(b).toEqual({
      name: 'repo',
      where: 'the folder repo',
      files: EXPECTED,
      meta: metaOf(EXPECTED),
      skipped: [],
    });
    const files = transferOf([
      fileItem('ci.yml', 'on: push', false),
      { kind: 'string' },
      fileItem('notes.txt', 'x', false),
    ]);
    expect(await filesFromDrop(files)).toEqual({
      where: 'the drop',
      files: { '.github/workflows/ci.yml': 'on: push' },
      meta: metaOf({ '.github/workflows/ci.yml': 'on: push' }),
      skipped: [],
    });
  });

  it('reads every item of a drop while the drop event lasts, whatever the browser', async () => {
    // Chromium: a file's handle arrives after the event, when the item no longer gives its File.
    expect((await filesFromDrop(transferOf([fileItem('ci.yml', 'on: push')]))).files).toEqual({
      '.github/workflows/ci.yml': 'on: push',
    });
    const three = ['a.yml', 'b.yml', 'c.yml'].map((n) => fileItem(n, `on: push # ${n}`));
    expect(Object.keys((await filesFromDrop(transferOf(three))).files)).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/b.yml',
      '.github/workflows/c.yml',
    ]);
    // Firefox and Safari: no handles; the second item is read after the first folder's walk.
    const mixed = await filesFromDrop(
      transferOf([folderItem('repo', repo, false), fileItem('hotfix.yml', 'on: push', false)]),
    );
    expect(mixed.files).toEqual({ ...EXPECTED, '.github/workflows/hotfix.yml': 'on: push' });
  });

  it('keeps a handle only when the drop is exactly one folder, and names a drop of several', async () => {
    const one = await filesFromDrop(transferOf([folderItem('repo', repo), fileItem('README.md', 'x')]));
    expect(one).toMatchObject({ name: 'repo', where: 'the folder repo', files: EXPECTED });
    expect(one.handle?.name).toBe('repo');
    const withFile = await filesFromDrop(
      transferOf([folderItem('repo', repo), fileItem('hotfix.yml', 'on: push')]),
    );
    const both = { ...EXPECTED, '.github/workflows/hotfix.yml': 'on: push' };
    expect(withFile).toEqual({
      name: 'repo + hotfix.yml',
      where: 'the drop',
      files: both,
      meta: metaOf(both),
      skipped: [],
    });
    const other: Tree = { '.github': { workflows: { 'release.yml': 'on: release' } } };
    const two = await filesFromDrop(transferOf([folderItem('repoA', repo), folderItem('repoB', other)]));
    const all = { ...EXPECTED, '.github/workflows/release.yml': 'on: release' };
    expect(two).toEqual({
      name: 'repoA + repoB',
      where: 'the drop',
      files: all,
      meta: metaOf(all),
      skipped: [],
    });
    const three = await filesFromDrop(
      transferOf([folderItem('repoA', repo), folderItem('repoB', other), fileItem('x.yml', 'on: push')]),
    );
    expect(three.name).toBe('repoA + 2 more');
    expect(three.handle).toBeUndefined();
  });

  it('keeps the handle of a folder dropped beside a workflow file too big to read', async () => {
    const big = await filesFromDrop(transferOf([folderItem('repo', repo), fileItem('big.yml', BIG)]));
    expect(big).toMatchObject({
      name: 'repo',
      where: 'the drop',
      files: EXPECTED,
      skipped: [{ path: '.github/workflows/big.yml', bytes: BIG.length }],
    });
    expect(big.handle?.name).toBe('repo');
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
    // Pasted buffers keep the texts their edits were made to, where those are not the text.
    const edited = [...buffers, { path: 'new.yml', text: 'n' }];
    expect(
      toStored({ kind: 'paste', buffers: edited }, { ...files, 'new.yml': 'n' }, undefined, {
        'action.yml': 'x',
        'gone.yml': 'g',
      }),
    ).toEqual({ kind: 'paste', buffers: edited, base: { 'new.yml': null, 'gone.yml': 'g' } });
    expect(toStored({ kind: 'paste', buffers }, files, undefined, files)).toEqual({ kind: 'paste', buffers });
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

  it('stores what reading found with the buffers only: a folder is read again, a sample is bundled', () => {
    const files = { 'action.yml': 'x' };
    const buffers = [{ path: 'action.yml', text: 'x' }];
    const meta = { 'action.yml': { bom: true, eol: 'none', utf8: false } } as const;
    expect(toStored({ kind: 'paste', buffers }, files, meta)).toEqual({ kind: 'paste', buffers, meta });
    expect(toStored({ kind: 'folder', name: 'repo', readAt: 1 }, files, meta)).toEqual({
      kind: 'copy',
      name: 'repo',
      buffers,
      meta,
    });
    const handle = handleOf('repo', {});
    expect(toStored({ kind: 'folder', name: 'repo', handle, readAt: 1 }, files, meta)).toEqual({
      kind: 'folder',
      name: 'repo',
      handle,
    });
    expect(toStored({ kind: 'sample', name: 'starter' }, files, meta)).toEqual({
      kind: 'sample',
      name: 'starter',
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

    expect(sources.paste('', 'on: push\njobs: {}')).toMatchObject({ ok: true, path: DEFAULT_PASTE_PATH });
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
    await sources.drop(transferOf([{ kind: 'string' }]));
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: expect.stringContaining('nothing in the drop'),
    });
    await sources.drop(transferOf([folderItem('repo', { src: { 'a.ts': 'x' } })]));
    expect(store.getState().error).toMatchObject({
      kind: 'source',
      message: expect.stringContaining('no workflow files in the folder repo'),
    });
    await sources.drop(transferOf([folderItem('repo', repo)]));
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
