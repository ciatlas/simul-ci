import {
  type Choices,
  type DiskConflict,
  type DiskFile,
  type FileOutcome,
  listOf,
  reportSentence,
  type SaveTarget,
  saveTo,
} from '../input/save';
import { fileLabel } from '../lib/file-label';
import type { SaveContext } from './saver';
import { targetsOf } from './save-targets';

/**
 * A save's run (synthesis § 5.3), in the dialogs chunk: `app/saver.ts` asks for write access in the gesture and hands
 * over. `input/save.ts` checks and writes the unsaved files; the conflicts it finds wait for the author's choices (the
 * conflicts dialog, through `settling`), and each saved file's base moves (`store.saved`). The status line says what
 * happened to each file, and the save dialog shows it whenever a file is not saved. True once every edit is in the
 * folder (none settled by keeping the folder's version).
 */
export async function runSave(context: SaveContext, asked: Promise<boolean>): Promise<boolean> {
  const allowed = await asked;
  if (gone(context)) return false;
  if (!allowed) return report(context, [], true);
  const { targets, removed, encoding } = targetsOf(context.store.getState().files);
  if (targets.length === 0 && removed.length === 0) return report(context, as(encoding, 'encoding'));
  return rounds(context);
}

/** Whether new files came while the save ran: the save is not theirs, so it moves nothing. */
const gone = ({ store, epoch }: SaveContext): boolean => store.getState().files.epoch !== epoch;

/**
 * Checks and writes until nothing is left to choose: each round reads the folder again, so a file that changed
 * while the author chose is asked about again. A new source on the way (while the author chooses, while the files are
 * written) ends it, and moves nothing.
 */
async function rounds(context: SaveContext): Promise<boolean> {
  const { store, root, folder } = context;
  const choices: Record<string, Choices[string]> = {};
  const took: FileOutcome[] = [];
  const alive = (): boolean => !gone(context);
  for (;;) {
    const { targets, removed, encoding } = targetsOf(store.getState().files);
    const run = await saveTo(root, targets, { choices, removed, alive });
    if (gone(context)) return false;
    if (run.kind === 'done')
      return written(context, targets, [...took, ...run.files, ...as(encoding, 'encoding')]);
    const chosen = await context.settle('save', folder, run.conflicts);
    if (gone(context)) return false;
    if (!chosen)
      return cancelled(context, [
        ...took,
        ...as(
          run.conflicts.map((c) => c.path),
          'conflict',
        ),
      ]);
    took.push(...keepDisk(context, run.conflicts, chosen));
    Object.assign(choices, chosen);
  }
}

/**
 * The report, in the status line and, when a file failed or was not attempted, in the dialog. True when every edit
 * is in the folder: nothing is left to write, and no file was settled by keeping the folder's version, whose
 * author's text then lives only in the history.
 */
function report({ store, now, folder }: SaveContext, files: FileOutcome[], denied?: true): boolean {
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
}

/**
 * The folder's version of each file the author chose to keep it for: one undoable entry, which also sets the base,
 * planned over the author's text as the check found it. The files it settled.
 */
function keepDisk({ store, epoch }: SaveContext, conflicts: DiskConflict[], choices: Choices): FileOutcome[] {
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
}

/** Each saved file's base moves to the text written, and a file gone from the folder too loses its; then the report. */
function written(context: SaveContext, targets: SaveTarget[], files: FileOutcome[]): boolean {
  const texts: Record<string, string | null> = {};
  for (const f of files)
    if (f.status === 'saved') texts[f.path] = textOf(targets, f.path);
    else if (f.status === 'gone') texts[f.path] = null;
  context.store.getState().saved(context.epoch, texts);
  return report(context, files);
}

function cancelled({ store, now, folder }: SaveContext, files: FileOutcome[]): boolean {
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
}

const as = (paths: readonly string[], status: 'encoding' | 'conflict'): FileOutcome[] =>
  paths.map((path) => ({ path, status }));

const textOf = (targets: readonly SaveTarget[], path: string): string =>
  targets.find((t) => t.path === path)!.text;
