/**
 * Reading a file as save-back needs it (synthesis § 5.1). `Blob.text()` strips a UTF-8 BOM and replaces invalid
 * bytes with U+FFFD without a word; this reader still strips the BOM, so the text, its offsets and its line-1 columns
 * stay what the engine and the YAML pane see, but it says the BOM was there and whether every byte was UTF-8.
 */

/** What reading a file found beside its text: its BOM, its line endings, whether it is valid UTF-8. */
export interface FileMeta {
  /** The bytes began with EF BB BF; the text does not hold it. */
  bom: boolean;
  eol: 'lf' | 'crlf' | 'mixed' | 'none';
  /** False when the decoder had to replace invalid bytes with U+FFFD: the text is not what the file holds. */
  utf8: boolean;
}

// `ignoreBOM` is false by default: both strip a leading BOM.
const strict = new TextDecoder('utf-8', { fatal: true });
const lenient = new TextDecoder('utf-8');

export async function readExact(blob: Blob): Promise<{ text: string; meta: FileMeta }> {
  return decodeExact(new Uint8Array(await blob.arrayBuffer()));
}

/** `readExact` over bytes already read. */
export function decodeExact(bytes: Uint8Array): { text: string; meta: FileMeta } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  let utf8 = true;
  try {
    text = strict.decode(bytes);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    text = lenient.decode(bytes);
    utf8 = false;
  }
  return { text, meta: { bom, eol: classifyEol(text), utf8 } };
}

/**
 * `crlf` when every `\n` follows a `\r` and every `\r` comes before one; `lf` when there is no `\r`; `none` when there
 * is no line break; otherwise `mixed`, a lone `\r` included.
 */
export function classifyEol(text: string): FileMeta['eol'] {
  if (!text.includes('\r')) return text.includes('\n') ? 'lf' : 'none';
  return /[\r\n]/.test(text.replaceAll('\r\n', '')) ? 'mixed' : 'crlf';
}

/** The meta of a string no file was read for: a paste, a sample. */
export const textMeta = (text: string): FileMeta => ({ bom: false, eol: classifyEol(text), utf8: true });

/** The text as a file holds it: its BOM put back, for a download or a save. */
export const asWritten = (text: string, meta: Pick<FileMeta, 'bom'> | undefined): string =>
  meta?.bom ? `\uFEFF${text}` : text;
