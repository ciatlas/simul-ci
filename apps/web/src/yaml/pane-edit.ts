import type { Extension, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { regionEdit } from '@simulci/document/edits';
import { downloadOne } from '../input/read';
import { fileLabel } from '../lib/file-label';
import { markEdit } from '../lib/marks';
import { stampOf } from '../state/history';
import { type SessionStore, writable } from '../state/store';
import { agrees, type Eol, eolOf, toTextEdits } from './bridge';
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
  /** Each file's indent, read once per epoch: typing a file's first indented line does not change its Tab. */
  const indents = new Map<string, { epoch: number; indent: number }>();
  const indentFor = (path: string): number => {
    const { epoch, byPath } = store.getState().files;
    const known = indents.get(path);
    if (known?.epoch === epoch) return known.indent;
    const indent = indentOf(byPath[path] ?? '');
    indents.set(path, { epoch, indent });
    return indent;
  };
  return (path) => {
    const s = store.getState();
    const indent = indentFor(path);
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
  // A view that does not show the store's text would map the key elsewhere: refused, and the view is given it again.
  if (text === undefined || !agrees(tr.startState.doc, text)) return false;
  const edits = toTextEdits(tr.startState.doc, tr.changes, text, eolOf(s.files.meta[path]));
  const outcome = s.typed(path, edits, aloneOf(tr));
  const rev = store.getState().files.revs[path];
  if (outcome.ok && rev !== undefined) {
    docs?.typed(path, rev);
    markEdit('edit:tx', rev);
    // The file typed in stays shown, whichever file the selection's next plan decides in.
    if (store.getState().ui.yamlFile !== path) store.getState().setYamlFile(path);
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

/**
 * The line of a generated file's marker, among the first lines where core looks for it; none for a marker that is
 * no text of the file (`.lock.yml`, the name).
 */
export function markerLine(text: string, marker: string): number | undefined {
  const index = text.split(/\r\n?|\n/, 10).findIndex((line) => line.includes(marker));
  return index < 0 ? undefined : index + 1;
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
export const downloadFile = (store: SessionStore, path: string): void =>
  downloadOne(store.getState().files, path);
