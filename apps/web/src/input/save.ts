import { fileLabel } from '../lib/file-label';
import { stampOf } from '../state/history';
import { isProjectFile } from './filter';
import { asWritten, type FileMeta, readExact } from './read';

/**
 * Saving the edits back to the folder (synthesis § 5.3), over the few calls of the File System Access API it needs,
 * so a test drives it with a fake directory. Nothing is written until every file has been checked: each file to update
 * must still hold the text it was read (or last saved) with, BOM included, and each file to create must not be there.
 * A file that is not is a conflict, and nothing is written until the author has chosen for each one (§ 5.4). Then the
 * files are written one at a time, updates first and created files after them, workflows before tests, each through
 * a swap file the browser puts in place on `close()`; the first failure stops the save, and every file written is read
 * back before it counts as saved. Write permission is not asked here: it has to be asked first thing in the click or
 * the key that saves (`app/saver.ts`).
 */

/** What the save reads of a directory handle: Chromium's `FileSystemDirectoryHandle`, or a test's fake. */
export interface DirectoryLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
}

export interface FileHandleLike {
  getFile(): Promise<Blob>;
  createWritable(options: { keepExistingData: boolean }): Promise<WritableLike>;
}

export interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * A file to write: an edited file, with the text it was read or last saved with (`base`), or a file created since,
 * which has none. `bom` is the BOM the file is written with, as reading found it.
 */
export type SaveTarget =
  | { path: string; kind: 'update'; text: string; base: string; bom: boolean }
  | { path: string; kind: 'create'; text: string; bom: boolean };

/** What the folder holds at a path: its text and what reading found, or nothing. */
export interface DiskFile {
  text: string;
  meta: FileMeta;
}

/**
 * A file the folder does not hold as the edits expect: `changed-on-disk` and `deleted-on-disk` for an edited file
 * whose text, BOM or encoding is not the one it was read with, or that is gone; `exists` for a file to create that is
 * there. `mine` is the text here (none for a file removed here); `base` the text it was read with (none for a file
 * created here); `disk` what the folder holds now.
 */
export interface DiskConflict {
  path: string;
  reason: 'changed-on-disk' | 'deleted-on-disk' | 'exists';
  mine?: string;
  base?: string;
  disk?: DiskFile;
}

/**
 * What the author chose for a conflict: write `mine` over the folder, keep the `disk` version (the caller takes it
 * into the files first), or `skip` the file. A choice holds for the folder's file as it was when the author chose:
 * `stamp` is `diskStamp` of it, and a file that changed again is a conflict again.
 */
export type Choice = 'mine' | 'disk' | 'skip';

export type Choices = Readonly<Record<string, { choice: Choice; stamp: string }>>;

/**
 * What happened to one file: `saved` once read back, `failed` with the error's name, or why it was not written: after
 * a failure, skipped by the author, in a conflict the author cancelled, or `kept` in the folder though removed here.
 */
export type FileOutcome =
  | { path: string; status: 'saved' }
  | { path: string; status: 'failed'; error: string }
  | { path: string; status: 'not-attempted' | 'skipped' | 'conflict' | 'kept' };

export type SaveRun =
  | { kind: 'conflicts'; conflicts: DiskConflict[] }
  | { kind: 'done'; files: FileOutcome[] };

/** The name a read-back that does not give the bytes written fails with. */
const VERIFY_FAILED = 'VerifyFailed';

/** The fingerprint a choice is made against: the folder's file, text, BOM and encoding, or its absence. */
export function diskStamp(disk: DiskFile | undefined): string {
  if (!disk) return '-';
  return `${disk.meta.bom ? 'b' : ''}${disk.meta.utf8 ? '' : 'x'}:${stampOf(disk.text)}`;
}

/** A file to write, and whether the folder holds a file at its path now. */
interface Write {
  target: SaveTarget;
  exists: boolean;
}

/**
 * Checks every target, then writes them. Conflicts the choices do not settle (each for the folder's file as it is now)
 * come back and nothing is written; else every file is written in turn until one fails, and each is said: saved,
 * failed, not attempted after a failure, or skipped by the author's choice. A check that fails for another reason than
 * a missing file writes nothing either: that file failed, the others were not attempted.
 */
