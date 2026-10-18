import { isProjectFile, normalizePath } from './filter';
import { LIMITS } from './limits';

/**
 * A folder through `<input type="file" webkitdirectory>`: every browser has it, the files are a copy (no handle, no
 * reload) and the first path segment is the folder's own name. Only the files the engine takes are read.
 */

export interface PickedFiles {
  /** The folder's name, from the first path segment. */
  name?: string;
  files: Record<string, string>;
}

export async function filesFromList(list: ArrayLike<File>): Promise<PickedFiles> {
  const files: Record<string, string> = {};
  let name: string | undefined;
  for (const file of Array.from(list)) {
    const relative = normalizePath(file.webkitRelativePath || file.name);
    const slash = relative.indexOf('/');
    if (slash === -1) {
      // A loose file, as a multiple-file input or a drop gives them: taken as a workflow by its name.
      if (/\.ya?ml$/i.test(relative)) await read(file, `.github/workflows/${relative}`, files);
      continue;
    }
    name ??= relative.slice(0, slash);
    const path = relative.slice(slash + 1);
    if (isProjectFile(path)) await read(file, path, files);
  }
  return name === undefined ? { files } : { name, files };
}

async function read(file: File, path: string, files: Record<string, string>): Promise<void> {
  if (file.size > LIMITS.fileBytes) return;
  files[path] = await file.text();
}
