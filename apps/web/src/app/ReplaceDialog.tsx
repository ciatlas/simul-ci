import { useCallback } from 'react';
import { dirtyPaths } from '../state/store';
import { useModal } from './modal';
import { useApp, useSession } from './providers';

const button = 'rounded border border-border px-3 py-1.5 text-sm hover:border-border-strong';

/**
 * Asks before files with unsaved edits give way to another source (synthesis § 5.7): Download the edited files, then
 * go on; Discard the edits; or Cancel, which keeps everything as it is. Escape is Cancel. Saving to the folder (A7)
 * and a patch of every change (A6) join these later.
 */
export function ReplacePrompt() {
  const replacing = useSession((s) => s.replacing);
  // A dialog per question, so each opens as a modal when it mounts.
  return replacing ? <ReplaceDialog key={replacing.seq} what={replacing.what} /> : null;
}

function ReplaceDialog({ what }: { what: string }) {
  const { prompt } = useApp();
  const names = useSession((s) => dirtyPaths(s.files).map(baseName).join(', '));
  const count = useSession((s) => dirtyPaths(s.files).length);
  const cancel = useCallback(() => prompt.answer('cancel'), [prompt]);
  const dialog = useModal(cancel);
  return (
    <dialog
      ref={dialog}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/40"
      aria-labelledby="replace-title"
      aria-describedby="replace-body"
    >
      <div className="flex flex-col gap-3 p-4">
        <h2 id="replace-title" className="font-semibold">
          Unsaved edits
        </h2>
        <p id="replace-body" className="text-sm">
          {count === 1 ? `${names} has unsaved edits.` : `${names} have unsaved edits.`} {what} drops them.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={button} onClick={cancel}>
            Cancel
          </button>
          <button type="button" className={button} onClick={() => prompt.answer('discard')}>
            Discard edits
          </button>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1.5 text-on-accent text-sm"
            onClick={() => prompt.answer('download')}
          >
            Download {count === 1 ? 'it' : 'them'} first
          </button>
        </div>
      </div>
    </dialog>
  );
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
