import { hashFiles } from '../lib/hash';
import type { SourceStore } from '../state/persist';
import type { SessionStore, Source } from '../state/store';
import { filesFromDrop } from './drop';
import { filterFiles } from './filter';
import { canPickFolder, canReadFolder, pickFolder, readFolder, requestFolder } from './folder';
import { overLimit } from './limits';
import { checkPaste, type PasteCheck } from './paste';
import { filesFromList } from './picker';
import { sampleByName } from './samples';

/**
 * Every way files come in ends in `setFiles` after the filter and the limits, and in the source store so a reload
 * finds them again. Failures are the `source` error of the store; a cancelled picker is nothing.
 */
export interface Sources {
  canPickFolder: boolean;
  openFolder(): Promise<void>;
  chooseFiles(list: ArrayLike<File>): Promise<void>;
  drop(transfer: DataTransfer): Promise<void>;
  paste(path: string, text: string): PasteCheck;
  removeBuffer(path: string): void;
  useSample(name: string): void;
  /** Re-reads an opened folder; says so when nothing changed. */
  reload(): Promise<void>;
  /** Asks for the stored folder again; must run in a click. */
  reopen(): Promise<void>;
  forget(): Promise<void>;
  /** What the last visit left in IndexedDB. */
  restore(): Promise<void>;
}

const LOOKED_FOR = 'looked for .github/workflows/*.yml, .github/actions/**/action.yml and action.yml';

export function createSources({ store, persist }: { store: SessionStore; persist: SourceStore }): Sources {
  const actions = store.getState();

  const fail = (message: string): void => actions.rejected({ kind: 'source', message });

  const accept = (files: Record<string, string>, source: Source, where: string): boolean => {
    const kept = filterFiles(files);
    if (Object.keys(kept).length === 0) {
      fail(`no workflow files in ${where}: ${LOOKED_FOR}`);
      return false;
    }
    const limit = overLimit(kept);
    if (limit) {
      fail(`${where} is too big: ${limit}`);
      return false;
    }
    actions.setFiles(kept, source);
    void persist.save(source, kept);
    return true;
  };

  const guarded = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };

  const filesOf = (buffers: { path: string; text: string }[]): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const b of buffers) files[b.path] = b.text;
    return filterFiles(files);
  };

  const buffersOf = (): { path: string; text: string }[] => {
    const s = store.getState();
    return s.source.kind === 'paste' ? s.source.buffers : [];
  };

  const setBuffers = (buffers: { path: string; text: string }[]): void => {
    if (buffers.length === 0) {
      actions.forgetSource();
      void persist.clear();
      return;
    }
    accept(filesOf(buffers), { kind: 'paste', buffers }, 'the pasted files');
  };

  /** A stored folder's files, after the permission the browser needs; `undefined` once the failure is reported. */
  const readAgain = async (source: Source, orElse: string): Promise<Record<string, string> | undefined> => {
    if (source.kind !== 'folder' || !source.handle) return undefined;
    if (!(await canReadFolder(source.handle)) && !(await requestFolder(source.handle))) {
      fail(`reading ${source.name} is not allowed any more; ${orElse}`);
      return undefined;
    }
    return filterFiles(await readFolder(source.handle));
  };

  /** A folder handle from the last visit: read now when the browser remembered the permission, else offered. */
  const restoreFolder = async (name: string, handle: FileSystemDirectoryHandle): Promise<void> => {
    const source: Source = { kind: 'folder', name, handle, readAt: 0 };
    if (await canReadFolder(handle)) {
      accept(await readFolder(handle), { ...source, readAt: Date.now() }, `the folder ${name}`);
      return;
    }
    // Not yet: the screen offers "Reopen <name>"; the scenario from the URL waits for the files.
    store.setState({ source, files: { version: store.getState().files.version + 1, byPath: {} } });
  };

  return {
    canPickFolder: canPickFolder(),

    openFolder: () =>
      guarded(async () => {
        const picked = await pickFolder();
        if (!picked) return;
        accept(
          picked.files,
          { kind: 'folder', name: picked.name, handle: picked.handle, readAt: Date.now() },
          `the folder ${picked.name}`,
        );
      }),

    chooseFiles: (list) =>
      guarded(async () => {
        const { name, files } = await filesFromList(list);
        accept(
          files,
          { kind: 'folder', name: name ?? 'the chosen files', readAt: Date.now() },
          name ?? 'the chosen files',
        );
      }),

    drop: (transfer) =>
      guarded(async () => {
        const dropped = await filesFromDrop(transfer);
        if (dropped.name !== undefined) {
          const source: Source = { kind: 'folder', name: dropped.name, readAt: Date.now() };
          if (dropped.handle) source.handle = dropped.handle;
          accept(dropped.files, source, `the folder ${dropped.name}`);
          return;
        }
        const buffers = buffersOf().filter((b) => !(b.path in dropped.files));
        for (const [path, text] of Object.entries(dropped.files)) buffers.push({ path, text });
        if (buffers.length === 0) fail(`nothing in the drop is a workflow file: ${LOOKED_FOR}`);
        else setBuffers(buffers);
      }),

    paste: (path, text) => {
      const check = checkPaste(path, text);
      if (!check.ok) return check;
      const buffers = buffersOf().filter((b) => b.path !== check.path);
      buffers.push({ path: check.path, text });
      setBuffers(buffers);
      return check;
    },

    removeBuffer: (path) => setBuffers(buffersOf().filter((b) => b.path !== path)),

    useSample: (name) => {
      const sample = sampleByName(name);
      if (!sample) return fail(`no sample named ${name}`);
      accept(sample.files, { kind: 'sample', name }, `the sample ${name}`);
    },

    reload: () =>
      guarded(async () => {
        const s = store.getState();
        if (s.source.kind !== 'folder') return;
        const files = await readAgain(s.source, 'open it again');
        if (!files) return;
        if (hashFiles(files) === hashFiles(s.files.byPath)) {
          actions.notify(`${s.source.name}: no changes`);
          return;
        }
        accept(files, { ...s.source, readAt: Date.now() }, 'the folder');
      }),

    reopen: () =>
      guarded(async () => {
        const s = store.getState();
        if (s.source.kind !== 'folder') return;
        const files = await readAgain(s.source, 'choose it again');
        if (files) accept(files, { ...s.source, readAt: Date.now() }, 'the folder');
      }),

    forget: async () => {
      actions.forgetSource();
      await persist.clear();
    },

    restore: () =>
      guarded(async () => {
        const stored = await persist.load();
        if (!stored) return;
        if (stored.kind === 'sample') {
          const sample = sampleByName(stored.name);
          if (sample) actions.setFiles(sample.files, { kind: 'sample', name: stored.name });
        } else if (stored.kind === 'paste') {
          if (stored.buffers.length)
            actions.setFiles(filesOf(stored.buffers), { kind: 'paste', buffers: stored.buffers });
        } else if (stored.kind === 'copy') {
          actions.setFiles(filesOf(stored.buffers), { kind: 'folder', name: stored.name, readAt: 0 });
        } else await restoreFolder(stored.name, stored.handle);
      }),
  };
}
