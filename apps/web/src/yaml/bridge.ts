import type { ChangeSet, ChangeSpec, Text } from '@codemirror/state';
import type { TextEdit } from '@simulci/document/edits';
import type { FileMeta } from '../input/read';

/**
 * The bridge between CodeMirror and the store's texts (synthesis § 4.3). CodeMirror counts a line break as one
 * position whatever it is, and `Text.toString()` joins lines with `\n`, so its positions are never the store's
 * offsets in a CRLF file. Each side keeps its own: a position is a line and a column, mapped through the line starts
 * of the store's text; no `lineSeparator` facet is set. Inserted line breaks take the file's line ending, so a typed
 * Enter or a pasted block never makes a CRLF file mixed.
 */

export type Eol = '\n' | '\r\n';

/** The line ending new lines get: the file's own, LF when it has none yet. */
export const eolOf = (meta: Pick<FileMeta, 'eol'> | undefined): Eol => (meta?.eol === 'crlf' ? '\r\n' : '\n');

/**
 * Where each line of a text starts, splitting as CodeMirror does: at CRLF, a lone CR and LF. The last text's starts are
 * kept, since every key asks for those of the text it was typed into.
 */
export function lineStarts(text: string): readonly number[] {
  if (cached?.text === text) return cached.starts;
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
    if (c === 10 || c === 13) starts.push(i + 1);
  }
  cached = { text, starts };
  return starts;
}

let cached: { text: string; starts: readonly number[] } | undefined;

/** The store offset of a CodeMirror position in `doc`, the document that shows `text`. */
function offsetOf(doc: Text, starts: readonly number[], pos: number): number {
  const line = doc.lineAt(pos);
  return starts[line.number - 1]! + (pos - line.from);
}

/** The CodeMirror position of a store offset; an offset inside a CRLF break is the end of its line. */
function positionOf(doc: Text, starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  const line = doc.line(lo + 1);
  return line.from + Math.min(offset - starts[lo]!, line.length);
}

/** CodeMirror changes (positions in `startDoc`) as edits of the store's text, mapped by line and column. */
export function toTextEdits(startDoc: Text, changes: ChangeSet, text: string, eol: Eol): TextEdit[] {
  const starts = lineStarts(text);
  const edits: TextEdit[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    edits.push({
      from: offsetOf(startDoc, starts, fromA),
      to: offsetOf(startDoc, starts, toA),
      insert: inserted.sliceString(0, inserted.length, eol),
    });
  });
  return edits;
}

/** Store edits (offsets in `text`, which `doc` shows) as CodeMirror changes on `doc`: undo, ops, restore and revert. */
export function toChanges(doc: Text, text: string, edits: readonly TextEdit[]): ChangeSpec[] {
  const starts = lineStarts(text);
  return edits.map((e) => ({
    from: positionOf(doc, starts, e.from),
    to: positionOf(doc, starts, e.to),
    insert: e.insert,
  }));
}

/**
 * Whether a CodeMirror document holds as many lines and characters as the store's text it should show, each CRLF
 * one position: a check cheap enough to run on every change, before a key is mapped and after a change comes in.
 */
export function agrees(doc: Text, text: string): boolean {
  const starts = lineStarts(text);
  if (doc.lines !== starts.length) return false;
  let crlf = 0;
  for (let i = 1; i < starts.length; i++) {
    const at = starts[i]!;
    if (text.charCodeAt(at - 1) === 10 && text.charCodeAt(at - 2) === 13) crlf++;
  }
  return doc.length === text.length - crlf;
}
