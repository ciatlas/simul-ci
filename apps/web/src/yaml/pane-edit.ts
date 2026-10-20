import type { Extension, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { regionEdit } from '@simulci/document/edits';
import { asWritten } from '../input/read';
import { downloadText } from '../lib/download';
import { fileLabel } from '../lib/file-label';
import { markEdit } from '../lib/marks';
import { stampOf } from '../state/history';
import { type SessionStore, writable } from '../state/store';
import { type Eol, eolOf, toTextEdits } from './bridge';
import { aloneOf, type EditHandlers, indentOf, writableExtensions } from './editing';
import { type PaneDocs, readOnlyExtensions } from './extensions';

/**
 * The YAML pane's edit mode outside React (synthesis § 4.3): what each file's state holds in `editCompartment`, and
 * the author's changes on their way to the store through the bridge. A change the store refuses, or a view that no
 * longer shows the store's text (checked after every change in development), gets the store's text back.
 */
export function paneEditing(
  store: SessionStore,
  docs: () => PaneDocs | undefined,
): (path: string) => Extension {
  const cache = new Map<string, Extension>();
  const handlers = (path: string): EditHandlers => {
    /** A change of the update under way the store refused. */
    let refused = false;
    return {
      changed: (tr) => {
        if (!forward(store, docs(), path, tr)) refused = true;
      },
      forwarded: (view) => {
        verify(store, docs(), path, view, refused);
        refused = false;
      },
      undo: () => store.getState().undo(),
      redo: () => store.getState().redo(),
      blurred: () => store.getState().closeGroup(),
    };
  };
  return (path) => {
    const s = store.getState();
    const indent = indentOf(s.files.byPath[path] ?? '');
    const ok = writable(s, path).ok;
    // One object per file and kind, so a state that holds it already is not reconfigured on every key.
    const key = `${ok ? `w${indent}` : 'r'}\0${path}`;
    let extension = cache.get(key);
    if (!extension) {
      extension = ok ? writableExtensions(path, indent, handlers(path)) : readOnlyExtensions(path);
      cache.set(key, extension);
    }
    return extension;
  };
}

/**
 * One change the author made, as edits of the store's text, into the history; the view then holds that rev. False
 * when the store refused it (a change that changes nothing is no refusal).
 */
function forward(store: SessionStore, docs: PaneDocs | undefined, path: string, tr: Transaction): boolean {
  const s = store.getState();
  const text = s.files.byPath[path];
  if (text === undefined) return false;
  const edits = toTextEdits(tr.startState.doc, tr.changes, text, eolOf(s.files.meta[path]));
  const outcome = s.typed(path, edits, aloneOf(tr));
  const rev = store.getState().files.revs[path];
  if (outcome.ok && rev !== undefined) {
    docs?.typed(path, rev);
    markEdit('edit:tx', rev);
  }
  return outcome.ok || outcome.refusal === undefined;
}

/** The view shows the store's text, line endings and all; when it does not, it is given the store's text again. */
function verify(
  store: SessionStore,
  docs: PaneDocs | undefined,
  path: string,
  view: EditorView,
  refused: boolean,
): void {
  const s = store.getState();
  const text = s.files.byPath[path];
  const meta = s.files.meta[path];
  if (text === undefined || meta?.eol === 'mixed') return;
  const { doc } = view.state;
  // In development every change is checked byte for byte.
  const differs = import.meta.env.DEV && doc.sliceString(0, doc.length, eolOf(meta)) !== text;
  if (!refused && !differs) return;
  if (differs)
    console.error(`the YAML pane and the store disagree on ${path}; the pane shows the store's text again`);
  const rev = s.files.revs[path] ?? 0;
  // Not inside the update that is running: CodeMirror allows no new state there.
  queueMicrotask(() => docs?.rebuild(view, path, text, rev));
}

/** The line of a generated file's marker, among the first lines where core looks for it. */
export function markerLine(text: string, marker: string): number {
  const index = text.split(/\r\n?|\n/, 10).findIndex((line) => line.includes(marker));
  return index < 0 ? 1 : index + 1;
}

/** Converts a file's line endings to one kind, as one undoable entry: what makes a mixed file writable. */
export function convertLineEndings(store: SessionStore, path: string, eol: Eol): void {
  const s = store.getState();
  const text = s.files.byPath[path];
  if (text === undefined) return;
  const converted = text.replace(/\r\n|\r|\n/g, eol);
  s.transact({
    label: `Converted ${fileLabel(path)} to ${eol === '\n' ? 'LF' : 'CRLF'}`,
    origin: 'convert',
    files: [{ path, edits: [regionEdit(text, converted)], expect: stampOf(text) }],
  });
}

/** Hands the file to the browser to save as it would be written: its BOM back, its line endings as they are. */
export function downloadFile(store: SessionStore, path: string): void {
  const { byPath, meta } = store.getState().files;
  const text = byPath[path];
  if (text !== undefined)
    downloadText(path.slice(path.lastIndexOf('/') + 1), asWritten(text, meta[path]), 'application/yaml');
}
