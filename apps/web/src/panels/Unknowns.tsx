import type { NodeId, RunPlan } from '@simulci/engine';
import { type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSession } from '../app/providers';
import { Assumptions } from './Assumptions';
import { EmptyNote, type Selected, useSelected } from './kit';
import { planLabels } from './outline-tree';
import { UnknownRow } from './UnknownRow';
import { focusAfter, type UnknownRowModel, unknownRows } from './unknown-rows';

/**
 * The Unknowns tab (synthesis § 7), the mock-authoring surface: the Assumptions list, then the unknowns, those that
 * decide a verdict first and the rest collapsed, each with its pin control. A toggle keeps the ones that affect the
 * selection. A pin never updates the list itself: the next plan drops the row, and the focus moves to the next one.
 */
export function Unknowns() {
  const selected = useSelected();
  if (!selected) return <EmptyNote>The unknowns show with the first plan.</EmptyNote>;
  return <UnknownList selected={selected} />;
}

function UnknownList({ selected }: { selected: Selected }) {
  const { plan, index, node } = selected;
  const focus = useSession((s) => s.focus);
  const [affecting, setAffecting] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const labels = useMemo(() => planLabels(plan.plan), [plan.plan]);
  // The toggle is about a node inside the focused workflow; the workflow itself is every unknown already.
  const narrowed = node !== undefined && node !== focus ? node : undefined;
  const filter = affecting ? narrowed : undefined;
  const rows = useMemo(
    () => unknownRows(plan.plan, plan.derived, index, { affecting: filter }),
    [plan, index, filter],
  );
  const shown = [...rows.gating, ...(idleOpen ? rows.idle : [])].map((r) => r.unknown.id);
  const pins = usePinFocus(plan.plan, shown);
  const label = narrowed === undefined ? '' : (labels.get(narrowed) ?? narrowed);

  const row = (r: UnknownRowModel) => (
    <UnknownRow
      key={r.unknown.id}
      row={r}
      plan={plan}
      index={index}
      register={pins.register(r.unknown.id)}
      onPinned={() => pins.pinned(r.unknown.id)}
    />
  );

  return (
    <section ref={pins.section} aria-labelledby={pins.headingId} className="flex flex-col gap-4">
      <Assumptions onEmptied={() => pins.heading.current?.focus()} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3
            ref={pins.heading}
            id={pins.headingId}
            tabIndex={-1}
            className="font-medium text-muted text-xs uppercase tracking-wide"
          >
            Unknowns
          </h3>
          <AffectingToggle node={narrowed} label={label} on={affecting} onChange={setAffecting} />
        </div>
        <Rows
          total={plan.plan.unknowns.length}
          filtered={filter === undefined ? undefined : label}
          gating={rows.gating.map(row)}
          idle={rows.idle.map(row)}
          idleOpen={idleOpen}
          setIdleOpen={setIdleOpen}
        />
      </div>
    </section>
  );
}

interface PinFocus {
  section: RefObject<HTMLElement | null>;
  heading: RefObject<HTMLHeadingElement | null>;
  headingId: string;
  /** The ref callback of a row, by unknown id. */
  register: (id: string) => (el: HTMLElement | null) => void;
  /** A row wrote an assume entry: the next plan should drop it. */
  pinned: (id: string) => void;
}

/**
 * The focus after a pin: when the next plan drops the pinned row and the focus went with it (or is still in the
 * tab), the next row shown takes it, else the one before, else the tab's heading. A pin the plan did not take leaves
 * the focus where it is; the author's focus elsewhere is never moved.
 */
function usePinFocus(plan: RunPlan, shown: string[]): PinFocus {
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const items = useRef(new Map<string, HTMLElement>());
  const pending = useRef<{ id: string; order: string[] }>(undefined);

  // Only a new plan answers a pin: the rows shown change with the toggles too.
  useEffect(() => {
    const pin = pending.current;
    pending.current = undefined;
    if (!pin || shown.includes(pin.id) || !focusLost(section.current)) return;
    const target = focusAfter(pin.order, pin.id, new Set(shown));
    const next = target === undefined ? undefined : items.current.get(target)?.querySelector('button');
    (next ?? heading.current)?.focus();
  }, [plan]);

  return {
    section,
    heading,
    headingId,
    register: (id) => (el) => {
      if (el) items.current.set(id, el);
      else items.current.delete(id);
    },
    pinned: (id) => {
      pending.current = { id, order: shown };
    },
  };
}

/** Whether the focus is nowhere (its row went) or still in the tab: then it is the tab's to move. */
function focusLost(section: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || section?.contains(active) === true;
}

interface ToggleProps {
  /** The selected node, when it is not the focused workflow. */
  node: NodeId | undefined;
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}

/** `affecting <selection>`: keeps the unknowns that affect the selected node or a node under it. */
function AffectingToggle({ node, label, on, onChange }: ToggleProps) {
  if (node === undefined) return null;
  return (
    <label className="flex min-w-0 items-center gap-1.5 text-muted text-xs">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      affecting <span className="truncate font-mono text-text">{label}</span>
    </label>
  );
}

interface RowsProps {
  /** The plan's unknowns, before the filter. */
  total: number;
  /** The selection's label while the toggle keeps what affects it. */
  filtered: string | undefined;
  gating: ReactNode[];
  idle: ReactNode[];
  idleOpen: boolean;
  setIdleOpen: (open: boolean) => void;
}

function Rows({ total, filtered, gating, idle, idleOpen, setIdleOpen }: RowsProps) {
  if (total === 0)
    return (
      <p role="status" className="self-start rounded bg-chrome px-1.5 py-0.5 text-muted text-xs">
        no unknowns
      </p>
    );
  if (filtered !== undefined && gating.length + idle.length === 0)
    return <EmptyNote>No unknown affects {filtered}.</EmptyNote>;
  return (
    <>
      {gating.length > 0 ? (
        <ul aria-label="Unknowns that decide a verdict" className="flex flex-col">
          {gating}
        </ul>
      ) : (
        <EmptyNote>No unknown decides a verdict.</EmptyNote>
      )}
      <Idle rows={idle} more={gating.length > 0} open={idleOpen} setOpen={setIdleOpen} />
    </>
  );
}

/** The unknowns that decide no verdict, collapsed: `N more that decide no verdict`. */
function Idle({
  rows,
  more,
  open,
  setOpen,
}: {
  rows: ReactNode[];
  more: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const n = rows.length;
  if (n === 0) return null;
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-default text-muted text-xs hover:text-text">
        {n} {more ? 'more ' : ''}that {n === 1 ? 'decides' : 'decide'} no verdict
      </summary>
      <ul aria-label="Unknowns that decide no verdict" className="flex flex-col">
        {rows}
      </ul>
    </details>
  );
}
