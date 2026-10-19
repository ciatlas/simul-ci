/** A key-value store over IndexedDB; a memory map where IndexedDB is missing (tests, some private windows). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function openKeyValue(dbName: string, storeName: string): KeyValueStore {
  if (typeof indexedDB === 'undefined') return memoryStore();
  let opened: Promise<IDBDatabase> | undefined;
  const db = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.addEventListener('upgradeneeded', () => request.result.createObjectStore(storeName));
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () =>
        reject(request.error ?? new Error('IndexedDB refused to open')),
      );
      request.addEventListener('blocked', () => reject(new Error('IndexedDB is blocked by another tab')));
    });
    return opened;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const store = (await db()).transaction(storeName, mode).objectStore(storeName);
    return new Promise<T>((resolve, reject) => {
      const request = op(store);
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')));
    });
  };
  return {
    get: <T>(key: string) => run('readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
    set: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key));
    },
    delete: async (key) => {
      await run('readwrite', (s) => s.delete(key));
    },
  };
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}
