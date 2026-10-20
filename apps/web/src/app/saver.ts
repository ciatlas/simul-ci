import {
  type Choices,
  type DirectoryLike,
  type DiskConflict,
  type DiskFile,
  type FileOutcome,
  listOf,
  reportSentence,
  type SaveTarget,
  saveTo,
} from '../input/save';
import { fileLabel } from '../lib/file-label';
import { dirtyPaths, type SessionState, type SessionStore, type Settling } from '../state/store';

/**
 * Save (synthesis § 5.3): the top bar's Save, Mod+S and the replace prompt's Save run it, in the click or the key, since
 * write access is asked for first and the browser grants it only within the gesture. Then `input/save.ts` checks and
 * writes the unsaved files; the conflicts it finds wait for the author's choices (the conflicts dialog, through
 * `settling`), and each saved file's base moves (`store.saved`). The status line says what happened to each file, and
 * the save dialog shows it whenever a file is not saved. Only a folder opened with a handle saves: a paste, a sample
 * or a copy of a folder downloads (§ 5.5), and the first edit of a copy says so once.
 */
export interface Saver {
  /**
   * Saves every unsaved file to the folder, once; a save under way is the one returned. True once nothing is unsaved.
   * Call it in the gesture, before anything is awaited.
   */
  save(): Promise<boolean>;
  /** Shows the conflicts of a save or a reload; the choices, one per file, or `undefined` when the author cancelled. */
  settle(mode: Settling['mode'], folder: string, conflicts: DiskConflict[]): Promise<Choices | undefined>;
  /** The conflicts dialog's answer; one for an older question than `seq` is no answer. */
  answer(choices: Choices | undefined, seq?: number): void;
  dispose(): void;
}

/** Whether the files can be saved where they came from: a folder opened with a handle. */
export const canSave = (s: Pick<SessionState, 'source'>): boolean =>
  s.source.kind === 'folder' && s.source.handle !== undefined;

/** The note the first edit of a folder's copy gets (§ 5.5). */
export const COPY_NOTE = 'This folder was opened as a copy; Open folder (Chromium) saves in place.';

