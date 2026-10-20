import type { AssumeEntry, NodeId, UnknownId } from '@simulci/engine';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApp, useSession } from '../app/providers';
import { type PlanIndex, selectionOf } from '../plan/index';
import { applyScenarioPin, type PinControl, pinControl, withEntry } from '../scenario/apply-pin';
import type { PlanState } from '../state/store';
import { LocLink } from './kit';
import { PinEditor } from './PinEditor';
import { affectsText, type PinTarget, pinTarget, type UnknownRowModel } from './unknown-rows';

/**
 * One unknown of the Unknowns tab: its unit path, its kind, what it affects (a click selects the first; the pointer or
 * the focus on it dims every card it does not affect), where it is read, and the control that pins it. A scenario pin
 * writes the form and hands it the focus; an assume entry written here is a pin too, and leaves the focus in the
 * panel, which moves it to the next row once the next plan drops this one. The row itself takes the focus then, and
 * when a reason asks for it.
 */

interface Props {
  row: UnknownRowModel;
  plan: PlanState;
  index: PlanIndex;
  /** The row's element, so the tab can put the focus on it after a pin or when a reason asks for it. */
  register: (el: HTMLElement | null) => void;
  /** An assume entry was written from the row: the next plan should drop it. */
  onPinned: () => void;
}

const button =
  'rounded border border-border bg-surface px-2 py-0.5 text-text text-xs hover:border-border-strong';

/** A row of the Unknowns tab, keyed by the unknown's id so its editor survives a new plan. */
export function UnknownRow({ row, plan, index, register, onPinned }: Props) {
  const models = useSession((s) => s.engine.models);
  const control = useMemo(
    () => pinControl(row.unknown, { plan: plan.plan, derived: plan.derived, models }),
    [row.unknown, plan, models],
  );
  return (
    // Not focusable of itself, so a click on its text rings nothing: the tab makes it focusable for the focus it puts
    // there (after a pin, or when "Show … in Unknowns" asks), which draws the ring keyboard focus has.
    <li
      ref={register}
      data-unknown={row.unknown.id}
      className="flex flex-col gap-1.5 border-border border-b py-2 last:border-b-0 focus:outline-2 focus:outline-accent focus:outline-offset-1"
    >
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-text text-xs">{row.path}</code>
        <span className="shrink-0 rounded bg-unknown-soft px-1 font-mono text-[10px] text-unknown">
          {row.kind}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Affects row={row} index={index} />
        {row.reads.map((loc) => (
          <LocLink key={`${loc.file}:${loc.line}:${loc.column}`} loc={loc} />
        ))}
      </div>
      <Control control={control} onPinned={onPinned} />
    </li>
  );
}

/**
 * `affects n`: its title names the nodes, a click selects the first, the pointer or the focus on it dims every other
 * card; the disclosure beside it lists them all.
 */
