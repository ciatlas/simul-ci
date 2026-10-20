import type { FileMeta } from '../input/read';
import { type KeyValueStore, openKeyValue } from '../lib/idb';
import type { Source } from './store';

/**
 * The source survives a reload in IndexedDB: paste buffers as they are (the crash snapshot), a folder as its handle
 * (which needs a click to re-grant), a sample by name. Files from a chosen folder (`webkitdirectory`) are a copy
 * with no handle, so they are stored as buffers too. Buffers keep the meta they were read with: their text no longer
 * shows a BOM or the bytes that were not UTF-8, and unlike a folder there is no disk to read them from again.
 */

export type StoredSource =
  | { kind: 'sample'; name: string }
  | {
      kind: 'paste';
      buffers: { path: string; text: string }[];
      meta?: Record<string, FileMeta>;
      /** An edited sample's buffers say which sample they are a copy of. */
      name?: string;
    }
  | { kind: 'folder'; name: string; handle: FileSystemDirectoryHandle }
  | {
      kind: 'copy';
      name: string;
      buffers: { path: string; text: string }[];
      meta?: Record<string, FileMeta>;
    };

export const DB_NAME = 'simulci-web';
export const STORE_NAME = 'source';
const CURRENT_KEY = 'current';

export interface SourceStore {
  load(): Promise<StoredSource | undefined>;
  save(source: Source, files: Record<string, string>, meta?: Record<string, FileMeta>): Promise<void>;
  clear(): Promise<void>;
}

export function sourceStore(kv: KeyValueStore = openKeyValue(DB_NAME, STORE_NAME)): SourceStore {
  return {
    load: async () => {
      try {
        const stored = await kv.get<StoredSource>(CURRENT_KEY);
        return isStoredSource(stored) ? withMeta(stored) : undefined;
      } catch {
        return undefined;
      }
    },
    save: async (source, files, meta) => {
      const stored = toStored(source, files, meta);
      try {
        if (stored) await kv.set(CURRENT_KEY, stored);
        else await kv.delete(CURRENT_KEY);
      } catch {
        // A refused write (private window, quota) only costs the author a reopen.
      }
    },
    clear: async () => {
      try {
        await kv.delete(CURRENT_KEY);
      } catch {
        // Nothing to clear then.
      }
    },
  };
}

export function toStored(
  source: Source,
  files: Record<string, string>,
  meta?: Record<string, FileMeta>,
): StoredSource | undefined {
  if (source.kind === 'sample') return { kind: 'sample', name: source.name };
  if (source.kind === 'paste')
    return {
      kind: 'paste',
      buffers: source.buffers,
      ...(meta && { meta }),
      ...(source.name === undefined ? {} : { name: source.name }),
    };
  if (source.kind === 'folder' && source.handle)
    return { kind: 'folder', name: source.name, handle: source.handle };
  if (source.kind === 'folder') {
    const buffers = Object.entries(files).map(([path, text]) => ({ path, text }));
    return { kind: 'copy', name: source.name, buffers, ...(meta && { meta }) };
  }
  return undefined;
}

const STORED_SHAPES: Record<string, (v: Record<string, unknown>) => boolean> = {
  sample: (v) => typeof v.name === 'string',
  paste: (v) => Array.isArray(v.buffers),
  copy: (v) => typeof v.name === 'string' && Array.isArray(v.buffers),
  folder: (v) => typeof v.name === 'string' && typeof v.handle === 'object' && v.handle !== null,
};

function isStoredSource(value: unknown): value is StoredSource {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const check =
    typeof v.kind === 'string' && Object.hasOwn(STORED_SHAPES, v.kind) ? STORED_SHAPES[v.kind] : undefined;
  return check !== undefined && check(v);
}

const EOLS: ReadonlySet<unknown> = new Set(['lf', 'crlf', 'mixed', 'none']);

function isFileMeta(value: unknown): value is FileMeta {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.bom === 'boolean' && typeof v.utf8 === 'boolean' && EOLS.has(v.eol);
}

/** Buffers with the stored meta entries that are one; any other is left out, so the store reads it from the text. */
function withMeta(stored: StoredSource): StoredSource {
  if (stored.kind !== 'paste' && stored.kind !== 'copy') return stored;
  const meta: Record<string, FileMeta> = {};
  for (const [path, m] of Object.entries(stored.meta ?? {})) if (isFileMeta(m)) meta[path] = m;
  return { ...stored, meta };
}
