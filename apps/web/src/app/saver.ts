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
   * Saves every unsaved file to the folder; a save of these files under way is the one returned. True once every edit
   * is in the folder (none settled by keeping the folder's version). Call it in the gesture, before anything is awaited.
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
 * A file removed here is not deleted from the folder, only looked for (`removed`). A file that is not UTF-8 is never
 * written (`encoding`): its text is not what the file holds.
 */
export function targetsOf(files: SessionState['files']): {
  targets: SaveTarget[];
  removed: string[];
  encoding: string[];
} {
  const targets: SaveTarget[] = [];
  const removed: string[] = [];
  const encoding: string[] = [];
  for (const path of dirtyPaths(files).sort()) {
    const text = files.byPath[path];
    const meta = files.meta[path];
    if (text === undefined) removed.push(path);
    else if (meta?.utf8 === false) encoding.push(path);
    else {
      const base = files.base[path];
      const bom = meta?.bom ?? false;
      targets.push(
        base === undefined ? { path, kind: 'create', text, bom } : { path, kind: 'update', text, base, bom },
      );
    }
  }
  return { targets, removed, encoding };
}

/** The save under way, and the files it is for: a save of other files is another save. */
interface Running {
  epoch: number;
  done: Promise<boolean>;
}

export function createSaver({ store, now = Date.now }: { store: SessionStore; now?: () => number }): Saver {
  let running: Running | undefined;
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

  /**
   * The report, in the status line and, when a file failed or was not attempted, in the dialog. True when every edit
   * is in the folder: nothing is left to write, and no file was settled by keeping the folder's version, whose
   * author's text then lives only in the history.
   */
  const report = (folder: string, files: FileOutcome[], denied?: true): boolean => {
    const sentence = denied
      ? `Saving to ${folder} was not allowed: nothing was written`
      : reportSentence(files);
    const shown = denied === true || files.some((f) => f.status === 'failed' || f.status === 'not-attempted');
    store.getState().setSaving({
      status: 'done',
      folder,
      at: now(),
      files,
      sentence,
      open: shown,
      ...(denied && { denied }),
    });
    if (denied || files.some((f) => f.status === 'disk')) return false;
    return targetsOf(store.getState().files).targets.length === 0;
  };

  /**
   * The folder's version of each file the author chose to keep it for: one undoable entry, which also sets the base,
   * planned over the author's text as the check found it. The files it settled.
   */
  const keepDisk = (epoch: number, conflicts: DiskConflict[], choices: Choices): FileOutcome[] => {
    const kept = conflicts.filter((c) => choices[c.path]?.choice === 'disk');
    if (kept.length === 0) return [];
    const disk: Record<string, DiskFile | null> = {};
    const from: Record<string, string | null> = {};
    for (const c of kept) {
      disk[c.path] = c.disk ?? null;
      from[c.path] = c.mine ?? null;
    }
    const label = `Kept the disk version of ${listOf(kept.map((c) => fileLabel(c.path)))}`;
    const outcome = store.getState().fromDisk(epoch, label, disk, Object.keys(disk), from);
    if (!outcome.ok && 'refusal' in outcome && outcome.refusal) return [];
    return kept.map((c) => ({ path: c.path, status: 'disk' }));
  };

  /**
   * Checks and writes until nothing is left to choose: each round reads the folder again, so a file that changed
   * while the author chose is asked about again. A new source on the way (while the browser asks for access, while
   * the author chooses, while the files are written) ends it, and moves nothing.
   */
  const flow = async (asked: Promise<boolean>, root: DirectoryLike, folder: string, epoch: number) => {
    const allowed = await asked;
    if (store.getState().files.epoch !== epoch) return false;
    if (!allowed) return report(folder, [], true);
    const choices: Record<string, Choices[string]> = {};
    const took: FileOutcome[] = [];
    for (;;) {
      const { targets, removed, encoding } = targetsOf(store.getState().files);
      const run = await saveTo(root, targets, choices, removed);
      if (store.getState().files.epoch !== epoch) return false;
      if (run.kind === 'done')
        return written(epoch, folder, targets, [...took, ...run.files, ...as(encoding, 'encoding')]);
      const chosen = await settle('save', folder, run.conflicts);
      if (store.getState().files.epoch !== epoch) return false;
      if (!chosen)
        return cancelled(folder, [
          ...took,
          ...as(
            run.conflicts.map((c) => c.path),
            'conflict',
          ),
        ]);
      took.push(...keepDisk(epoch, run.conflicts, chosen));
      Object.assign(choices, chosen);
    }
  };

  /** Each saved file's base moves to the text written, and a file gone from the folder too loses its; then the report. */
  const written = (epoch: number, folder: string, targets: SaveTarget[], files: FileOutcome[]): boolean => {
    const texts: Record<string, string | null> = {};
    for (const f of files)
      if (f.status === 'saved') texts[f.path] = textOf(targets, f.path);
      else if (f.status === 'gone') texts[f.path] = null;
    store.getState().saved(epoch, texts);
    return report(folder, files);
  };

  const cancelled = (folder: string, files: FileOutcome[]): boolean => {
    const disk = files.filter((f) => f.status === 'disk').map((f) => fileLabel(f.path));
    const kept = disk.length > 0 ? `; kept the disk version of ${listOf(disk)}` : '';
    store.getState().setSaving({
      status: 'done',
      folder,
      at: now(),
      files,
      sentence: `Save cancelled: nothing was written to ${folder}${kept}`,
      open: false,
    });
    return false;
  };

  const save = (): Promise<boolean> => {
    const s = store.getState();
    if (s.source.kind !== 'folder' || !s.source.handle) return Promise.resolve(false);
    const epoch = s.files.epoch;
    if (running?.epoch === epoch) return running.done;
    const folder = s.source.name;
    const { targets, removed, encoding } = targetsOf(s.files);
    if (targets.length === 0 && removed.length === 0)
      return Promise.resolve(report(folder, as(encoding, 'encoding')));
    const root = s.source.handle as unknown as DirectoryLike & PermissionHandle;
    // First, while the gesture's activation lasts; a save that writes nothing asks for nothing.
    const asked = targets.length > 0 ? requestWrite(root) : Promise.resolve(true);
    s.setSaving({ status: 'running', folder });
    const done: Promise<boolean> = flow(asked, root, folder, epoch).finally(() => {
      if (running?.done === done) running = undefined;
    });
    running = { epoch, done };
    return done;
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

const as = (paths: readonly string[], status: 'encoding' | 'conflict'): FileOutcome[] =>
  paths.map((path) => ({ path, status }));

const textOf = (targets: readonly SaveTarget[], path: string): string =>
  targets.find((t) => t.path === path)!.text;
