import { hashFiles } from '../lib/hash';
import type { SourceStore, StoredSource } from '../state/persist';
import type { SessionStore, Source } from '../state/store';
import { type Dropped, filesFromDrop } from './drop';
import { filterFiles } from './filter';
import { canPickFolder, canReadFolder, pickFolder, readFolder, requestFolder } from './folder';
import { leftOut, overLimit, type Skipped, type Walked } from './limits';
import { checkPaste, type PasteCheck } from './paste';
import { filesFromList } from './picker';
import { sampleByName } from './samples';

/**
 * Every way files come in ends in `setFiles` after the filter and the limits, and in the source store so a reload
 * finds them again. Failures are the `source` error of the store; a cancelled picker is nothing; files a walk left
 * out for their size are a notice.
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
  /** What the last visit left in IndexedDB, unless the author has chosen a source by the time it is read. */
  restore(): Promise<void>;
}

const LOOKED_FOR = 'looked for .github/workflows/*.yml, .github/actions/**/action.yml and action.yml';

export function createSources({ store, persist }: { store: SessionStore; persist: SourceStore }): Sources {
  const actions = store.getState();

  const fail = (message: string): void => actions.rejected({ kind: 'source', message });

  /** Why a source brought nothing: no project file at all, or only ones too big to read. */
  const nothingIn = (where: string, skipped: Skipped[], none: string): string =>
    skipped.length ? `nothing in ${where} fits: ${leftOut(skipped)}` : none;

  const tellLeftOut = (where: string, skipped: Skipped[]): void => {
    if (skipped.length) actions.notify(`${where}: ${leftOut(skipped)}`);
  };

  const accept = (
    files: Record<string, string>,
    source: Source,
    where: string,
    skipped: Skipped[] = [],
  ): boolean => {
    const kept = filterFiles(files);
    if (Object.keys(kept).length === 0) {
      fail(nothingIn(where, skipped, `no workflow files in ${where}: ${LOOKED_FOR}`));
      return false;
    }
    const limit = overLimit(kept);
    if (limit) {
      fail(`${where} is too big: ${limit}`);
      return false;
    }
    actions.setFiles(kept, source);
    tellLeftOut(where, skipped);
    void persist.save(source, kept);
    return true;
  };

  const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const guarded = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (e) {
      fail(messageOf(e));
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

  /** Dropped files with no folder among them join the pasted buffers, replacing a buffer at the same path. */
  const dropLoose = ({ files, skipped }: Dropped): void => {
    if (Object.keys(files).length === 0) {
      fail(nothingIn('the drop', skipped, `nothing in the drop is a workflow file: ${LOOKED_FOR}`));
      return;
    }
    const buffers = buffersOf().filter((b) => !(b.path in files));
    for (const [path, text] of Object.entries(files)) buffers.push({ path, text });
    if (accept(filesOf(buffers), { kind: 'paste', buffers }, 'the pasted files'))
      tellLeftOut('the drop', skipped);
  };

  /** A stored folder's files, after the permission the browser needs; `undefined` once the failure is reported. */
  const readAgain = async (source: Source, orElse: string): Promise<Walked | undefined> => {
    if (source.kind !== 'folder' || !source.handle) return undefined;
    if (!(await canReadFolder(source.handle)) && !(await requestFolder(source.handle))) {
      fail(`reading ${source.name} is not allowed any more; ${orElse}`);
      return undefined;
    }
    return readFolder(source.handle);
  };

  /**
   * A folder handle from the last visit: read now when the browser remembered the permission, else offered. One
   * that no longer reads is reported and forgotten, so the next visit does not fail on it again.
   */
  const restoreFolder = async (
    name: string,
    handle: FileSystemDirectoryHandle,
    untouched: () => boolean,
  ): Promise<void> => {
    const source: Source = { kind: 'folder', name, handle, readAt: 0 };
    const granted = await canReadFolder(handle);
    if (!untouched()) return;
    if (!granted) {
      // Not yet: the screen offers "Reopen <name>"; the scenario from the URL waits for the files.
      store.setState({ source, files: { version: store.getState().files.version + 1, byPath: {} } });
      return;
    }
    let read: Walked;
    try {
      read = await readFolder(handle);
    } catch (e) {
      if (!untouched()) return;
      fail(`reading ${name} failed: ${messageOf(e)}`);
      await persist.clear();
      return;
    }
    if (!untouched()) return;
    if (!accept(read.files, { ...source, readAt: Date.now() }, `the folder ${name}`, read.skipped))
      await persist.clear();
  };

  /** What the last visit stored, set again; a kind this page does not know is nothing stored. */
  const restoreStored = async (stored: StoredSource, untouched: () => boolean): Promise<void> => {
    switch (stored.kind) {
      case 'sample': {
        const sample = sampleByName(stored.name);
        if (sample) actions.setFiles(sample.files, { kind: 'sample', name: stored.name });
        break;
      }
      case 'paste':
        if (stored.buffers.length)
          actions.setFiles(filesOf(stored.buffers), { kind: 'paste', buffers: stored.buffers });
        break;
      case 'copy':
        actions.setFiles(filesOf(stored.buffers), { kind: 'folder', name: stored.name, readAt: 0 });
        break;
      case 'folder':
        await restoreFolder(stored.name, stored.handle, untouched);
        break;
    }
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
          picked.skipped,
        );
      }),

    chooseFiles: (list) =>
      guarded(async () => {
        const { name, files, skipped } = await filesFromList(list);
        accept(
          files,
          { kind: 'folder', name: name ?? 'the chosen files', readAt: Date.now() },
          name ?? 'the chosen files',
          skipped,
        );
      }),

    drop: (transfer) =>
      guarded(async () => {
        const dropped = await filesFromDrop(transfer);
        if (dropped.name === undefined) {
          dropLoose(dropped);
          return;
        }
        const source: Source = { kind: 'folder', name: dropped.name, readAt: Date.now() };
        if (dropped.handle) source.handle = dropped.handle;
        accept(dropped.files, source, dropped.where, dropped.skipped);
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
        const read = await readAgain(s.source, 'open it again');
        if (!read) return;
        const where = `the folder ${s.source.name}`;
        if (hashFiles(read.files) === hashFiles(s.files.byPath)) {
          actions.notify(`${s.source.name}: no changes`);
          tellLeftOut(where, read.skipped);
          return;
        }
        accept(read.files, { ...s.source, readAt: Date.now() }, where, read.skipped);
      }),

    reopen: () =>
      guarded(async () => {
        const s = store.getState();
        if (s.source.kind !== 'folder') return;
        const read = await readAgain(s.source, 'choose it again');
        if (read)
          accept(
            read.files,
            { ...s.source, readAt: Date.now() },
            `the folder ${s.source.name}`,
            read.skipped,
          );
      }),

    forget: async () => {
      actions.forgetSource();
      await persist.clear();
    },

    restore: () =>
      guarded(async () => {
        const at = store.getState().files.version;
        const untouched = (): boolean => {
          const s = store.getState();
          return s.source.kind === 'none' && s.files.version === at;
        };
        const stored = await persist.load();
        if (stored && untouched()) await restoreStored(stored, untouched);
      }),
  };
}
