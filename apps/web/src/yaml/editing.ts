import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import type { Alone } from '../state/history';
import { fromStore } from './extensions';

/**
 * What makes a file's state writable in edit mode (synthesis § 4.3): CodeMirror's editing keys without its history,
 * whose undo is the page's one history in the store; the file's indent; and the listener that hands each change the
 * author makes to the store. A change that came from the store (`fromStore`) is never handed back. The browser's own
 * undo (`beforeinput` historyUndo and historyRedo, from the Edit menu or a gesture) goes to the store too.
 */

export interface EditHandlers {
  /** A change the author made, as CodeMirror has it; the pane maps it to the store's offsets. */
  changed: (tr: Transaction) => void;
  /** After the changes of one update went to the store: the pane checks the view still shows the store's text. */
  forwarded: (view: EditorView) => void;
  undo: () => boolean;
  redo: () => boolean;
  /** The editor lost the focus: the typing group closes. */
  blurred: () => void;
}

/** The indent a file uses: the leading spaces of its first indented line, else two. */
export function indentOf(text: string): number {
  const n = /^( +)[^\s#]/m.exec(text)?.[1]?.length ?? 2;
  return n <= 8 ? n : 2;
}

/** What the store's history calls a change that is no key: a paste, a cut, a drop. */
export function aloneOf(tr: Transaction): Alone | undefined {
  if (tr.isUserEvent('input.paste')) return 'paste';
  if (tr.isUserEvent('delete.cut')) return 'cut';
  if (tr.isUserEvent('input.drop') || tr.isUserEvent('move.drop')) return 'drop';
  return undefined;
}

const taken = (act: () => boolean): boolean => {
  act();
  return true;
};

/** The extensions of a writable file: editable, keyed, indented, and listened to. */
export function writableExtensions(path: string, indent: number, on: EditHandlers): Extension[] {
  return [
    EditorState.readOnly.of(false),
    EditorView.editable.of(true),
    EditorView.contentAttributes.of({ 'aria-label': path }),
    indentUnit.of(' '.repeat(indent)),
    keymap.of([
      // Taken whether or not there is anything to undo: the browser's own undo has nothing to do here.
      { key: 'Mod-z', run: () => taken(on.undo), preventDefault: true },
      { key: 'Mod-Shift-z', run: () => taken(on.redo), preventDefault: true },
      { key: 'Mod-y', run: () => taken(on.redo), preventDefault: true },
      ...defaultKeymap,
      indentWithTab,
    ]),
    EditorView.domEventHandlers({
      beforeinput: (event) => {
        if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return false;
        event.preventDefault();
        if (event.inputType === 'historyUndo') on.undo();
        else on.redo();
        return true;
      },
      blur: () => {
        on.blurred();
        return false;
      },
    }),
    EditorView.updateListener.of((update) => {
      const authored = update.transactions.filter((tr) => tr.docChanged && !tr.annotation(fromStore));
      for (const tr of authored) on.changed(tr);
      if (authored.length > 0) on.forwarded(update.view);
    }),
  ];
}
