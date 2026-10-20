import { useEffect, useId, useRef } from 'react';
import { useModal } from '../../app/modal';
import type { Ask } from './actions';

/**
 * The question before a removal that takes more than the author pointed at, or leaves expressions reading what goes
 * (synthesis § 4.2, resolved contradiction 30): what goes with it, and the button that removes. A native modal dialog,
 * as the page's others are; Escape and Cancel close it with nothing written, and the browser gives the focus back.
 */
export function ConfirmDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const id = useId();
  const dialog = useModal(onClose);
  const remove = useRef<HTMLButtonElement>(null);
  // After the modal opens (its own effect, above), the button the author came for takes the focus.
  useEffect(() => remove.current?.focus(), []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={ask.lines.length > 0 ? `${id}-lines` : undefined}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-4 text-sm text-text backdrop:bg-black/40"
    >
      <form method="dialog" className="flex flex-col gap-3">
        <h2 id={`${id}-title`} className="font-semibold">
          {ask.title}
        </h2>
        {ask.lines.length > 0 && (
          <ul id={`${id}-lines`} className="flex list-disc flex-col gap-1 pl-5 text-xs">
            {ask.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="submit"
            value="cancel"
            className="rounded border border-border px-2.5 py-1 text-xs hover:bg-chrome"
          >
            Cancel
          </button>
          <button
            type="submit"
            value="remove"
            ref={remove}
            className="rounded border border-danger bg-danger px-2.5 py-1 text-on-accent text-xs"
            onClick={ask.run}
          >
            {ask.action}
          </button>
        </div>
      </form>
    </dialog>
  );
}
