import { useEffect } from 'react';
import type { Notice } from '../state/store';
import { useApp, useSession } from './providers';

/**
 * Short notices (a restart, no changes on reload, a removal on the canvas); each goes after five seconds or a click.
 * A removal's notice offers Undo while its entry is the newest of the history.
 */
export function Toaster() {
  const notices = useSession((s) => s.notices);
  const dismiss = useSession((s) => s.dismissNotice);

  useEffect(() => {
    if (notices.length === 0) return undefined;
    const first = notices[0]!;
    const t = setTimeout(() => dismiss(first.id), 5000);
    return () => clearTimeout(t);
  }, [notices, dismiss]);

  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none absolute right-4 bottom-10 flex flex-col gap-2">
      {notices.map((n) => (
        <output
          key={n.id}
          className="pointer-events-auto rounded border border-border bg-surface px-3 py-2 text-sm shadow-sm"
        >
          {n.text}
          {n.undo && <UndoButton notice={n} />}
          <button
            type="button"
            className="ml-3 text-muted text-xs"
            onClick={() => dismiss(n.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </output>
      ))}
    </div>
  );
}

/** Undo of a notice's entry: shown while it is the newest one, so it never takes back a later edit. */
function UndoButton({ notice }: { notice: Notice }) {
  const { store } = useApp();
  const newest = useSession((s) => s.edit.past.at(-1) === notice.undo && !s.edit.group);
  if (!newest) return null;
  const undo = (): void => {
    const s = store.getState();
    if (s.edit.past.at(-1) === notice.undo && !s.edit.group) s.undo();
    s.dismissNotice(notice.id);
  };
  return (
    <button type="button" className="ml-3 font-medium text-accent text-xs underline" onClick={undo}>
      Undo
    </button>
  );
}
