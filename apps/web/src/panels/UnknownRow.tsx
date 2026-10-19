import type { AssumeEntry, NodeId } from '@simulci/engine';
import { useId, useMemo, useRef, useState } from 'react';
import { useApp, useSession } from '../app/providers';
import { type PlanIndex, selectionOf } from '../plan/index';
import { applyScenarioPin, type PinControl, pinControl, withEntry } from '../scenario/apply-pin';
import type { PlanState } from '../state/store';
import { LocLink } from './kit';
import { PinEditor } from './PinEditor';
import { affectsText, type UnknownRowModel } from './unknown-rows';

/**
 * One unknown of the Unknowns tab: its unit path, its kind, what it affects (a click selects the first), where it is
 * read, and the control that pins it. A scenario pin writes the form and hands it the focus; an assume entry written
 * here leaves the focus in the panel, which moves it once the next plan drops the row.
 */

interface Props {
  row: UnknownRowModel;
  plan: PlanState;
  index: PlanIndex;
  /** The row's element, so the tab can put the focus on it after a pin. */
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
    <li ref={register} className="flex flex-col gap-1.5 border-border border-b py-2 last:border-b-0">
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

/** `affects n`: its title names the nodes, a click selects the first; the disclosure beside it lists them all. */
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
      <button
        type="button"
        title={names}
        aria-label={`${text}: ${names}; select ${first.label}`}
        onClick={() => select(first.id)}
        className="rounded px-1 text-text underline decoration-dotted underline-offset-2 hover:bg-chrome"
      >
        {text}
      </button>
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

/** The entry the engine wrote (Assume cancelled), added to the case layer. */
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
    s.setAssume(withEntry(s.assume, control.entry));
    onPinned();
  };
  return (
    <button type="button" onClick={apply} className={`${button} self-start`}>
      {control.label}
    </button>
  );
}

/** Pin…: the PinEditor under the row, prefilled; Apply adds its entry to the case layer and closes it. */
function EditorPin({
  control,
  onPinned,
}: {
  control: Extract<PinControl, { kind: 'editor' }>;
  onPinned: () => void;
}) {
  const { store } = useApp();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const editor = useId();
  const close = (): void => {
    setOpen(false);
    toggle.current?.focus();
  };
  const apply = (entry: AssumeEntry): void => {
    const s = store.getState();
    s.setAssume(withEntry(s.assume, entry));
    close();
    onPinned();
  };
  return (
    <>
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        aria-controls={open ? editor : undefined}
        onClick={() => setOpen((o) => !o)}
        className={`${button} self-start`}
      >
        {control.label}
      </button>
      {open && (
        <div id={editor}>
          <PinEditor draft={control.draft} onApply={apply} onCancel={close} />
        </div>
      )}
    </>
  );
}
