import { useShallow } from 'zustand/react/shallow';
import { useApp, useSession } from '../app/providers';
import { togglePaneKeepingFocus } from '../app/shortcuts';
import { type SessionState, type Writable, writable } from '../state/store';
import { indentOf } from './editing';
import { convertLineEndings, downloadFile, markerLine } from './pane-edit';

const action = 'shrink-0 rounded px-1.5 py-0.5 text-text underline-offset-2 hover:bg-surface hover:underline';

/**
 * Under the pane, what the shown file is and why (synthesis § 4.3): read-only outside edit mode, with the way in;
 * in edit mode "● unsaved · CRLF · 2 spaces" and Download, or why the file is not writable, with the way out:
 * Edit anyway for a generated file, Convert for mixed line endings, nothing for a file that is not UTF-8.
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
  dirty?: boolean;
  eol?: string;
  indent?: number;
  reason?: Exclude<Writable, { ok: true }>['reason'];
  marker?: string;
  line?: number;
}

/** What the footer says of a file: flat values, so the selector compares them one by one. */
function footerOf(s: SessionState, path: string): FooterState {
  const w = writable(s, path);
  if (w.ok) {
    const text = s.files.byPath[path] ?? '';
    const eol = s.files.meta[path]?.eol === 'crlf' ? 'CRLF' : 'LF';
    return { ok: true, dirty: text !== s.files.base[path], eol, indent: indentOf(text) };
  }
  if (w.reason !== 'generated') return { ok: false, reason: w.reason };
  return {
    ok: false,
    reason: w.reason,
    marker: w.marker,
    line: markerLine(s.files.byPath[path] ?? '', w.marker),
  };
}

function FileState({ path, state: f }: { path: string; state: FooterState }) {
  const { store } = useApp();
  const a = store.getState();
  if (f.ok)
    return (
      <>
        <span className="shrink-0">
          {f.dirty && <span className="text-text">● unsaved · </span>}
          {f.eol} · {f.indent} {f.indent === 1 ? 'space' : 'spaces'}
        </span>
        <button type="button" className={action} onClick={() => downloadFile(store, path)}>
          Download
        </button>
      </>
    );
  if (f.reason === 'off')
    return (
      <span className="flex shrink-0 items-center gap-1">
        read-only ·
        <button type="button" className={action} onClick={() => a.setEdit(true)} aria-keyshortcuts="e">
          Edit (E)
        </button>
      </span>
    );
  if (f.reason === 'generated')
    return (
      <span className="flex shrink-0 items-center gap-1">
        Generated (line {f.line}: {f.marker}) ·
        <button type="button" className={action} onClick={() => a.unlock(path)}>
          Edit anyway
        </button>
      </span>
    );
  if (f.reason === 'mixed')
    return (
      <span className="flex shrink-0 items-center gap-1">
        Mixed line endings ·
        <button type="button" className={action} onClick={() => convertLineEndings(store, path, '\n')}>
          Convert to LF
        </button>
        <button type="button" className={action} onClick={() => convertLineEndings(store, path, '\r\n')}>
          Convert to CRLF
        </button>
      </span>
    );
  if (f.reason === 'encoding') return <span className="shrink-0">Not UTF-8: read-only</span>;
  return null;
}
