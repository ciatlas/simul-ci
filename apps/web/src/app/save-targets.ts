import type { SaveTarget } from '../input/save';
import { dirtyPaths, type SessionState } from '../state/store';

/**
 * The files a save writes: each unsaved file that is still here, as an update of its base or as a file created since.
 * A file removed here is not deleted from the folder, only looked for (`removed`). A file that is not UTF-8 is never
 * written (`encoding`): its text is not what the file holds.
 */
export function targetsOf(files: SessionState['files']): {
  targets: SaveTarget[];
  removed: string[];
  encoding: string[];
} {
  const targets: SaveTarget[] = [];
  const removed: string[] = [];
  const encoding: string[] = [];
  for (const path of dirtyPaths(files).sort()) {
    const text = files.byPath[path];
    const meta = files.meta[path];
    if (text === undefined) removed.push(path);
    else if (meta?.utf8 === false) encoding.push(path);
    else {
      const base = files.base[path];
      const bom = meta?.bom ?? false;
      targets.push(
        base === undefined ? { path, kind: 'create', text, bom } : { path, kind: 'update', text, base, bom },
      );
    }
  }
  return { targets, removed, encoding };
}
