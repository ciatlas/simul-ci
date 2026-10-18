import { filterFiles, mayHoldProjectFiles } from './filter';
import { LIMITS } from './limits';

/**
 * A folder through the File System Access API (Chromium): the handle is kept, so Reload re-walks the checkout and a
 * later visit can ask to reopen it. Only the directories that can hold project files are entered.
 */

export const canPickFolder = (): boolean => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export interface PickedFolder {
  name: string;
  handle: FileSystemDirectoryHandle;
  files: Record<string, string>;
}

type Picker = (options: { id: string; mode: 'read' }) => Promise<FileSystemDirectoryHandle>;

/** Opens the picker; `undefined` when the author cancelled. Other failures throw a DOMException to show. */
export async function pickFolder(): Promise<PickedFolder | undefined> {
  const picker = (window as unknown as { showDirectoryPicker: Picker }).showDirectoryPicker;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await picker({ id: 'simulci-repo', mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return undefined;
    throw e;
  }
  return { name: handle.name, handle, files: await readFolder(handle) };
}

interface PermissionHandle {
  queryPermission?(d: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' }): Promise<PermissionState>;
}

/** Whether a stored handle can be read now, without asking. */
export async function canReadFolder(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  if (!h.queryPermission) return false;
  try {
    return (await h.queryPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/** Asks for read access again; must run in a click. */
export async function requestFolder(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  if (!h.requestPermission) return false;
  try {
    return (await h.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

/** The project files under a handle, by repository-relative path. */
export async function readFolder(root: FileSystemDirectoryHandle): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await walk(root, '', 0, files);
  return filterFiles(files);
}

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  files: Record<string, string>,
): Promise<void> {
  if (depth > LIMITS.depth) return;
  for await (const [name, handle] of entriesOf(dir)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (mayHoldProjectFiles(path)) await walk(handle, path, depth + 1, files);
    } else if (mayHoldProjectFiles(prefix) && /\.ya?ml$/i.test(name)) {
      const file = await handle.getFile();
      if (file.size <= LIMITS.fileBytes) files[path] = await file.text();
    }
  }
}

/** `entries()` is in the spec and in Chromium; the TS lib may lag. */
function entriesOf(
  dir: FileSystemDirectoryHandle,
): AsyncIterable<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
  return (
    dir as unknown as { entries(): AsyncIterable<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> }
  ).entries();
}
