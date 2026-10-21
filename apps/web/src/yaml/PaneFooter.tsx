import type { MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp, useSession } from '../app/providers';
import { togglePaneKeepingFocus } from '../app/panes';
import { type SessionState, type Writable, writable } from '../state/store';
import { indentOf } from './editing';
import { convertLineEndings, downloadFile, markerLine } from './pane-edit';

const action = 'shrink-0 rounded px-1.5 py-0.5 text-text underline-offset-2 hover:bg-surface hover:underline';

/**
 * Under the pane, what the shown file is and why (synthesis § 4.3): read-only outside edit mode, with the way in;
 * in edit mode "● unsaved · CRLF · 2 spaces", or why the file is not writable, with the way out: Edit anyway for a
 * generated file, Convert for mixed (or CR-only) line endings, nothing for a file that is not UTF-8. Download is
 * there for every writable file and for every edited one, read-only or not. A button that makes the file writable
 * hands the focus to the editor, since the button itself goes.
 */
export function PaneFooter({ path }: { path: string | undefined }) {
  const { store } = useApp();
  const state = useSession(useShallow((s) => (path === undefined ? undefined : footerOf(s, path))));
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-t bg-chrome px-3 py-1 text-muted text-xs">
      <span className="min-w-0 truncate font-mono">{path}</span>
      {path !== undefined && state && <FileState path={path} state={state} />}
      <button
        type="button"
        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-text hover:bg-surface"
        aria-label="Close the workflow source"
        onClick={() => togglePaneKeepingFocus(store.getState(), 'yaml')}
      >
        Close
      </button>
    </footer>
  );
}

interface FooterState {
  ok: boolean;
  dirty: boolean;
  download: boolean;
  keys: boolean;
  eol?: string;
  indent?: number;
  reason?: Exclude<Writable, { ok: true }>['reason'];
  marker?: string;
  line?: number;
  /** Line endings that are all CR: one kind, but not one the pane edits. */
  crOnly?: boolean;
}

/** What the footer says of a file: flat values, so the selector compares them one by one. */
function footerOf(s: SessionState, path: string): FooterState {
  const w = writable(s, path);
  const text = s.files.byPath[path] ?? '';
  const dirty = text !== s.files.base[path];
  const common = {
    dirty,
    download: s.files.meta[path]?.utf8 === true && (w.ok || dirty),
    keys: s.ui.prefs.keys,
  };
  if (w.ok)
    return {
      ok: true,
      ...common,
      eol: s.files.meta[path]?.eol === 'crlf' ? 'CRLF' : 'LF',
      indent: indentOf(text),
    };
  if (w.reason === 'generated')
    return { ok: false, ...common, reason: w.reason, marker: w.marker, line: markerLine(text, w.marker) };
  return { ok: false, ...common, reason: w.reason, crOnly: w.reason === 'mixed' && !text.includes('\n') };
}

/** The pane's editor, from a control of its footer, once the store's change has rendered it writable. */
function focusEditor(from: HTMLElement): void {
  const pane = from.closest('footer')?.parentElement;
  requestAnimationFrame(() => pane?.querySelector<HTMLElement>('.cm-content')?.focus());
}

function FileState({ path, state: f }: { path: string; state: FooterState }) {
  const { store } = useApp();
  const download = f.download && (
    <button type="button" className={action} onClick={() => downloadFile(store, path)}>
      Download
    </button>
  );
  return (
    <>
      <span className="flex shrink-0 items-center gap-1">
        {f.dirty && (
          <span className="text-text">
            {/* The space reads "unsaved · CRLF" as text too; the gap draws it. */}
            <span aria-hidden="true">● </span>unsaved ·{' '}
          </span>
        )}
        <Why path={path} state={f} />
      </span>
      {download}
    </>
  );
}

function Why({ path, state: f }: { path: string; state: FooterState }) {
  const { store } = useApp();
  const then = (act: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    act();
    focusEditor(button);
  };
  if (f.ok) return <>{`${f.eol} · ${f.indent} ${f.indent === 1 ? 'space' : 'spaces'}`}</>;
  if (f.reason === 'off')
    return <OffNote keys={f.keys} onEdit={then(() => store.getState().setEdit(true))} />;
  if (f.reason === 'generated')
    return (
      <>
        Generated ({f.line === undefined ? f.marker : `line ${f.line}: ${f.marker}`}) ·
        <button type="button" className={action} onClick={then(() => store.getState().unlock(path))}>
          Edit anyway
        </button>
      </>
    );
  if (f.reason === 'mixed')
    return (
      <MixedNote
        crOnly={f.crOnly === true}
        convert={(eol) => then(() => convertLineEndings(store, path, eol))}
      />
    );
  return (
    <>
      {f.reason === 'encoding'
        ? 'Not UTF-8: read-only'
        : f.reason === 'loading'
          ? 'read-only while the files load'
          : null}
    </>
  );
}

type OnClick = (event: MouseEvent<HTMLButtonElement>) => void;

function OffNote({ keys, onEdit }: { keys: boolean; onEdit: OnClick }) {
  return (
    <>
      read-only ·
      <button type="button" className={action} onClick={onEdit} aria-keyshortcuts={keys ? 'e' : undefined}>
        {keys ? 'Edit (E)' : 'Edit'}
      </button>
    </>
  );
}

function MixedNote({ crOnly, convert }: { crOnly: boolean; convert: (eol: '\n' | '\r\n') => OnClick }) {
  return (
    <>
      {crOnly ? 'CR line endings' : 'Mixed line endings'} ·
      <button type="button" className={action} onClick={convert('\n')}>
        Convert to LF
      </button>
      <button type="button" className={action} onClick={convert('\r\n')}>
        Convert to CRLF
      </button>
    </>
  );
}
