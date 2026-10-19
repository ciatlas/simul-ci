import type { AssumeEntry, Diagnostic } from '@simulci/engine';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useApp, useSession } from '../app/providers';
import type { PlanState } from '../state/store';
import { withEntry, withoutEntry } from '../scenario/apply-pin';
import { type AssumptionRow, assumptionRows, entryIds, entryLabel, issuesOf } from './assumption-rows';
import { SectionTitle } from './kit';
import { draftOfEntry, type PinContext } from './pin-draft';
import { PinEditor } from './PinEditor';
import { appliedText } from './unknown-rows';

/**
 * The Assumptions list (synthesis § 7): the case layer made visible, exactly the generated case's `assume` in order.
 * Each entry says where it applied and what the plan's diagnostics say of it once a plan simulated with the list
 * answers it, and opens in the PinEditor or goes. The worker's refusal of the layer shows on the entries it names,
 * before the first plan too. Nothing shows while the layer is empty.
 */

interface Props {
  /** The last entry went: the tab puts the focus somewhere that stays. */
  onEmptied?: () => void;
}

/** The case layer's entries above the unknowns; nothing while there is none. */
export function Assumptions({ onEmptied }: Props) {
  const assume = useSession((s) => s.assume);
  if (assume.length === 0) return null;
  return <AssumptionList assume={assume} onEmptied={onEmptied} />;
}

/** What a row says where it applied while no plan simulated with the list has come. */
const PENDING = 'where it applies shows with the next plan';

const STATUS: Record<Exclude<AssumptionRow['status'], 'ok'>, { text: string; className: string }> = {
  error: { text: 'invalid for tests', className: 'border-danger bg-danger-soft text-danger' },
  warning: { text: 'warning', className: 'border-might bg-might-soft text-text' },
  info: { text: 'note', className: 'border-border bg-chrome text-muted' },
};

function AssumptionList({
  assume,
  onEmptied,
}: {
  assume: AssumeEntry[];
  onEmptied: (() => void) | undefined;
}) {
  const { store } = useApp();
  const plan = useSession((s) => s.plan);
  const error = useSession((s) => s.error);
  const models = useSession((s) => s.engine.models);
  // The plan names the entries by position: a plan simulated with another list says nothing of these.
  const answer = plan && answers(plan, assume) ? plan : undefined;
  const rows = useMemo(() => assumptionRows(assume, answer), [assume, answer]);
  const ctx = useMemo<PinContext | undefined>(
    () => plan && { plan: plan.plan, derived: plan.derived, models },
    [plan, models],
  );
  const refused = error?.kind === 'assume' ? (error.issues ?? []) : [];
  // An entry's row, its editor with it, follows the entry when a removal moves it.
  const [ids] = useState(entryIds);
  const keys = ids.of(assume);
  const items = useRef(new Map<number, HTMLElement>());
  const removed = useRef<number>(undefined);

  // After a removal the focus goes to the entry now in its place, else the one before.
  useEffect(() => {
    const at = removed.current;
    if (at === undefined) return;
    removed.current = undefined;
    items.current
      .get(Math.min(at, assume.length - 1))
      ?.querySelector('button')
      ?.focus();
  }, [assume]);

  const remove = (index: number): void => {
    const s = store.getState();
    const last = s.assume.length === 1;
    removed.current = index;
    s.setAssume(withoutEntry(s.assume, index));
    if (last) onEmptied?.();
  };
  const replace = (index: number, entry: AssumeEntry): void => {
    const s = store.getState();
    ids.carry(s.assume, index, entry);
    s.setAssume(withEntry(s.assume, entry, index));
  };

  return (
    <section aria-label="Assumptions" className="flex flex-col gap-2">
      <SectionTitle>Assumptions</SectionTitle>
      <ol className="flex flex-col gap-2">
        {rows.map((row) => (
          <Item
            key={keys[row.index]}
            row={row}
            ctx={ctx}
            issues={issuesOf(refused, row.index)}
            register={(el) => {
              if (el) items.current.set(row.index, el);
              else items.current.delete(row.index);
            }}
            onReplace={(entry) => replace(row.index, entry)}
            onRemove={() => remove(row.index)}
          />
        ))}
      </ol>
    </section>
  );
}

interface ItemProps {
  row: AssumptionRow;
  /** What the editor is decided against; without a plan the entry cannot be edited, only removed. */
  ctx: PinContext | undefined;
  /** The worker's refusal of this entry. */
  issues: string[];
  register: (el: HTMLElement | null) => void;
  onReplace: (entry: AssumeEntry) => void;
  onRemove: () => void;
}

const button =
  'rounded border border-border bg-surface px-2 py-0.5 text-text text-xs hover:border-border-strong';

function Item({ row, ctx, issues, register, onReplace, onRemove }: ItemProps) {
  const [editing, setEditing] = useState(false);
  const edit = useRef<HTMLButtonElement>(null);
  const editor = useId();
  const label = entryLabel(row.entry);
  const invalid = row.status === 'error' || issues.length > 0;
  const close = (): void => {
    setEditing(false);
    edit.current?.focus();
  };
  return (
    <li
      ref={register}
      className={`flex flex-col gap-1.5 rounded border p-2 text-xs ${invalid ? 'border-danger' : 'border-border'}`}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-all font-mono text-text">{label}</span>
        <StatusChip status={row.status} />
      </div>
      <p className="text-muted">{row.applied ? appliedText(row.applied) : PENDING}</p>
      <Diagnostics diagnostics={row.diagnostics} />
      {issues.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-danger">
          {issues.map((message, i) => (
            <li key={`${i}:${message}`}>
              <span className="sr-only">refused: </span>
              {message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {ctx && (
          <button
            ref={edit}
            type="button"
            aria-expanded={editing}
            aria-controls={editing ? editor : undefined}
            aria-label={`Edit ${label}`}
            onClick={() => setEditing((e) => !e)}
            className={button}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={() => {
            setEditing(false);
            onRemove();
          }}
          className={button}
        >
          Remove
        </button>
      </div>
      {editing && ctx && (
        <div id={editor}>
          <PinEditor
            key={JSON.stringify(row.entry)}
            draft={draftOfEntry(row.entry, ctx)}
            issues={issues}
            onApply={(entry) => {
              onReplace(entry);
              close();
            }}
            onCancel={close}
          />
        </div>
      )}
    </li>
  );
}

/** The entry's worst diagnostic as a word; an entry the plan has nothing against shows none. */
function StatusChip({ status }: { status: AssumptionRow['status'] }) {
  if (status === 'ok') return null;
  const chip = STATUS[status];
  return <span className={`shrink-0 rounded border px-1 text-[10px] ${chip.className}`}>{chip.text}</span>;
}

function Diagnostics({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {diagnostics.map((d, i) => (
        <li key={`${i}:${d.code}`} className={d.severity === 'error' ? 'text-danger' : 'text-text'}>
          <span className="sr-only">{d.severity}: </span>
          <span className="font-mono">{d.code}</span> {d.message}
        </li>
      ))}
    </ul>
  );
}

/** Whether a plan was simulated with this case layer (a plan that does not say is taken at its word). */
const answers = (plan: PlanState, assume: AssumeEntry[]): boolean =>
  plan.for.assume === undefined || plan.for.assume === assume;