interface PermissionHandle {
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** Asks for write access; a handle that cannot be asked is taken as allowed, and its writes say otherwise. */
const requestWrite = (handle: PermissionHandle): Promise<boolean> =>
  handle.requestPermission
    ? handle.requestPermission({ mode: 'readwrite' }).then(
        (state) => state === 'granted',
        () => false,
      )
    : Promise.resolve(true);

/**
 * The files a save writes: each unsaved file that is still here, as an update of its base or as a file created since.
 * A file removed here is not deleted from the folder. A file that is not UTF-8 is never written: its text is not what
 * the file holds.
 */
export function targetsOf(files: SessionState['files']): { targets: SaveTarget[]; removed: string[] } {
  const targets: SaveTarget[] = [];
  const removed: string[] = [];
  for (const path of dirtyPaths(files).sort()) {
    const text = files.byPath[path];
    const meta = files.meta[path];
    if (text === undefined) removed.push(path);
    else if (meta?.utf8 === false) continue;
    else {
      const base = files.base[path];
      const bom = meta?.bom ?? false;
      targets.push(
        base === undefined ? { path, kind: 'create', text, bom } : { path, kind: 'update', text, base, bom },
      );
    }
  }
  return { targets, removed };
}

export function createSaver({ store, now = Date.now }: { store: SessionStore; now?: () => number }): Saver {
  let running: Promise<boolean> | undefined;
  let open: ((choices: Choices | undefined) => void) | undefined;
  let seq = 0;
  let noted = false;

  const answer = (choices: Choices | undefined, asked = seq): void => {
    if (asked !== seq) return;
    const resolve = open;
    open = undefined;
    store.getState().setSettling(undefined);
    resolve?.(choices);
  };

  const settle: Saver['settle'] = (mode, folder, conflicts) => {
    open?.(undefined);
    store.getState().setSettling({ seq: ++seq, mode, folder, conflicts });
    return new Promise((resolve) => {
      open = resolve;
    });
  };

  /** The report, in the status line and, when a file is not saved, in the dialog; true when nothing is unsaved. */
  const report = (folder: string, files: FileOutcome[], denied?: true): boolean => {
    const sentence = denied
      ? `Saving to ${folder} was not allowed: nothing was written`
      : reportSentence(files);
    const shown = denied === true || files.some((f) => f.status !== 'saved');
    store.getState().setSaving({
      status: 'done',
      folder,
      at: now(),
      files,
      sentence,
      open: shown,
      ...(denied && { denied }),
    });
    return dirtyPaths(store.getState().files).length === 0;
  };

  /** The folder's version of each file the author chose to keep it for: one undoable entry, which also sets the base. */
  const keepDisk = (epoch: number, conflicts: DiskConflict[], choices: Choices): void => {
    const kept = conflicts.filter((c) => choices[c.path]?.choice === 'disk');
    if (kept.length === 0) return;
    const disk: Record<string, DiskFile | null> = {};
    for (const c of kept) disk[c.path] = c.disk ?? null;
    const label = `Kept the disk version of ${listOf(kept.map((c) => fileLabel(c.path)))}`;
    store.getState().fromDisk(epoch, label, disk, Object.keys(disk));
  };

  /**
   * Checks and writes until nothing is left to choose: each round reads the folder again, so a file that changed
   * while the author chose is asked about again. A new source on the way ends it, and moves nothing.
   */
  const flow = async (asked: Promise<boolean>, root: DirectoryLike, folder: string, epoch: number) => {
    if (!(await asked)) return report(folder, [], true);
    const choices: Record<string, Choices[string]> = {};
    for (;;) {
      const { targets, removed } = targetsOf(store.getState().files);
      const run = await saveTo(root, targets, choices);
      if (store.getState().files.epoch !== epoch) return false;
      if (run.kind === 'done') return written(epoch, folder, targets, [...run.files, ...keptOf(removed)]);
      const chosen = await settle('save', folder, run.conflicts);
      if (store.getState().files.epoch !== epoch) return false;
      if (!chosen) return cancelled(folder, run.conflicts);
      keepDisk(epoch, run.conflicts, chosen);
      Object.assign(choices, chosen);
    }
  };

  /** Each saved file's base moves to the text written; then the report. */
  const written = (epoch: number, folder: string, targets: SaveTarget[], files: FileOutcome[]): boolean => {
    const texts: Record<string, string> = {};
    for (const f of files) if (f.status === 'saved') texts[f.path] = textOf(targets, f.path);
    store.getState().saved(epoch, texts);
    return report(folder, files);
  };

  const cancelled = (folder: string, conflicts: DiskConflict[]): boolean => {
    const files = conflicts.map((c) => ({ path: c.path, status: 'conflict' as const }));
    store.getState().setSaving({
      status: 'done',
      folder,
      at: now(),
      files,
      sentence: `Save cancelled: nothing was written to ${folder}`,
      open: false,
    });
    return false;
  };

  const save = (): Promise<boolean> => {
    if (running) return running;
    const s = store.getState();
    if (s.source.kind !== 'folder' || !s.source.handle) return Promise.resolve(false);
    const folder = s.source.name;
    if (dirtyPaths(s.files).length === 0) return Promise.resolve(report(folder, []));
    const root = s.source.handle as unknown as DirectoryLike & PermissionHandle;
    // First, while the gesture's activation lasts.
    const asked = requestWrite(root);
    s.setSaving({ status: 'running', folder });
    running = flow(asked, root, folder, s.files.epoch).finally(() => {
      running = undefined;
    });
    return running;
  };

  const unsubscribe = store.subscribe((s, prev) => {
    // New files: the conflicts asked about are not theirs.
    if (s.files.epoch !== prev.files.epoch && open) answer(undefined);
    if (!noted && s.files.version !== prev.files.version && isEditedCopy(s)) {
      noted = true;
      s.notify(COPY_NOTE);
    }
  });

  return { save, settle, answer, dispose: unsubscribe };
}

const isEditedCopy = (s: SessionState): boolean =>
  s.source.kind === 'folder' && !s.source.handle && dirtyPaths(s.files).length > 0;

const keptOf = (removed: string[]): FileOutcome[] => removed.map((path) => ({ path, status: 'kept' }));

const textOf = (targets: readonly SaveTarget[], path: string): string =>
  targets.find((t) => t.path === path)!.text;