function Affects({ row, index }: { row: UnknownRowModel; index: PlanIndex }) {
  const { store } = useApp();
  const [open, setOpen] = useState(false);
  const list = useId();
  const [first] = row.affects;
  if (!first) return <span className="text-muted">decides no verdict</span>;
  const { text, names } = affectsText(row.affects);
  const select = (id: NodeId): void => {
    const next = selectionOf(index, id);
    store.getState().select(next.focus, next.sel);
  };
  return (
    <>
      <AffectsCount
        id={row.unknown.id}
        title={names}
        label={`${text}: ${names}; select ${first.label}`}
        onClick={() => select(first.id)}
      >
        {text}
      </AffectsCount>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={list}
        aria-label={`List what ${row.path} affects`}
        onClick={() => setOpen((o) => !o)}
        className="rounded px-1 text-muted hover:text-text"
      >
        {open ? '▾' : '▸'}
      </button>
      <ul
        id={list}
        hidden={!open}
        aria-label={`What ${row.path} affects`}
        className="flex basis-full flex-col pl-2"
      >
        {row.affects.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => select(a.id)}
              className="rounded px-1 text-left text-text hover:bg-chrome"
            >
              {a.label}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

interface CountProps {
  id: UnknownId;
  title: string;
  label: string;
  onClick: () => void;
  children: string;
}

/** The `affects n` button, which holds the store's hovered unknown while the pointer or the focus is on it. */
function AffectsCount({ id, title, label, onClick, children }: CountProps) {
  const { enter, pointerLeft, blurred } = useHoverUnknown(id);
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      onClick={onClick}
      onPointerEnter={enter}
      onPointerLeave={pointerLeft}
      onFocus={enter}
      onBlur={blurred}
      className="rounded px-1 text-text underline decoration-dotted underline-offset-2 hover:bg-chrome"
    >
      {children}
    </button>
  );
}

/** The count an event is on: the pointer and the focus events both carry it. */
interface OnCount {
  currentTarget: Element;
}

interface Hover {
  enter: () => void;
  /** The pointer left the count: the keyboard focus on it still holds the unknown. */
  pointerLeft: (e: OnCount) => void;
  /** The focus left the count: the pointer still over it holds the unknown. */
  blurred: (e: OnCount) => void;
}

/**
 * Hovering an unknown, which the pointer and the focus on its count hold in the store's one slot: entering sets it.
 * Each leaving lets go only while the other does not still hold it, so the pointer passing over a count the keyboard
 * is on, or the focus leaving one the pointer is over, keeps the dim. The pointer asks for the keyboard's focus
 * (`:focus-visible`), not any focus: the focus a click leaves on the button does not keep the cards dimmed once the
 * pointer goes. Either lets go only while the store still holds this one (the pointer may already be on another
 * row's count). A button that goes while hovered, its row dropped by the plan a pin brought, clears it too, so no
 * card stays dimmed.
 */
function useHoverUnknown(id: UnknownId): Hover {
  const { store } = useApp();
  const clear = useCallback(() => {
    const s = store.getState();
    if (s.hoveredUnknown === id) s.hoverUnknown(undefined);
  }, [store, id]);
  useEffect(() => clear, [clear]);
  /** Lets go unless the count still matches `held`, the state of the other that holds it. */
  const leave =
    (held: string) =>
    (e: OnCount): void => {
      if (!e.currentTarget.matches(held)) clear();
    };
  return {
    enter: () => store.getState().hoverUnknown(id),
    pointerLeft: leave(':focus-visible'),
    blurred: leave(':hover'),
  };
}

function Control({ control, onPinned }: { control: PinControl; onPinned: () => void }) {
  if (control.kind === 'none') return <p className="text-muted text-xs">{control.text}</p>;
  if (control.kind === 'scenario') return <ScenarioPin control={control} />;
  if (control.kind === 'assume') return <AssumePin control={control} onPinned={onPinned} />;
  return <EditorPin control={control} onPinned={onPinned} />;
}

/** Set …: the fragment merged into the scenario; the form, opened if it was closed, takes the focus. */
function ScenarioPin({ control }: { control: Extract<PinControl, { kind: 'scenario' }> }) {
  const { store } = useApp();
  const apply = (): void => {
    const s = store.getState();
    if (s.ui.prefs.collapsed.left) s.togglePane('left');
    const pinned = applyScenarioPin(s.scenario, control.fragment);
    store.getState().pinScenario(pinned.scenario, pinned.keys, control.focus);
  };
  return (
    <button type="button" onClick={apply} className={`${button} self-start`}>
      {control.label}
    </button>
  );
}

/** The entry the engine wrote (Assume cancelled), added to the case layer as a pin. */
function AssumePin({
  control,
  onPinned,
}: {
  control: Extract<PinControl, { kind: 'assume' }>;
  onPinned: () => void;
}) {
  const { store } = useApp();
  const apply = (): void => {
    const s = store.getState();
    s.pinAssume(withEntry(s.assume, control.entry));
    onPinned();
  };
  return (
    <button type="button" onClick={apply} className={`${button} self-start`}>
      {control.label}
    </button>
  );
}

/**
 * Pin…: the PinEditor under the row, prefilled; Apply adds its entry to the case layer as a pin and closes it. An
 * entry that already states what the unknown is about opens instead, and Apply puts the edit in its place
 * (`pinTarget`).
 */
function EditorPin({
  control,
  onPinned,
}: {
  control: Extract<PinControl, { kind: 'editor' }>;
  onPinned: () => void;
}) {
  const { store } = useApp();
  const [target, setTarget] = useState<PinTarget>();
  const toggle = useRef<HTMLButtonElement>(null);
  const editor = useId();
  const close = (): void => {
    setTarget(undefined);
    toggle.current?.focus();
  };
  const apply = (entry: AssumeEntry): void => {
    const s = store.getState();
    // The entry it edits, where it is now; gone meanwhile, the edit is a new entry.
    const at = target?.replaces === undefined ? -1 : s.assume.indexOf(target.replaces);
    s.pinAssume(withEntry(s.assume, entry, at));
    close();
    onPinned();
  };
  return (
    <>
      <button
        ref={toggle}
        type="button"
        aria-expanded={target !== undefined}
        aria-controls={target ? editor : undefined}
        onClick={() => setTarget(target ? undefined : pinTarget(store.getState().assume, control.draft))}
        className={`${button} self-start`}
      >
        {control.label}
      </button>
      {target && (
        <div id={editor}>
          <PinEditor draft={target.draft} onApply={apply} onCancel={close} />
        </div>
      )}
    </>
  );
}
