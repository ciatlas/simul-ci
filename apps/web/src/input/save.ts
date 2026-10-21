import { fileLabel } from '../lib/file-label';
import { isProjectFile } from './filter';
import { asWritten, decodeExact, type FileMeta } from './read';

/**
 * Saving the edits back to the folder (synthesis § 5.3), over the few calls of the File System Access API it needs,
 * so a test drives it with a fake directory. Nothing is written until every file has been checked: each file to update
 * must still hold the text it was read (or last saved) with, BOM included, and each file to create must not be there.
 * A file that is not is a conflict, and nothing is written until the author has chosen for each one (§ 5.4). Then the
 * files are written one at a time, updates first and created files after them, workflows before tests, each through
 * a swap file the browser puts in place on `close()`; the first failure stops the save, and every file written is read
 * back before it counts as saved. Files are compared as written, BOM in front, so a text that starts with U+FEFF and a
 * BOM read off the bytes are the same file. A file removed here is never deleted from the folder. Write permission is
 * not asked here: it has to be asked first thing in the click or the key that saves (`app/saver.ts`).
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
 * created here); `disk` what the folder holds now, and `stamp` a SHA-256 of its bytes (`-` when there is none), which
 * a choice is made against.
 */
export interface DiskConflict {
  path: string;
  reason: 'changed-on-disk' | 'deleted-on-disk' | 'exists';
  mine?: string;
  base?: string;
  disk?: DiskFile;
  stamp?: string;
}

/**
 * What the author chose for a conflict: write `mine` over the folder, keep the `disk` version (the caller takes it
 * into the files first), or `skip` the file. A choice holds for the folder's file as it was when the author chose:
 * `stamp` is the conflict's, and a file whose bytes changed again is a conflict again.
 */
export type Choice = 'mine' | 'disk' | 'skip';

export type Choices = Readonly<Record<string, { choice: Choice; stamp: string }>>;

/**
 * What happened to one file: `saved` once read back, `failed` with the error's name, or why it was not written: after
 * a failure, skipped by the author, in a conflict the author cancelled, settled by keeping the `disk` version, not
 * UTF-8 (`encoding`, never written). A file removed here is `kept` while the folder still has it, `gone` once the
 * folder has not either.
 */
export type FileOutcome =
  | { path: string; status: 'saved' }
  | { path: string; status: 'failed'; error: string }
  | {
      path: string;
      status: 'not-attempted' | 'skipped' | 'conflict' | 'disk' | 'encoding' | 'kept' | 'gone';
    };

export type SaveRun =
  | { kind: 'conflicts'; conflicts: DiskConflict[] }
  | { kind: 'done'; files: FileOutcome[] };

/** The name a read-back that does not give the bytes written fails with. */
const VERIFY_FAILED = 'VerifyFailed';

const encoder = new TextEncoder();

/** The hex SHA-256 of a file's bytes: what a choice is made against. */
async function digestOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
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
 * a missing file writes nothing either: that file failed, the others were not attempted. The files removed here are
 * only looked for: `kept` when the folder has one, `gone` when it has not.
 */
export async function saveTo(
  root: DirectoryLike,
  targets: readonly SaveTarget[],
  { choices = {}, removed = [], alive = () => true }: SaveOptions = {},
): Promise<SaveRun> {
  const left = await removedOutcomes(root, removed);
  const run = await checkAndWrite(root, targets, choices, alive);
  return run.kind === 'done' ? { kind: 'done', files: [...run.files, ...left] } : run;
}

export interface SaveOptions {
  /** The author's choices for the conflicts of an earlier round. */
  choices?: Choices;
  /** The files removed here, only looked for. */
  removed?: readonly string[];
  /** Asked before each write: once false (the files were replaced), the rest are not attempted. */
  alive?: () => boolean;
}

/** Whether the folder still has each file removed here; one that cannot be read is taken as there. */
async function removedOutcomes(root: DirectoryLike, removed: readonly string[]): Promise<FileOutcome[]> {
  const outcomes: FileOutcome[] = [];
  for (const path of removed) {
    const there = await readAt(root, path).then(
      (read) => read !== undefined,
      () => true,
    );
    outcomes.push({ path, status: there ? 'kept' : 'gone' });
  }
  return outcomes;
}

async function checkAndWrite(
  root: DirectoryLike,
  targets: readonly SaveTarget[],
  choices: Choices,
  alive: () => boolean,
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
    if (!chosen || chosen.stamp !== checked.stamp) conflicts.push(checked);
    else if (chosen.choice === 'mine') writes.push({ target, exists: checked.disk !== undefined });
    else skipped.push(target.path);
  }
  if (conflicts.length > 0) return { kind: 'conflicts', conflicts };
  return done(await writeAll(root, writes, alive), [], skipped);
}

const unattempted = (path: string): FileOutcome => ({ path, status: 'not-attempted' });

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
  const read = await readAt(root, target.path);
  if (!read) return target.kind === 'create' ? { exists: false } : conflictOf(target, 'deleted-on-disk');
  if (
    holds(read, target.text, target.bom) ||
    (target.kind === 'update' && holds(read, target.base, target.bom))
  )
    return { exists: true };
  return conflictOf(target, target.kind === 'create' ? 'exists' : 'changed-on-disk', read);
}

