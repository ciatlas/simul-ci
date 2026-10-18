import { useEffect } from 'react';
import { useSession } from './providers';

/** Short notices (a restart, no changes on reload); each goes after five seconds or a click. */
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
