import { useCallback, useEffect, useMemo, useState } from 'react';
import { type Choice, type DiskConflict, failure, type FileOutcome } from '../input/save';
import { fileLabel } from '../lib/file-label';
import { downloadOne, downloadPatch } from '../state/changes';
import { dirtyPaths, type Saving, type Settling } from '../state/store';
import { DiffCounts, diffOf, UnifiedDiff } from './DiffView';
import { useModal } from './modal';
import { useApp, useSession } from './providers';

const button = 'rounded border border-border px-3 py-1.5 text-sm hover:border-border-strong';
const primary =
  'rounded bg-accent px-3 py-1.5 text-on-accent text-sm disabled:cursor-not-allowed disabled:opacity-50';
const small =
  'rounded border border-border bg-surface px-2 py-1 text-text text-xs hover:border-border-strong aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
const dialogClass =
  'm-auto max-h-[calc(100vh-2rem)] w-[min(48rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/40';

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

/** The save's dialogs: the conflicts to settle, and the report of a save that left a file unsaved. */
export function SaveDialogs() {
  const settling = useSession((s) => s.settling);
  const saving = useSession((s) => s.saving);
  return (
    <>
      {settling && <ConflictsDialog key={settling.seq} settling={settling} />}
      {saving?.status === 'done' && saving.open && <ReportDialog saving={saving} />}
    </>
  );
}

const WORDS: Record<Settling['mode'], Record<Choice, string>> = {
  save: { mine: 'Overwrite with mine', disk: 'Keep the disk version', skip: 'Skip' },
  reload: { mine: 'Keep mine', disk: 'Take the disk version', skip: 'Skip' },
};

const WHY: Record<DiskConflict['reason'], (name: string) => string> = {
  'changed-on-disk': (name) => `${name} changed on disk since it was opened or last saved.`,
  'deleted-on-disk': (name) => `${name} is gone from the folder.`,
  exists: (name) => `${name} is in the folder already.`,
};

const AFTER: Record<Settling['mode'], string> = {
  save: 'Nothing is written until each file has a choice. Keep the disk version is one undo away from your edits.',
  reload:
    'Keep mine leaves your edits, and the next save writes them over the folder; Take the disk version is one undo away from them.',
};

/**
 * The files the folder and the page both changed (§ 5.4, § 5.7), one row each with Compare (the folder's change and
 * the author's, both from the text as read) and the choices. Save or Reload goes on once every file has one; Cancel,
 * or Escape, leaves everything as it is.
 */