export async function saveTo(
  root: DirectoryLike,
  targets: readonly SaveTarget[],
  choices: Choices = {},
): Promise<SaveRun> {
  const writes: Write[] = [];
  const skipped: string[] = [];
  const conflicts: DiskConflict[] = [];
  for (const [i, target] of targets.entries()) {
    let checked: Checked;
    try {
      checked = await check(root, target);
    } catch (e) {
      const others = targets.filter((_, j) => j !== i).map((t) => t.path);
      return done([{ path: target.path, status: 'failed', error: nameOf(e) }], others);
    }
    if (!('reason' in checked)) {
      writes.push({ target, exists: checked.exists });
      continue;
    }
    const chosen = choices[target.path];
    if (!chosen || chosen.stamp !== diskStamp(checked.disk)) conflicts.push(checked);
    else if (chosen.choice === 'mine') writes.push({ target, exists: checked.disk !== undefined });
    else skipped.push(target.path);
  }
  if (conflicts.length > 0) return { kind: 'conflicts', conflicts };
  return done(await writeAll(root, writes), [], skipped);
}

/** The outcomes, then the files not attempted, then the ones skipped. */
function done(outcomes: FileOutcome[], notAttempted: string[], skipped: string[] = []): SaveRun {
  return {
    kind: 'done',
    files: [
      ...outcomes,
      ...notAttempted.map((path) => ({ path, status: 'not-attempted' as const })),
      ...skipped.map((path) => ({ path, status: 'skipped' as const })),
    ],
  };
}

/** A target the folder holds as expected (`exists`: a file is at its path), or the conflict it is. */
type Checked = { exists: boolean } | DiskConflict;

/**
 * Reads a target's file without creating anything on the way (a missing directory is a missing file): an edited file
 * must still be its base, a created one must not be there. A file that already holds the very bytes to write is no
 * conflict either.
 */
async function check(root: DirectoryLike, target: SaveTarget): Promise<Checked> {
  const disk = await readAt(root, target.path);
  if (!disk) return target.kind === 'create' ? { exists: false } : conflictOf(target, 'deleted-on-disk');
  if (
    holds(disk, target.text, target.bom) ||
    (target.kind === 'update' && holds(disk, target.base, target.bom))
  )
    return { exists: true };
  return conflictOf(target, target.kind === 'create' ? 'exists' : 'changed-on-disk', disk);
}

const holds = (disk: DiskFile, text: string, bom: boolean): boolean =>
  disk.text === text && disk.meta.bom === bom && disk.meta.utf8;

const conflictOf = (target: SaveTarget, reason: DiskConflict['reason'], disk?: DiskFile): DiskConflict => ({
  path: target.path,
  reason,
  mine: target.text,
  ...(target.kind === 'update' ? { base: target.base } : {}),
  ...(disk ? { disk } : {}),
});

/** The folder's file at a path, read byte-exact, or nothing when it (or a directory on its way) is not there. */
async function readAt(root: DirectoryLike, path: string): Promise<DiskFile | undefined> {
  try {
    const { dir, name } = await parentOf(root, path, false);
    return await readExact(await (await dir.getFileHandle(name)).getFile());
  } catch (e) {
    if (nameOf(e) === 'NotFoundError') return undefined;
    throw e;
  }
}

/** Updates first, then created files; project files (workflows, actions) before tests; by path within each. */
function order(writes: Write[]): Write[] {
  const rank = (w: Write): number => (w.exists ? 0 : 2) + (isProjectFile(w.target.path) ? 0 : 1);
  return writes.toSorted((a, b) => rank(a) - rank(b) || a.target.path.localeCompare(b.target.path));
}

/** Writes in turn until one fails; the files after it are not attempted. */
async function writeAll(root: DirectoryLike, writes: Write[]): Promise<FileOutcome[]> {
  const ordered = order(writes);
  const outcomes: FileOutcome[] = [];
  for (const [i, w] of ordered.entries()) {
    try {
      await writeOne(root, w);
    } catch (e) {
      outcomes.push({ path: w.target.path, status: 'failed', error: nameOf(e) });
      for (const after of ordered.slice(i + 1))
        outcomes.push({ path: after.target.path, status: 'not-attempted' });
      return outcomes;
    }
    outcomes.push({ path: w.target.path, status: 'saved' });
  }
  return outcomes;
}

/**
 * One file through a swap file: `createWritable` without the old data, the whole text with its BOM, `close()`, which
 * puts it in place; then read back. A failure before `close()` aborts the swap file, so the old bytes stay. A file
 * this write created, and the directories it made, go again when it fails, if they are still empty.
 */
