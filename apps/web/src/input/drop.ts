import { isProjectFile, mayHoldProjectFiles } from './filter';
import { LIMITS } from './limits';

/**
 * A drop of a folder or of workflow files. A dropped folder is walked through its handle where the browser gives one
 * (Chromium, so Reload works) and through the older entry API elsewhere; dropped `.yml` files become workflows by
 * their names.
 */

export interface Dropped {
  name?: string;
  handle?: FileSystemDirectoryHandle;
  files: Record<string, string>;
}

type ItemWithHandle = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };

export async function filesFromDrop(transfer: DataTransfer): Promise<Dropped> {
  const files: Record<string, string> = {};
  let name: string | undefined;
  let handle: FileSystemDirectoryHandle | undefined;
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue;
    const h = await handleOf(item);
    if (h?.kind === 'directory') {
      const dir = h as FileSystemDirectoryHandle;
      name ??= dir.name;
      handle ??= dir;
      await walkHandle(dir, '', 0, files);
      continue;
    }
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      name ??= entry.name;
      await walkEntry(entry as FileSystemDirectoryEntry, '', 0, files);
      continue;
    }
    const file = item.getAsFile();
    if (file && /\.ya?ml$/i.test(file.name) && file.size <= LIMITS.fileBytes)
      files[`.github/workflows/${file.name}`] = await file.text();
  }
  const out: Dropped = { files };
  if (name !== undefined) out.name = name;
  if (handle) out.handle = handle;
  return out;
}

async function handleOf(item: ItemWithHandle): Promise<FileSystemHandle | null> {
  if (!item.getAsFileSystemHandle) return null;
  try {
    return await item.getAsFileSystemHandle();
  } catch {
    return null;
  }
}

async function walkHandle(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  depth: number,
  files: Record<string, string>,
): Promise<void> {
  if (depth > LIMITS.depth) return;
  const entries = (
    dir as unknown as { entries(): AsyncIterable<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> }
  ).entries();
  for await (const [entryName, h] of entries) {
    const path = prefix ? `${prefix}/${entryName}` : entryName;
    if (h.kind === 'directory') {
      if (mayHoldProjectFiles(path)) await walkHandle(h, path, depth + 1, files);
    } else if (isProjectFile(path)) {
      const file = await h.getFile();
      if (file.size <= LIMITS.fileBytes) files[path] = await file.text();
    }
  }
}

/** `readEntries` returns a batch at a time and an empty one at the end. */
function allEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = (): void =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

const fileOf = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

async function walkEntry(
  dir: FileSystemDirectoryEntry,
  prefix: string,
  depth: number,
  files: Record<string, string>,
): Promise<void> {
  if (depth > LIMITS.depth) return;
  for (const entry of await allEntries(dir)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      if (mayHoldProjectFiles(path))
        await walkEntry(entry as FileSystemDirectoryEntry, path, depth + 1, files);
    } else if (isProjectFile(path)) {
      const file = await fileOf(entry as FileSystemFileEntry);
      if (file.size <= LIMITS.fileBytes) files[path] = await file.text();
    }
  }
}
