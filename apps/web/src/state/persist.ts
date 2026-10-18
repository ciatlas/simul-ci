import { type KeyValueStore, openKeyValue } from '../lib/idb';
import type { Source } from './store';

/**
 * The source survives a reload in IndexedDB: paste buffers as they are (the crash snapshot), a folder as its handle
 * (which needs a click to re-grant), a sample by name. Files from a chosen folder (`webkitdirectory`) are a copy
 * with no handle, so they are stored as buffers too.
 */

export type StoredSource =
  | { kind: 'sample'; name: string }
  | { kind: 'paste'; buffers: { path: string; text: string }[] }
  | { kind: 'folder'; name: string; handle: FileSystemDirectoryHandle }
  | { kind: 'copy'; name: string; buffers: { path: string; text: string }[] };

const DB_NAME = 'simulci-web';
const STORE_NAME = 'source';
const CURRENT_KEY = 'current';

export interface SourceStore {
  load(): Promise<StoredSource | undefined>;
  save(source: Source, files: Record<string, string>): Promise<void>;
  clear(): Promise<void>;
}

export function sourceStore(kv: KeyValueStore = openKeyValue(DB_NAME, STORE_NAME)): SourceStore {
  return {
    load: async () => {
      try {
        const stored = await kv.get<StoredSource>(CURRENT_KEY);
        return isStoredSource(stored) ? stored : undefined;
      } catch {
        return undefined;
      }
    },
    save: async (source, files) => {
      const stored = toStored(source, files);
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

export function toStored(source: Source, files: Record<string, string>): StoredSource | undefined {
  if (source.kind === 'sample') return { kind: 'sample', name: source.name };
  if (source.kind === 'paste') return { kind: 'paste', buffers: source.buffers };
  if (source.kind === 'folder' && source.handle)
    return { kind: 'folder', name: source.name, handle: source.handle };
  if (source.kind === 'folder') {
    const buffers = Object.entries(files).map(([path, text]) => ({ path, text }));
    return { kind: 'copy', name: source.name, buffers };
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
  const check = typeof v.kind === 'string' ? STORED_SHAPES[v.kind] : undefined;
  return check !== undefined && check(v);
}
