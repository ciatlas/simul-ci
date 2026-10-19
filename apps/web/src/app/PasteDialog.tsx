import { type FormEvent, useState } from 'react';
import { nextPastePath } from '../input/paste';
import { useModal } from './modal';
import { useApp, useSession } from './providers';

/** A path and a buffer; several add up. The native dialog traps and returns focus. */
export function PasteDialog({ onClose }: { onClose: () => void }) {
  const { sources } = useApp();
  const source = useSession((s) => s.source);
  const taken = source.kind === 'paste' ? source.buffers.map((b) => b.path) : [];
  const dialog = useModal(onClose);
  const [path, setPath] = useState(() => nextPastePath(taken));
  const [text, setText] = useState('');
  const [reason, setReason] = useState<string | undefined>();

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const check = sources.paste(path, text);
    if (check.ok) onClose();
    else setReason(check.reason);
  };

  return (
    <dialog
      ref={dialog}
      className="m-auto w-[min(48rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-text backdrop:bg-black/40"
      aria-labelledby="paste-title"
    >
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <h2 id="paste-title" className="font-semibold">
          Paste a workflow or an action
        </h2>
        <label className="flex flex-col gap-1 text-sm">
          Path in the repository
          <input
            className="rounded border border-border bg-bg px-2 py-1 font-mono text-sm"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          YAML
          <textarea
            className="min-h-64 rounded border border-border bg-bg p-2 font-mono text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            // biome-ignore lint: the first field the author types in
            autoFocus
          />
        </label>
        {reason && (
          <p role="alert" className="text-danger text-sm">
            {reason}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button type="submit" className="rounded bg-accent px-3 py-1.5 text-on-accent text-sm">
            Add
          </button>
        </div>
      </form>
    </dialog>
  );
}
