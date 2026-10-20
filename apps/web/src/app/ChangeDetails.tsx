import { type SyntheticEvent, useId } from 'react';
import { type ChangeRow, clauseOf } from '../plan/change-rows';
import { useSession } from './providers';

const trigger =
  'rounded border border-border px-1.5 py-0.5 text-muted text-xs hover:border-border-strong hover:text-text';
const item = 'w-full rounded px-1.5 py-0.5 text-left hover:bg-chrome';

/**
 * What the last pin or edit changed, every row of it (synthesis § 7.4): each node and check added, removed or turned,
 * steps and legs and the checks a job's row implies included, which the status line's sentence leaves out or only
 * counts. A row the plan on screen still has is a button that selects it; the popover stays open, so the author can
 * go through them one by one, and Escape or a click outside closes it.
 *
 * It is the platform's popover (`popover`, `popovertarget`), not Base UI's: that one and its positioning cost the
 * page about 33 kB gzipped, and a lazy chunk of it makes rolldown split React out of the page into a chunk of its own.
 * The popover sits in the top layer above the status line, at the page's left edge, so it needs no anchoring; opening
 * it puts the focus on its first row.
 */
export function ChangeDetails({ rows }: { rows: readonly ChangeRow[] }) {
  const id = useId();
  return (
    <>
      <button type="button" className={trigger} popoverTarget={`${id}-popover`}>
        Details
      </button>
      <div
        id={`${id}-popover`}
        popover="auto"
        role="dialog"
        aria-labelledby={`${id}-title`}
        onToggle={focusFirst}
        className="fixed inset-auto bottom-8 left-4 m-0 max-h-[min(24rem,60vh)] w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-border bg-surface p-2 text-text text-xs"
      >
        <h2 id={`${id}-title`} className="px-1.5 pb-1 font-semibold">
          What changed
        </h2>
        <ul aria-label="What changed" className="flex flex-col">
          {rows.map((row) => (
            <li key={`${row.change} ${row.kind} ${row.id} ${row.label}`}>
              <Row row={row} />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** Once open, the first row that selects something takes the focus, as a menu's first item does. */
function focusFirst(event: SyntheticEvent<HTMLDivElement>): void {
  if ((event.nativeEvent as ToggleEvent).newState !== 'open') return;
  event.currentTarget.querySelector<HTMLButtonElement>('li button')?.focus();
}

/** A row in words: a button that selects it while the plan on screen has it, plain text once it is gone. */
function Row({ row }: { row: ChangeRow }) {
  const select = useSession((s) => s.select);
  const target = row.select;
  if (!target) return <span className="block px-1.5 py-0.5 text-muted">{clauseOf(row)}</span>;
  return (
    <button type="button" className={item} onClick={() => select(target.focus, target.sel)}>
      {clauseOf(row)}
    </button>
  );
}