async function writeOne(root: DirectoryLike, { target, exists }: Write): Promise<void> {
  const { dir, name, made } = await parentOf(root, target.path, !exists);
  let handle: FileHandleLike | undefined;
  try {
    handle = await dir.getFileHandle(name, { create: !exists });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(asWritten(target.text, target));
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => undefined);
      throw e;
    }
    const back = await readExact(await handle.getFile());
    if (back.text !== target.text || back.meta.bom !== target.bom)
      throw new DOMException(`${target.path} reads back other bytes`, VERIFY_FAILED);
  } catch (e) {
    if (!exists && nameOf(e) !== VERIFY_FAILED) await undoCreate(dir, name, handle, made);
    throw e;
  }
}

/** Removes the empty file a failed create left, then the directories it made, innermost first, while empty. */
async function undoCreate(
  dir: DirectoryLike,
  name: string,
  handle: FileHandleLike | undefined,
  made: { parent: DirectoryLike; name: string }[],
): Promise<void> {
  try {
    if (handle && (await handle.getFile()).size === 0) await dir.removeEntry(name);
    // Without `recursive`, a directory that holds anything is refused, so only an empty one goes.
    for (const m of made.toReversed()) await m.parent.removeEntry(m.name);
  } catch {
    // Best effort: what is left is empty.
  }
}

/** The directory a path's file is in, and its name; with `create`, the directories missing on the way are made. */
async function parentOf(
  root: DirectoryLike,
  path: string,
  create: boolean,
): Promise<{ dir: DirectoryLike; name: string; made: { parent: DirectoryLike; name: string }[] }> {
  const parts = path.split('/');
  const name = parts.pop()!;
  const made: { parent: DirectoryLike; name: string }[] = [];
  let dir = root;
  for (const part of parts) {
    let next: DirectoryLike;
    try {
      next = await dir.getDirectoryHandle(part);
    } catch (e) {
      if (!create || nameOf(e) !== 'NotFoundError') throw e;
      next = await dir.getDirectoryHandle(part, { create: true });
      made.push({ parent: dir, name: part });
    }
    dir = next;
  }
  return { dir, name, made };
}

/** A thrown value's name, as a DOMException carries it: `NotFoundError`, `NoModificationAllowedError`. */
function nameOf(e: unknown): string {
  if (e instanceof Error || e instanceof DOMException) return e.name;
  return 'Error';
}

/** Why a write failed, in words after its name: the hint a name allows. */
const HINT: Readonly<Record<string, string>> = {
  NoModificationAllowedError: 'is it open elsewhere?',
  NotAllowedError: 'writing is not allowed',
  NotFoundError: 'it is gone from the folder',
  QuotaExceededError: 'the disk is full',
  InvalidStateError: 'it changed while saving',
  TypeMismatchError: 'a folder has its name',
  [VERIFY_FAILED]: 'the folder holds other bytes than were written',
};

/** "NoModificationAllowedError, is it open elsewhere?" */
export const failure = (error: string): string => (HINT[error] ? `${error}, ${HINT[error]}` : error);

/**
 * The save said in one line (§ 5.3): "Saved ci.yml; deploy.yml failed (NoModificationAllowedError, is it open
 * elsewhere?); not attempted: ci.test.yml".
 */
export function reportSentence(files: readonly FileOutcome[]): string {
  const names = (status: FileOutcome['status']): string[] =>
    files.filter((f) => f.status === status).map((f) => fileLabel(f.path));
  const parts: string[] = [];
  const saved = names('saved');
  if (saved.length) parts.push(`Saved ${listOf(saved)}`);
  for (const f of files)
    if (f.status === 'failed') parts.push(`${fileLabel(f.path)} failed (${failure(f.error)})`);
  const notAttempted = names('not-attempted');
  if (notAttempted.length) parts.push(`not attempted: ${notAttempted.join(', ')}`);
  const skipped = names('skipped');
  if (skipped.length) parts.push(`skipped: ${skipped.join(', ')}`);
  const conflicts = names('conflict');
  if (conflicts.length) parts.push(`changed on disk: ${conflicts.join(', ')}`);
  const kept = names('kept');
  if (kept.length) parts.push(`still in the folder, since a save deletes nothing: ${kept.join(', ')}`);
  return parts.length ? parts.join('; ') : 'Nothing to save';
}

/** "a", "a and b", "a, b and c". */
export const listOf = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
