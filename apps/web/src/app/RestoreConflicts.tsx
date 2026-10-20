import { useMemo } from 'react';
import { clockOf } from '../state/snapshot';
import type { RestoreConflict } from '../state/store';
import { DiffCounts, diffOf, UnifiedDiff } from './DiffView';
import { useSession } from './providers';

const button = 'rounded border border-border bg-surface px-2 py-1 text-xs hover:border-border-strong';

const WHY: Record<RestoreConflict['reason'], (name: string, at: string) => string> = {
  changed: (name, at) => `${name} changed since your unsaved edits of ${at}.`,
  gone: (name, at) => `${name} is gone from the folder; your unsaved edits of ${at} kept it.`,
  exists: (name, at) => `${name} is in the folder now; your unsaved edits of ${at} had created it.`,
};

/**
 * The unsaved edits the crash snapshot kept for files that changed since (synthesis § 5.6), one row each, with the
 * diff from the folder's file to the kept text: Restore mine puts the kept text back as one undoable entry, Keep disk
 * leaves the file as it is. Until every row is settled the snapshot is left as it was, so nothing kept is lost.
 */
export function RestoreConflicts() {
  const offer = useSession((s) => s.edit.restore);
  const settle = useSession((s) => s.settleRestore);
  if (!offer) return null;
  const at = clockOf(offer.at);
  return (
    <section
      aria-label="Unsaved edits to restore"
      className="flex flex-col gap-2 border-border border-b bg-might-soft px-4 py-2 text-sm"
    >
      {offer.conflicts.map((c) => (
        <ConflictRow key={c.path} conflict={c} at={at} settle={(keep) => settle(c.path, keep)} />
      ))}
    </section>
  );
}

function ConflictRow({
  conflict,
  at,
  settle,
}: {
  conflict: RestoreConflict;
  at: string;
  settle: (keep: 'mine' | 'disk') => void;
}) {
  const disk = useSession((s) => s.files.byPath[conflict.path]);
  const diff = useMemo(() => diffOf(disk, conflict.text), [disk, conflict.text]);
  const name = conflict.path.slice(conflict.path.lastIndexOf('/') + 1);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0">{WHY[conflict.reason](name, at)}</span>
        <DiffCounts diff={diff} />
        <span className="flex gap-2">
          <button type="button" className={button} onClick={() => settle('mine')}>
            Restore mine
          </button>
          <button type="button" className={button} onClick={() => settle('disk')}>
            Keep disk
          </button>
        </span>
      </div>
      <details>
        <summary className="cursor-pointer text-xs">Compare the folder's {name} with your edits</summary>
        <UnifiedDiff diff={diff} label={`${name}: the folder's text against your unsaved edits`} />
      </details>
    </div>
  );
}
