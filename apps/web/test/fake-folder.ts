import type { DirectoryLike } from '../src/input/save';

/**
 * A folder as Chromium's File System Access API gives it, in memory: directory and file handles over one map of paths
 * to bytes, read by the walk (`entries`, `getFile`) and written by the save (`getDirectoryHandle`, `getFileHandle`,
 * `createWritable`, `removeEntry`). A writable stream writes to a swap file: the bytes reach the file on `close()`
 * only, and `abort()` drops them, as Chromium does. Failures are injected per call and path; `calls` records what the
 * save did, so a test can say nothing was written.
 */

type Bytes = Uint8Array<ArrayBuffer>;
type Op = 'getFile' | 'getFileHandle' | 'createWritable' | 'write' | 'close';

export interface FakeOptions {
  name?: string;
  /** What `requestPermission` answers; `throws` is the SecurityError of a request outside a gesture. */
  permission?: PermissionState | 'throws';
  /** What `queryPermission` answers. */
  query?: PermissionState;
  /** The `op` on `path` throws a DOMException named `error`, the first `times` calls (once by default). */
  fail?: { op: Op; path: string; error: string; times?: number }[];
  /** After a write of `path` closes, the file holds these bytes instead: what a read-back would catch. */
  rewrite?: Record<string, string | Bytes>;
  /** Runs before each call, so a test can change the folder in the middle of a save. */
  before?: (call: string, folder: FakeFolder) => void;
}

export interface FakeFolder {
  handle: FileSystemDirectoryHandle & DirectoryLike;
  files: Map<string, Bytes>;
  dirs: Set<string>;
  /** Every call that changed something or asked: `requestPermission`, `mkdir a`, `create a/b`, `close a/b`, `abort a/b`. */
  calls: string[];
  /** The paths whose writes closed, in order. */
  written: string[];
  /** A file's bytes as text, a BOM shown as U+FEFF. */
  text(path: string): string | undefined;
  /** Puts a file in the folder, making its directories. */
  set(path: string, content: string | Bytes): void;
  /** Injects a failure from now on, as `FakeOptions.fail` does from the start. */
  fail(failure: NonNullable<FakeOptions['fail']>[number]): void;
  remove(path: string): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const bytesOf = (content: string | Bytes): Bytes =>
  typeof content === 'string' ? encoder.encode(content) : content;
const dom = (name: string, message = name): DOMException => new DOMException(message, name);
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** A UTF-8 BOM and the text: what a file read with a BOM holds. */
export const withBom = (text: string): Bytes => new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(text)]);

export function fakeFolder(tree: Record<string, string | Bytes>, options: FakeOptions = {}): FakeFolder {
  const failures: (NonNullable<FakeOptions['fail']>[number] & { left: number })[] = [];
  for (const f of options.fail ?? []) failures.push(Object.assign({ left: f.times ?? 1 }, f));
  const folder: FakeFolder = {
    handle: undefined as never,
    files: new Map(),
    dirs: new Set(['']),
    calls: [],
    written: [],
    text: (path) => {
      const b = folder.files.get(path);
      return b === undefined ? undefined : decoder.decode(b);
    },
    set: (path, content) => {
      let dir = parentOf(path);
      while (dir && !folder.dirs.has(dir)) {
        folder.dirs.add(dir);
        dir = parentOf(dir);
      }
      folder.files.set(path, bytesOf(content));
    },
    remove: (path) => {
      folder.files.delete(path);
    },
    fail: (f) => {
      failures.push(Object.assign({ left: f.times ?? 1 }, f));
    },
  };
  for (const [path, content] of Object.entries(tree)) folder.set(path, content);

  const step = (op: string, path: string): void => {
    options.before?.(`${op} ${path}`, folder);
    const f = failures.find((x) => x.op === op && x.path === path && x.left > 0);
    if (!f) return;
    f.left--;
    throw dom(f.error, `${op} ${path} failed`);
  };

  const fileHandle = (path: string) => ({
    kind: 'file' as const,
    name: path.slice(path.lastIndexOf('/') + 1),
    getFile: async () => {
      step('getFile', path);
      const bytes = folder.files.get(path);
      if (!bytes) throw dom('NotFoundError');
      return new Blob([bytes]);
    },
    createWritable: async ({ keepExistingData }: { keepExistingData: boolean }) => {
      step('createWritable', path);
      if (!folder.files.has(path)) throw dom('NotFoundError');
      let swap: Bytes[] = keepExistingData ? [folder.files.get(path)!] : [];
      let open = true;
      return {
        write: async (data: string) => {
          if (!open) throw dom('InvalidStateError');
          step('write', path);
          swap.push(bytesOf(data));
        },
        close: async () => {
          if (!open) throw dom('InvalidStateError');
          step('close', path);
          open = false;
          if (!folder.dirs.has(parentOf(path))) throw dom('NotFoundError');
          const rewrite = options.rewrite?.[path];
          folder.files.set(path, rewrite === undefined ? concat(swap) : bytesOf(rewrite));
          folder.written.push(path);
          folder.calls.push(`close ${path}`);
        },
        abort: async () => {
          open = false;
          swap = [];
          folder.calls.push(`abort ${path}`);
        },
      };
    },
  });

  const dirHandle = (dir: string): FileSystemDirectoryHandle & DirectoryLike => {
    const handle = {
      kind: 'directory' as const,
      name: dir === '' ? (options.name ?? 'repo') : dir.slice(dir.lastIndexOf('/') + 1),
      queryPermission: async () => options.query ?? 'granted',
      requestPermission: async () => {
        folder.calls.push('requestPermission');
        if (options.permission === 'throws') throw dom('SecurityError', 'User activation is required');
        return options.permission ?? 'granted';
      },
      getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
        const path = join(dir, name);
        options.before?.(`getDirectoryHandle ${path}`, folder);
        if (folder.files.has(path)) throw dom('TypeMismatchError');
        if (!folder.dirs.has(path)) {
          if (!opts?.create) throw dom('NotFoundError');
          folder.dirs.add(path);
          folder.calls.push(`mkdir ${path}`);
        }
        return dirHandle(path);
      },
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        const path = join(dir, name);
        step('getFileHandle', path);
        if (folder.dirs.has(path)) throw dom('TypeMismatchError');
        if (!folder.files.has(path)) {
          if (!opts?.create) throw dom('NotFoundError');
          folder.files.set(path, new Uint8Array(0));
          folder.calls.push(`create ${path}`);
        }
        return fileHandle(path);
      },
      removeEntry: async (name: string) => {
        const path = join(dir, name);
        if (folder.files.delete(path)) {
          folder.calls.push(`remove ${path}`);
          return;
        }
        if (!folder.dirs.has(path)) throw dom('NotFoundError');
        const busy = [...folder.files.keys(), ...folder.dirs].some((p) => p.startsWith(`${path}/`));
        if (busy) throw dom('InvalidModificationError');
        folder.dirs.delete(path);
        folder.calls.push(`rmdir ${path}`);
      },
      isSameEntry: async (other: unknown) => other === handle,
      async *entries() {
        const names = new Set<string>();
        for (const p of [...folder.dirs, ...folder.files.keys()])
          if (p !== dir && parentOf(p) === dir) names.add(p.slice(dir ? dir.length + 1 : 0));
        for (const name of names) {
          const path = join(dir, name);
          yield [name, folder.dirs.has(path) ? dirHandle(path) : fileHandle(path)] as const;
        }
      },
    };
    return handle as unknown as FileSystemDirectoryHandle & DirectoryLike;
  };
  folder.handle = dirHandle('');
  return folder;
}

function concat(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