/** Whether the folder's file is, byte for byte, this text written with or without a BOM. */
const holds = (read: Read, text: string, bom: boolean): boolean =>
  read.meta.utf8 && asWritten(read.text, read.meta) === asWritten(text, { bom });

async function conflictOf(
  target: SaveTarget,
  reason: DiskConflict['reason'],
  read?: Read,
): Promise<DiskConflict> {
  const conflict: DiskConflict = { path: target.path, reason, mine: target.text, stamp: '-' };
  if (target.kind === 'update') conflict.base = target.base;
  if (read) {
    conflict.disk = { text: read.text, meta: read.meta };
    conflict.stamp = await digestOf(read.bytes);
  }
  return conflict;
}

/** A file as the folder holds it: its bytes, and their text as `readExact` gives it. */
interface Read extends DiskFile {
  bytes: Uint8Array<ArrayBuffer>;
}

/** The folder's file at a path, read byte-exact, or nothing when it (or a directory on its way) is not there. */
async function readAt(root: DirectoryLike, path: string): Promise<Read | undefined> {
  try {
    const dir = await parentOf(root, path, false, []);
    const bytes = new Uint8Array(
      await (await (await dir.getFileHandle(nameIn(path))).getFile()).arrayBuffer(),
    );
    return { ...decodeExact(bytes), bytes };
  } catch (e) {
    if (nameOf(e) === 'NotFoundError') return undefined;
    throw e;
  }
}

const nameIn = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Updates first, then created files; project files (workflows, actions) before tests; by path within each. */
function order(writes: Write[]): Write[] {
  const rank = (w: Write): number => (w.exists ? 0 : 2) + (isProjectFile(w.target.path) ? 0 : 1);
  return writes.toSorted((a, b) => rank(a) - rank(b) || a.target.path.localeCompare(b.target.path));
}

/** Writes in turn until one fails; the files after it are not attempted. */
async function writeAll(root: DirectoryLike, writes: Write[], alive: () => boolean): Promise<FileOutcome[]> {
  const ordered = order(writes);
  const outcomes: FileOutcome[] = [];
  for (const [i, w] of ordered.entries()) {
    if (!alive()) return [...outcomes, ...ordered.slice(i).map((x) => unattempted(x.target.path))];
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
 * puts it in place; then read back, byte for byte. A failure before `close()` aborts the swap file, so the old bytes
 * stay. A file this write created, and the directories it made, go again when it fails, if they are still empty.
 */
async function writeOne(root: DirectoryLike, { target, exists }: Write): Promise<void> {
  const made: Made[] = [];
  const name = nameIn(target.path);
  let dir: DirectoryLike | undefined;
  let handle: FileHandleLike | undefined;
  try {
    dir = await parentOf(root, target.path, !exists, made);
    handle = await dir.getFileHandle(name, { create: !exists });
    const written = asWritten(target.text, target);
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(written);
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => undefined);
      throw e;
    }
    const back = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    if (!sameBytes(back, encoder.encode(written)))
      throw new DOMException(`${target.path} reads back other bytes`, VERIFY_FAILED);
  } catch (e) {
    if (!exists && nameOf(e) !== VERIFY_FAILED) await undoCreate(dir, name, handle, made);
    throw e;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** A directory a create made, in its parent. */
interface Made {
  parent: DirectoryLike;
  name: string;
}

/** Removes the empty file a failed create left, then the directories it made, innermost first, while empty. */
async function undoCreate(
  dir: DirectoryLike | undefined,
  name: string,
  handle: FileHandleLike | undefined,
  made: Made[],
): Promise<void> {
  try {
    if (dir && handle && (await handle.getFile()).size === 0) await dir.removeEntry(name);
    // Without `recursive`, a directory that holds anything is refused, so only an empty one goes.
    for (const m of made.toReversed()) await m.parent.removeEntry(m.name);
  } catch {
    // Best effort: what is left is empty.
  }
}

/**
 * The directory a path's file is in; with `create`, the directories missing on the way are made, each recorded in
 * `made` as it is, so a failure further on can take them back.
 */
async function parentOf(
  root: DirectoryLike,
  path: string,
  create: boolean,
  made: Made[],
): Promise<DirectoryLike> {
  let dir = root;
  for (const part of path.split('/').slice(0, -1)) {
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
  return dir;
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
  const disk = names('disk');
  if (disk.length) parts.push(`${saved.length ? 'kept' : 'Kept'} the disk version of ${listOf(disk)}`);
  for (const f of files)
    if (f.status === 'failed') parts.push(`${fileLabel(f.path)} failed (${failure(f.error)})`);
  for (const [status, words] of LISTED) {
    const listed = names(status);
    if (listed.length) parts.push(`${words}: ${listed.join(', ')}`);
  }
  return parts.length ? parts.join('; ') : 'Nothing to save';
}

/** The statuses the sentence lists after the saved, kept and failed files, and how it introduces them. */
const LISTED: readonly [FileOutcome['status'], string][] = [
  ['not-attempted', 'not attempted'],
  ['skipped', 'skipped'],
  ['conflict', 'changed on disk'],
  ['encoding', 'not UTF-8, never written'],
  ['kept', 'removed here, not from the folder (a save deletes nothing)'],
  ['gone', 'removed here and from the folder'],
];

/** "a", "a and b", "a, b and c". */
export const listOf = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
