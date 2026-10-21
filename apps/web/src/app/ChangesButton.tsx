import { lazy, Suspense } from 'react';
import { dirtyPaths } from '../state/store';
import { useSession } from './providers';

/** The dialog is in the dialogs chunk (`app/dialogs.ts`), fetched on idle once a file is unsaved, or here on demand. */
const ChangesDialog = lazy(() => import('./dialogs').then((m) => ({ default: m.ChangesDialog })));

/**
 * The top bar's Changes (synthesis § 5.2): in edit mode, or while a file has unsaved edits, with their count. It opens
 * the Changes dialog, as Mod+Shift+D does in edit mode.
 */
export function ChangesButton() {
  const on = useSession((s) => s.edit.on);
  const unsaved = useSession((s) => dirtyPaths(s.files).length);
  const open = useSession((s) => s.changesOpen);
  const setOpen = useSession((s) => s.setChangesOpen);
  if (!on && unsaved === 0 && !open) return null;
  return (
    <>
      <button
        type="button"
        className="rounded border border-border bg-surface px-2 py-1 text-text hover:border-border-strong"
        aria-keyshortcuts={on ? 'Control+Shift+D Meta+Shift+D' : undefined}
        title={
          unsaved === 0
            ? 'No unsaved edits'
            : `${unsaved} ${unsaved === 1 ? 'file' : 'files'} with unsaved edits`
        }
        onClick={() => setOpen(true)}
      >
        Changes{unsaved > 0 && ` (${unsaved})`}
      </button>
      {open && (
        <Suspense fallback={<span className="text-muted text-xs">loading the changes…</span>}>
          <ChangesDialog />
        </Suspense>
      )}
    </>
  );
}
