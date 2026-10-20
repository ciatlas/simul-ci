import { regionEdit } from '@simulci/document/edits';
import type { FileMeta } from '../input/read';
import { type KeyValueStore, openKeyValue } from '../lib/idb';
import { stampOf, type TxFile } from './history';
import { DB_NAME, STORE_NAME } from './persist';
import { dirtyPaths, type RestoreConflict, type SessionState, type Source } from './store';

/**
 * The crash snapshot (synthesis § 5.6): a folder's unsaved edits survive a closed tab, a crash or a reload. Its files
 * stay on disk, so the source store keeps only its handle (or, for a copy, the buffers as read); the edits are kept
 * apart, under `edits` in the same IndexedDB store: per dirty file the fingerprint of the text it was edited from and
 * the text now. Pasted and edited-sample buffers need none: they carry their edits themselves (`state/buffers.ts`).
 *
 * When a folder's files come in, from the last visit, after Reopen, or picked again, the snapshot that belongs to it
 * comes back: every file whose text is still the one it was edited from, as one undoable `restore` entry; every
 * other as a conflict the author settles, Restore mine or Keep disk. Until then the writer waits, so typing cannot
 * replace edits not yet restored.
 */

export interface EditsSnapshot {
  v: 1;
  source: { kind: 'folder' | 'copy'; name: string; handle?: FileSystemDirectoryHandle };
  /** Per dirty file that was read: the stamp of the text it was edited from, its text now, what reading found. */
  files: Record<string, { base: string; text: string; meta: FileMeta }>;
  /** Files created since they were read, by path. */
  created: Record<string, string>;
  at: number;
}

const EDITS_KEY = 'edits';

export interface SnapshotStore {
  load(): Promise<EditsSnapshot | undefined>;
  save(snapshot: EditsSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export function snapshotStore(kv: KeyValueStore = openKeyValue(DB_NAME, STORE_NAME)): SnapshotStore {
  return {
    load: async () => {
      try {
        const stored = await kv.get<unknown>(EDITS_KEY);
        return isSnapshot(stored) ? stored : undefined;
      } catch {
        return undefined;
      }
    },
    save: async (snapshot) => {
      try {
        await kv.set(EDITS_KEY, snapshot);
      } catch {
        // A refused write (private window, quota): the edits are still on the page.
      }
    },
    clear: async () => {
      try {
        await kv.delete(EDITS_KEY);
      } catch {
        // Nothing to clear then.
      }
    },
  };
}

function isSnapshot(value: unknown): value is EditsSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    isSnapshotSource(v.source) &&
    isRecordOf(v.files, isSnapshotFile) &&
    isRecordOf(v.created, (t) => typeof t === 'string') &&
    typeof v.at === 'number'
  );
}

function isSnapshotSource(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Record<string, unknown>;
  return (source.kind === 'folder' || source.kind === 'copy') && typeof source.name === 'string';
}

const isRecordOf = (value: unknown, each: (v: unknown) => boolean): boolean =>
  typeof value === 'object' && value !== null && Object.values(value).every(each);

function isSnapshotFile(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.base === 'string' && typeof f.text === 'string' && typeof f.meta === 'object' && f.meta !== null
  );
}

/** The snapshot of the store's edits, or undefined when its source is no folder or nothing is unsaved. */
export function snapshotOf(s: Pick<SessionState, 'source' | 'files'>, at: number): EditsSnapshot | undefined {
  const { source, files } = s;
  if (source.kind !== 'folder') return undefined;
  const dirty = dirtyPaths(files);
  if (dirty.length === 0) return undefined;
  const snapshot: EditsSnapshot = {
    v: 1,
    source: source.handle
      ? { kind: 'folder', name: source.name, handle: source.handle }
      : { kind: 'copy', name: source.name },
    files: {},
    created: {},
    at,
  };
  for (const path of dirty) {
    const text = files.byPath[path];
    const base = files.base[path];
    // A file removed since it was read has nothing to keep: its text is on disk.
    if (text === undefined) continue;
    if (base === undefined) snapshot.created[path] = text;
    else snapshot.files[path] = { base: stampOf(base), text, meta: files.meta[path]! };
  }
  return snapshot;
}

/** Whether a snapshot was taken of this source: the same directory for a folder, the same name for a copy. */
export async function belongs(snapshot: EditsSnapshot, source: Source): Promise<boolean> {
  if (source.kind !== 'folder' || snapshot.source.name !== source.name) return false;
  if (snapshot.source.kind === 'copy') return source.handle === undefined;
  const stored = snapshot.source.handle;
  if (!stored || !source.handle) return false;
  try {
    return await source.handle.isSameEntry(stored);
  } catch {
    return false;
  }
}

/** What a snapshot brings back to the files as they are: edits that apply cleanly, and the files to settle. */
export interface RestorePlan {
  files: TxFile[];
  conflicts: RestoreConflict[];
}

/**
 * A file comes back when its text is still the one it was edited from (and its BOM as read): the disk did not
 * change, and nothing was typed since. A file created since comes back when its path is still free. Any other file
 * is a conflict: the disk, or the author, moved on.
 */
export function restorePlan(snapshot: EditsSnapshot, files: SessionState['files']): RestorePlan {
  const plan: RestorePlan = { files: [], conflicts: [] };
  for (const [path, f] of Object.entries(snapshot.files)) {
    const current = files.byPath[path];
    if (current === f.text) continue;
    if (cleanly(files, path, f))
      plan.files.push({ path, edits: [regionEdit(current!, f.text)], expect: stampOf(current!) });
    else plan.conflicts.push({ path, text: f.text, reason: current === undefined ? 'gone' : 'changed' });
  }
  for (const [path, text] of Object.entries(snapshot.created)) {
    const current = files.byPath[path];
    if (current === text) continue;
    if (current === undefined)
      plan.files.push({ path, edits: [{ from: 0, to: 0, insert: text }], create: true });
    else plan.conflicts.push({ path, text, reason: 'exists' });
  }
  return plan;
}

/** Whether a file is still the text the snapshot's edits were made to, as read, BOM included, and untouched since. */
function cleanly(files: SessionState['files'], path: string, kept: EditsSnapshot['files'][string]): boolean {
  const current = files.byPath[path];
  const base = files.base[path];
  if (current === undefined || current !== base) return false;
  return stampOf(base) === kept.base && files.meta[path]?.bom === kept.meta.bom;
}

/** "14:02": when the snapshot was taken, as the notice says it. */
export const clockOf = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
