import type { NodeId, RunPlan } from '@simulci/engine';
import { type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApp, useSession } from '../app/providers';
import { Assumptions } from './Assumptions';
import { EmptyNote, type Selected, useSelected } from './kit';
import { planLabels } from './outline-tree';
import { UnknownRow } from './UnknownRow';
import {
  focusAfter,
  type RowReveal,
  revealRow,
  type UnknownRowModel,
  type UnknownRows,
  unknownRows,
} from './unknown-rows';

/**
 * The Unknowns tab (synthesis § 7), the mock-authoring surface: the Assumptions list, then the unknowns, those that
 * decide a verdict first and the rest collapsed, each with its pin control. A toggle keeps the ones that affect the
 * selection. A pin never updates the list itself: the next plan drops the row, and the focus moves to the next one.
 * "Show … in Unknowns" in a reason puts the focus on the unknown's row. The Assumptions show before the first plan
 * too, so an entry the worker refuses can be seen and removed.
 */
export function Unknowns() {
  const selected = useSelected();
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const title: Title = { ref: heading, id: useId() };
  // The Assumptions keep their place when the first plan comes, and the focus in them stays.
  return (
    <section ref={section} aria-labelledby={title.id} className="flex flex-col gap-4">
      <Assumptions onEmptied={() => heading.current?.focus()} />
      {selected ? (
        <UnknownList selected={selected} section={section} title={title} />
      ) : (
        <NoPlan title={title} />
      )}
    </section>
  );
}

/** The tab's heading, which takes the focus when what had it went. */
interface Title {
  ref: RefObject<HTMLHeadingElement | null>;
  id: string;
}

function Heading({ title }: { title: Title }) {
  return (
    <h3
      ref={title.ref}
      id={title.id}
      tabIndex={-1}
      className="font-medium text-muted text-xs uppercase tracking-wide"
    >
      Unknowns
    </h3>
  );
}

/** Before the first plan: a request for a row has none to show, so the heading takes the focus. */
function NoPlan({ title }: { title: Title }) {
  useUnknownFocus(undefined, title.ref);
  return (
    <div className="flex flex-col gap-2">
      <Heading title={title} />
      <EmptyNote>The unknowns show with the first plan.</EmptyNote>
    </div>
  );
}

interface ListProps {
  selected: Selected;
  section: RefObject<HTMLElement | null>;
  title: Title;
}

function UnknownList({ selected, section, title }: ListProps) {
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
  const items = useRowElements();
  const pins = usePinFocus(plan.plan, shown, items, section, title.ref);
  useUnknownFocus(
    {
      plan: plan.plan,
      rows,
      idleOpen,
      items,
      show: (reveal) => {
        if (reveal.unfilter) setAffecting(false);
        if (reveal.openIdle) setIdleOpen(true);
      },
    },
    title.ref,
  );
  const label = narrowed === undefined ? '' : (labels.get(narrowed) ?? narrowed);

  const row = (r: UnknownRowModel) => (
    <UnknownRow
      key={r.unknown.id}
      row={r}
      plan={plan}
      index={index}
      register={items.register(r.unknown.id)}
      onPinned={() => pins.pinned(r.unknown.id)}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading title={title} />
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
  );
}

/** The rows' elements by unknown id, which the focus after a pin and a reason's request for a row land on. */
interface RowElements {
  get: (id: string) => HTMLElement | undefined;
  /** The ref callback of a row, by unknown id. */
  register: (id: string) => (el: HTMLElement | null) => void;
}

function useRowElements(): RowElements {
  const items = useRef(new Map<string, HTMLElement>());
  return {
    get: (id) => items.current.get(id),
    register: (id) => (el) => {
      if (el) items.current.set(id, el);
      else items.current.delete(id);
    },
  };
}

interface PinFocus {
  /** A row wrote an assume entry: the next plan should drop it. */
  pinned: (id: string) => void;
}

/**
 * The focus after a pin: when the next plan drops the pinned row and the focus went with it (or is still in the
 * tab), the next row shown takes it, else the one before, else the tab's heading. The row itself takes it, not its
 * first control: that is `affects n`, whose focus would dim the canvas over the cards the pin just flashed. A pin the
 * plan did not take leaves the focus where it is; the author's focus elsewhere is never moved.
 */
function usePinFocus(
  plan: RunPlan,
  shown: string[],
  items: RowElements,
  section: RefObject<HTMLElement | null>,
  heading: RefObject<HTMLHeadingElement | null>,
): PinFocus {
  const pending = useRef<{ id: string; order: string[] }>(undefined);

  // Only a new plan answers a pin: the rows shown change with the toggles too.
  useEffect(() => {
    const pin = pending.current;
    pending.current = undefined;
    if (!pin || shown.includes(pin.id) || !focusLost(section.current)) return;
    const target = focusAfter(pin.order, pin.id, new Set(shown));
    const row = target === undefined ? undefined : items.get(target);
    if (row) focusRow(row);
    else heading.current?.focus();
  }, [plan]);

  return {
    pinned: (id) => {
      pending.current = { id, order: shown };
    },
  };
}

/** What the list shows, for a request to focus a row, and how it shows a row it hides. */
interface ListFocus {
  plan: RunPlan;
  rows: UnknownRows;
  idleOpen: boolean;
  items: RowElements;
  /** Turns the toggle off or opens the collapsed rest, as `revealRow` asks. */
  show: (reveal: RowReveal) => void;
}

/**
 * The answer to "Show … in Unknowns" (the store's `unknownFocus`), whether the tab was open when it came or mounted
 * for it: the row is shown first (the toggle off when it hides the row, the collapsed rest open when it waits there),
 * then scrolled into view and focused, and the request taken. An unknown the plan does not list, or no plan yet, puts
 * the focus on the tab's heading, and the request is taken all the same.
 */
function useUnknownFocus(list: ListFocus | undefined, heading: RefObject<HTMLHeadingElement | null>): void {
  const { store } = useApp();
  const request = useSession((s) => s.unknownFocus);
  useEffect(() => {
    if (!request) return;
    const reveal = revealRow(list, request.id);
    // The next render shows the row; this effect runs again for it.
    if (list && (reveal.unfilter || reveal.openIdle)) {
      list.show(reveal);
      return;
    }
    const row = reveal.target === 'row' ? list?.items.get(request.id) : undefined;
    if (row) focusRow(row);
    else heading.current?.focus();
    store.getState().unknownFocused(request.seq);
  }, [request, list?.plan, list?.rows, list?.idleOpen]);
}

/**
 * The row takes the focus and the panel scrolls only as far as it needs, at once: never smoothly (§ 11). A row is
 * focusable only while it holds a focus the tab put there, so a click on its text neither focuses nor rings it: it
 * becomes focusable here and stops being so when the focus leaves it.
 */
function focusRow(row: HTMLElement): void {
  row.tabIndex = -1;
  row.addEventListener('blur', () => row.removeAttribute('tabindex'), { once: true });
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
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
