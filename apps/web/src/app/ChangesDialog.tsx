import { useCallback, useMemo, useState } from 'react';
import { undoLabel } from '../state/history';
import { downloadOne } from '../input/read';
import { changedPaths, downloadPatch, revertOf, type Since } from '../state/changes';
import { DiffCounts, diffOf, UnifiedDiff } from './DiffView';
import { useModal } from './modal';
import { useApp, useSession } from './providers';

const button =
  'rounded border border-border bg-surface px-2 py-1 text-text text-xs hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50';

const SINCE: Record<Since, { label: string; none: string }> = {
  base: { label: 'Since last save', none: 'Nothing changed since the files were last saved.' },
  opened: { label: 'Since opened', none: 'Nothing changed since the files were opened.' },
};

/**
 * Every changed file, since the last save or since the files were opened, with its +/− counts and a unified diff.
 * Revert puts a file back, as one undoable entry (Undo here takes it back, the dialog keeping the keys); Download hands
 * one file over as it would be written; Download patch hands every change over as `simulci-changes.patch`.
 */
export function ChangesDialog() {
  const { store } = useApp();
  const files = useSession((s) => s.files);
  const undo = useSession((s) => undoLabel(s.edit));
  const setOpen = useSession((s) => s.setChangesOpen);
  const [since, setSince] = useState<Since>('base');
  const [reverted, setReverted] = useState<string>();
  const close = useCallback(() => setOpen(false), [setOpen]);
  const dialog = useModal(close);
  const paths = useMemo(() => changedPaths(files, since), [files, since]);
  const revert = (path: string): void => {
    const s = store.getState();
    const tx = revertOf(s.files, path, since);
    if (tx && s.transact(tx).ok) setReverted(tx.label);
  };
  return (
    <dialog
      ref={dialog}
      className="m-auto max-h-[calc(100vh-2rem)] w-[min(60rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/40"
      aria-labelledby="changes-title"
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 id="changes-title" className="font-semibold">
            Changes
          </h2>
          <fieldset className="flex gap-3 text-sm">
            <legend className="sr-only">Compare with</legend>
            {(['base', 'opened'] as const).map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input type="radio" name="since" checked={since === s} onChange={() => setSince(s)} />
                {SINCE[s].label}
              </label>
            ))}
          </fieldset>
        </div>
        {paths.length === 0 ? (
          <p className="text-muted text-sm">{SINCE[since].none}</p>
        ) : (
          paths.map((path) => (
            <FileChanges
              key={path}
              path={path}
              before={files[since][path]}
              after={files.byPath[path]}
              revert={() => revert(path)}
              download={() => downloadOne(store.getState().files, path)}
            />
          ))
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p role="status" className="mr-auto text-muted text-sm">
            {reverted && undo === reverted && (
              <>
                {reverted}.{' '}
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    store.getState().undo();
                    setReverted(undefined);
                  }}
                >
                  Undo
                </button>
              </>
            )}
          </p>
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-on-accent text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={paths.length === 0}
            onClick={() => downloadPatch(store.getState().files, paths, since)}
          >
            Download patch
          </button>
        </div>
      </div>
    </dialog>
  );
}

function FileChanges({
  path,
  before,
  after,
  revert,
  download,
}: {
  path: string;
  before: string | undefined;
  after: string | undefined;
  revert: () => void;
  download: () => void;
}) {
  const diff = useMemo(() => diffOf(before, after), [before, after]);
  return (
    <section aria-label={path} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm">{path}</span>
        {before === undefined && <span className="text-muted text-xs">created</span>}
        {after === undefined && <span className="text-muted text-xs">removed</span>}
        <DiffCounts diff={diff} />
        <span className="ml-auto flex gap-2">
          <button type="button" className={button} aria-label={`Revert ${path}`} onClick={revert}>
            Revert
          </button>
          {after !== undefined && (
            <button type="button" className={button} aria-label={`Download ${path}`} onClick={download}>
              Download
            </button>
          )}
        </span>
      </div>
      <UnifiedDiff diff={diff} label={`Changes to ${path}`} />
    </section>
  );
}
