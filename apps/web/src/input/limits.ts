/** What a source may hold before the page refuses it: the engine is fast, the browser's memory is the limit. */
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
