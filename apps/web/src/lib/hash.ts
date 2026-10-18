/** FNV-1a over the UTF-16 code units, as eight hex digits: enough to tell a changed file from an unchanged one. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** One hash over a set of files by path, order-free. */
export function hashFiles(files: Record<string, string>): string {
  const paths = Object.keys(files).sort();
  return fnv1a(paths.map((p) => `${p}\0${fnv1a(files[p] ?? '')}`).join('\n'));
}
