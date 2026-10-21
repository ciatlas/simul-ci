import { useEffect, useState } from 'react';
import { dirtyPaths } from '../state/store';
import { useApp, useSession } from './providers';

const small =
  'rounded border border-border bg-surface px-2 py-1 text-text text-xs hover:border-border-strong aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

interface PermissionQuery {
  queryPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
}

/**
 * Whether saving will ask the browser for write access first: only a label, since the permission itself is asked in
 * the click (`app/saver.ts`).
 */
function useAsksToWrite(handle: FileSystemDirectoryHandle | undefined, running: boolean): boolean {
  const [asks, setAsks] = useState(false);
  useEffect(() => {
    const asked = (handle as PermissionQuery | undefined)?.queryPermission?.({ mode: 'readwrite' });
    if (!asked) return undefined;
    let live = true;
    asked.then(
      (state) => live && setAsks(state !== 'granted'),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [handle, running]);
  return asks;
}

/**
 * Save, beside the source's "● 2 unsaved" (synthesis § 5.2, § 5.3): shown for a folder opened with a handle, the main
 * button while anything is unsaved. "Save…" says the browser will ask for write access first. Mod+S does the same.
 */
export function SaveButton() {
  const { saver } = useApp();
  const handle = useSession((s) => (s.source.kind === 'folder' ? s.source.handle : undefined));
  const folder = useSession((s) => (s.source.kind === 'folder' ? s.source.name : ''));
  const unsaved = useSession((s) => dirtyPaths(s.files).length);
  const running = useSession((s) => s.saving?.status === 'running');
  const asks = useAsksToWrite(handle, running) && unsaved > 0;
  if (!handle) return null;
  const idle = unsaved === 0 || running;
  return (
    <button
      type="button"
      className={
        unsaved > 0
          ? 'rounded bg-accent px-2 py-1 text-on-accent text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-50'
          : small
      }
      aria-disabled={idle}
      aria-keyshortcuts="Control+S Meta+S"
      title={titleOf(folder, unsaved, running, asks)}
      onClick={() => {
        if (!idle) void saver.save();
      }}
    >
      {running ? 'Saving…' : asks ? 'Save…' : 'Save'}
    </button>
  );
}

function titleOf(folder: string, unsaved: number, running: boolean, asks: boolean): string {
  if (running) return `Saving to ${folder}`;
  if (unsaved === 0) return 'Nothing to save';
  const files = `${unsaved} ${unsaved === 1 ? 'file' : 'files'}`;
  return `Save ${files} to ${folder}${asks ? '; the browser asks for write access first' : ''}`;
}

/** What the last save said, in the status line: "Saving to repo…", then each file's fate. */
export function SaveLine() {
  const saving = useSession((s) => s.saving);
  return (
    <div role="status" className="ml-auto min-w-0 truncate">
      {saving?.status === 'running' ? `Saving to ${saving.folder}…` : saving?.sentence}
    </div>
  );
}
