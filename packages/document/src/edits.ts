/**
 * Text edits: splices into a file's text by UTF-16 offset, in the shape of CodeMirror's ChangeSpec. The edit history,
 * the CodeMirror bridge and save-back hold nothing else of the document model, so this module imports nothing and the
 * page can load it without the YAML parser behind the rest of the package.
 */

/** A splice: UTF-16 offsets into the store's text (BOM excluded), CodeMirror's ChangeSpec shape. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * Applies sorted, non-overlapping edits. Every offset is one of the text before the edits, as if they were applied
 * from the end. Edits may touch, and insertions at one offset land in the order given. The inverse undoes them: its
 * offsets are in the new text, and its own inverse is `edits` again.
 *
 * @throws RangeError when an edit starts before the previous one ends or is not a range of the text: a programmer
 *   error, never the author's.
 */
export function applyEdits(text: string, edits: readonly TextEdit[]): { text: string; inverse: TextEdit[] } {
  check(edits, text.length);
  const inverse: TextEdit[] = [];
  let out = '';
  let at = 0;
  for (const { from, to, insert } of edits) {
    out += text.slice(at, from) + insert;
    inverse.push({ from: out.length - insert.length, to: out.length, insert: text.slice(from, to) });
    at = to;
  }
  return { text: out + text.slice(at), inverse };
}

/**
 * One edit covering what differs between two texts: everything between their common prefix and common suffix. It
 * never splits a surrogate pair, so the edit and its inverse hold whole characters whenever both texts do.
 */
export function regionEdit(before: string, after: string): TextEdit {
  const start = commonPrefix(before, after);
  const end = commonSuffix(before, after, Math.min(before.length, after.length) - start);
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

/**
 * Where an offset of the text before the edits lands in the text after them, as CodeMirror's `mapPos`. An offset
 * inside a replaced range moves to the replacement's start (`assoc` -1) or end (1); at an insertion it stays before the
 * inserted text (-1) or moves past it (1). The start and the end of a replaced range map to the start and the end of
 * its replacement whatever `assoc`.
 */
export function mapOffset(edits: readonly TextEdit[], offset: number, assoc: -1 | 1 = -1): number {
  check(edits);
  let delta = 0;
  for (const { from, to, insert } of edits) {
    if (offset < from) break;
    const start = from + delta;
    if (offset === from && (from < to || assoc < 0)) return start;
    if (offset < to) return assoc < 0 ? start : start + insert.length;
    delta += insert.length - (to - from);
  }
  return offset + delta;
}

/** The ranges the edits wrote, in the new text: one per edit, in order. A deletion leaves an empty range where it was. */
export function touched(edits: readonly TextEdit[]): { from: number; to: number }[] {
  check(edits);
  let delta = 0;
  return edits.map(({ from, to, insert }) => {
    const start = from + delta;
    delta += insert.length - (to - from);
    return { from: start, to: start + insert.length };
  });
}

/** Throws unless each edit is a range of a text `length` long that starts at or after the end of the one before it. */
function check(edits: readonly TextEdit[], length = Number.POSITIVE_INFINITY): void {
  let end = 0;
  for (const [i, { from, to }] of edits.entries()) {
    if (!isRange(from, to, length))
      throw new RangeError(`edit ${i} (${from}..${to}) is not a range of 0..${length}`);
    if (from < end)
      throw new RangeError(`edit ${i} (${from}..${to}) starts before edit ${i - 1} ends at ${end}`);
    end = to;
  }
}

function isRange(from: number, to: number, length: number): boolean {
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= length;
}

/** The length of the common prefix, short of a high surrogate whose low half differs. */
function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n++;
  return n > 0 && isHighSurrogate(a.charCodeAt(n - 1)) ? n - 1 : n;
}

/** The length of the common suffix, at most `max`, short of a low surrogate whose high half differs. */
function commonSuffix(a: string, b: string, max: number): number {
  let n = 0;
  while (n < max && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n++;
  return n > 0 && isLowSurrogate(a.charCodeAt(a.length - n)) ? n - 1 : n;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
