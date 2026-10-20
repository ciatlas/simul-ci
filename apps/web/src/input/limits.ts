import { type FileMeta, readExact } from './read';

/**
 * What a source may hold before the page refuses it: the engine is fast, the browser's memory is the limit. A walk
 * does not read a file over the per-file limit: it keeps the rest and names what it left out.
 */
export const LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  files: 2000,
  /** Directory depth under the repository root a walk enters. */
  depth: 8,
} as const;

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) ? 1 : 0)} MB`;

/** Why a set of files is refused, or nothing. */
export function overLimit(files: Record<string, string>): string | undefined {
  const paths = Object.keys(files);
  if (paths.length > LIMITS.files) return `${paths.length} files; the page takes at most ${LIMITS.files}`;
  let total = 0;
  for (const path of paths) {
    const size = files[path]?.length ?? 0;
    if (size > LIMITS.fileBytes)
      return `${path} is ${mb(size)}; a file may be at most ${mb(LIMITS.fileBytes)}`;
    total += size;
  }
  if (total > LIMITS.totalBytes)
    return `${mb(total)} in all; the page takes at most ${mb(LIMITS.totalBytes)}`;
  return undefined;
}

/** A project file a walk did not read for its size. */
export interface Skipped {
  path: string;
  bytes: number;
}

/**
 * What a walk gathered: the project files it read, by path, what reading each one found (its BOM, line endings and
 * whether it is UTF-8), and the ones it left out.
 */
export interface Walked {
  files: Record<string, string>;
  meta: Record<string, FileMeta>;
  skipped: Skipped[];
}

/**
 * Reads a project file into the walk byte-exact, its meta beside its text, or leaves it out when it is over the
 * per-file limit; true when it read it.
 */
export async function readWithin(file: Blob, path: string, walked: Walked): Promise<boolean> {
  if (file.size > LIMITS.fileBytes) {
    walked.skipped.push({ path, bytes: file.size });
    return false;
  }
  const { text, meta } = await readExact(file);
  walked.files[path] = text;
  walked.meta[path] = meta;
  return true;
}

const NAMED = 3;

/** The files a walk left out, in the words of the per-file limit. */
export function leftOut(skipped: Skipped[]): string {
  const named = skipped.slice(0, NAMED).map((s) => `${s.path} (${mb(s.bytes)})`);
  const more = skipped.length > NAMED ? ` and ${skipped.length - NAMED} more` : '';
  return `left out ${named.join(', ')}${more}; a file may be at most ${mb(LIMITS.fileBytes)}`;
}