function ConflictsDialog({ settling }: { settling: Settling }) {
  const { saver } = useApp();
  const [chosen, setChosen] = useState<Record<string, Choice>>({});
  const cancel = useCallback(() => saver.answer(undefined, settling.seq), [saver, settling.seq]);
  const dialog = useModal(cancel);
  const { conflicts, mode } = settling;
  const ready = conflicts.every((c) => chosen[c.path]);
  // The answer, then the dialog closes, which gives the focus back to where it was (the pane, a field).
  const go = (): void => {
    saver.answer(
      Object.fromEntries(conflicts.map((c) => [c.path, { choice: chosen[c.path]!, stamp: c.stamp ?? '-' }])),
      settling.seq,
    );
    dialog.current?.close();
  };
  return (
    <dialog
      ref={dialog}
      className={dialogClass}
      aria-labelledby="conflicts-title"
      aria-describedby="conflicts-body"
    >
      <div className="flex flex-col gap-3 p-4">
        <h2 id="conflicts-title" className="font-semibold">
          {mode === 'save' ? 'Changed on disk' : `Reload ${settling.folder}: changed on both sides`}
        </h2>
        <p id="conflicts-body" className="text-sm">
          {AFTER[mode]}
        </p>
        {conflicts.map((c) => (
          <ConflictRow
            key={c.path}
            conflict={c}
            mode={mode}
            choice={chosen[c.path]}
            choose={(choice) => setChosen((now) => ({ ...now, [c.path]: choice }))}
          />
        ))}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={button} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="button" className={primary} disabled={!ready} onClick={go}>
            {mode === 'save' ? 'Save' : 'Reload'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function ConflictRow({
  conflict,
  mode,
  choice,
  choose,
}: {
  conflict: DiskConflict;
  mode: Settling['mode'];
  choice: Choice | undefined;
  choose: (choice: Choice) => void;
}) {
  const { store } = useApp();
  const { path, base, mine, disk } = conflict;
  const name = fileLabel(path);
  const theirs = useMemo(() => diffOf(base, disk?.text), [base, disk]);
  const ours = useMemo(() => diffOf(base, mine), [base, mine]);
  return (
    <section aria-label={path} className="flex flex-col gap-2 border-border border-t pt-3">
      <p className="text-sm">{WHY[conflict.reason](name)}</p>
      <details>
        <summary className="cursor-pointer text-xs">Compare</summary>
        <div className="flex flex-col gap-2 pt-2">
          <span className="flex items-center gap-2 text-xs">
            The folder's change <DiffCounts diff={theirs} />
          </span>
          <UnifiedDiff diff={theirs} label={`${name}: what the folder changed`} />
          <span className="flex items-center gap-2 text-xs">
            Your change <DiffCounts diff={ours} />
          </span>
          <UnifiedDiff diff={ours} label={`${name}: what you changed`} />
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
          <legend className="sr-only">What to do with {path}</legend>
          {(['mine', 'disk', 'skip'] as const).map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input type="radio" name={`choice-${path}`} checked={choice === c} onChange={() => choose(c)} />
              {WORDS[mode][c]}
            </label>
          ))}
        </fieldset>
        {mine !== undefined && (
          <button
            type="button"
            className={`${small} ml-auto`}
            aria-label={`Download mine: ${path}`}
            onClick={() => downloadOne(store.getState().files, path)}
          >
            Download mine
          </button>
        )}
      </div>
    </section>
  );
}

const STATUS: Record<FileOutcome['status'], string> = {
  saved: 'saved',
  failed: 'failed',
  'not-attempted': 'not attempted',
  skipped: 'skipped',
  conflict: 'changed on disk, not written',
  disk: 'kept the disk version',
  encoding: 'not UTF-8, never written',
  kept: 'removed here, not from the folder: a save deletes nothing',
  gone: 'removed here and from the folder',
};

const statusOf = (f: FileOutcome): string =>
  f.status === 'failed' ? `failed (${failure(f.error)})` : STATUS[f.status];

/**
 * A save that left something unsaved (§ 5.3): each file and what happened to it, or that write access was refused.
 * The edits stay; Retry runs the whole save again, the check included, and Download patch hands them over instead.
 */
function ReportDialog({ saving }: { saving: Extract<Saving, { status: 'done' }> }) {
  const { store, saver } = useApp();
  // Only this report closes: a save started from it has replaced it by then.
  const close = useCallback(() => {
    if (store.getState().saving === saving) store.getState().setSaving({ ...saving, open: false });
  }, [store, saving]);
  const dialog = useModal(close);
  const unsaved = useSession((s) => dirtyPaths(s.files).length);
  return (
    <dialog ref={dialog} className={dialogClass} aria-labelledby="save-title" aria-describedby="save-body">
      <div className="flex flex-col gap-3 p-4">
        <h2 id="save-title" className="font-semibold">
          {saving.denied ? 'Not saved' : 'Not everything was saved'}
        </h2>
        <p id="save-body" className="text-sm">
          {saving.denied
            ? `Writing to ${saving.folder} was not allowed. Your edits are kept: save again and allow it, or download them as a patch.`
            : `Your edits are kept for every file not saved. Retry checks the folder again first.`}
        </p>
        {saving.files.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Files">
            {saving.files.map((f) => (
              <li key={f.path} className="flex flex-wrap gap-x-2">
                <span className="font-mono">{f.path}</span>
                <span className={f.status === 'saved' ? 'text-muted' : ''}>{statusOf(f)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={button} onClick={() => dialog.current?.close()}>
            Close
          </button>
          <button
            type="button"
            className={button}
            disabled={unsaved === 0}
            onClick={() => {
              const { files } = store.getState();
              downloadPatch(files, dirtyPaths(files).sort(), 'base');
            }}
          >
            Download patch
          </button>
          <button
            type="button"
            className={primary}
            disabled={unsaved === 0}
            onClick={() => {
              // The save first, while the click's activation lasts; closing gives the focus back.
              void saver.save();
              dialog.current?.close();
            }}
          >
            Retry
          </button>
        </div>
      </div>
    </dialog>
  );
}
