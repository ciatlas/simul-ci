import type { WorkflowDocument } from '@simulci/document';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp, useSession } from '../../app/providers';
import { eventChoices } from '../../scenario/defaults';
import { withEvent } from '../../scenario/form';
import { newestOutline, type SessionStore } from '../../state/store';
import { storeLock } from '../dispatch';
import { documents } from '../documents';
import { LineLink } from '../property/Field';
import { RefusalNote, RefusalView } from '../Refusal';
import type { Outline } from '../../worker/protocol';
import type { Refused } from '../types';
import { ChipList } from './Chips';
import { at, type Triggers, TriggersContext, useGesture, useTriggers } from './context';
import { EventRow } from './EventRow';
import { addableEvents, chainOf, type EventTable, type TriggerModel, triggerModel } from './model';

/**
 * The focused workflow's `on:` in edit mode, above the scenario fields (synthesis § 4.6): its events as rows read from
 * the file, each a radio that simulates it, with its filters, types, schedule and dispatch inputs editable in place
 * and the plan's ✓ or ✗ at each row's end. Add event offers every event the engine knows; the events only other
 * workflows listen to stay a small select under the rows. Every edit is said in a polite live region.
 */
export function TriggerRows() {
  const { store } = useApp();
  const focus = useSession((s) => s.focus);
  const read = useReadVersion();
  const generated = useSession((s) => s.generated);
  const unlocked = useSession((s) => s.edit.unlocked);
  // The document of the text as of `read`, under its lock, and the revision it is of.
  const shown = useMemo(() => {
    const s = store.getState();
    return focus === undefined ? undefined : { doc: documents(store).of(s, focus), rev: s.files.revs[focus] };
  }, [store, focus, read, generated, unlocked]);
  if (focus === undefined || !shown?.doc) return null;
  return <Editor file={focus} doc={shown.doc} rev={shown.rev} />;
}

/** How long the rows wait for a pause in the pane's typing before reading the text again: the session's cadence. */
const TYPING_MS = 150;

/**
 * The files version the rows are read at: the newest, except while the author types in the YAML pane, when it waits
 * for a pause, so a burst of keys parses the file once (synthesis § 2.1: never a document per key). A gesture in the
 * rows meanwhile refuses `stale`, as the text moved since they were read.
 */
function useReadVersion(): number {
  const version = useSession((s) => s.files.version);
  const typing = useSession((s) => s.edit.group?.origin === 'pane');
  const [read, setRead] = useState(version);
  useEffect(() => {
    if (!typing) return setRead(version);
    const t = setTimeout(() => setRead(version), TYPING_MS);
    return () => clearTimeout(t);
  }, [version, typing]);
  return typing ? read : version;
}

function Editor({ file, doc, rev }: { file: string; doc: WorkflowDocument; rev: number | undefined }) {
  const { store } = useApp();
  const outline = useSession(newestOutline);
  const sent = useSession((s) => s.engine.events);
  const plan = useSession((s) => s.plan?.plan);
  const behind = useSession((s) => s.staleShown !== false);
  const lock = useLock(store, file, doc);
  const [said, setSaid] = useState({ words: '', seq: 0 });
  const section = useRef<HTMLElement>(null);
  const refocus = useRef<string>(undefined);
  const table: EventTable = sent ?? outline?.events ?? NONE;
  const model = useMemo(() => triggerModel(doc, table), [doc, table]);
  useLayoutEffect(() => {
    const selector = refocus.current;
    if (selector === undefined) return;
    refocus.current = undefined;
    const active = document.activeElement;
    if (active && active !== document.body && section.current?.contains(active)) return;
    const root = section.current;
    (
      root?.querySelector<HTMLElement>(selector) ?? root?.querySelector<HTMLElement>('[data-add-event]')
    )?.focus();
  });
  const triggers: Triggers = {
    file,
    doc,
    rev,
    locked: lock !== undefined,
    table,
    ...hintsOf(outline, file),
    chain: (event) => chainOf(plan, file, event),
    behind,
    say: (words, selector) => {
      refocus.current = selector;
      setSaid((s) => ({ words, seq: s.seq + 1 }));
    },
  };
  return (
    <TriggersContext value={triggers}>
      <section ref={section} aria-label="Triggers" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium text-muted text-xs uppercase tracking-wide">On</h2>
          {!triggers.locked && <AddEvent model={model} />}
        </div>
        {lock && (
          <div className="flex flex-col gap-1.5 rounded border border-might bg-might-soft px-2 py-1.5 text-xs">
            <RefusalView refused={lock} dismiss={false} />
          </div>
        )}
        <Rows model={model} />
        <OtherEvents />
        <p aria-live="polite" className="sr-only">
          <span key={said.seq}>{said.words}</span>
        </p>
      </section>
    </TriggersContext>
  );
}

const NONE: EventTable = {};

/** What the Outline knows of the workflow and of its file. */
function hintsOf(outline: Outline | undefined, file: string): Pick<Triggers, 'hints' | 'outlined'> {
  const hints = outline?.workflows.find((w) => w.path === file);
  const outlined = outline?.files.find((f) => f.path === file);
  return { ...(hints ? { hints } : {}), ...(outlined ? { outlined } : {}) };
}

/** Why the file takes no edit, as any op on it would be refused: the store's lock, then the document's. */
function useLock(store: SessionStore, file: string, doc: WorkflowDocument): Refused | undefined {
  const known = useSession((s) => s.generated !== undefined);
  const meta = useSession((s) => s.files.meta[file]);
  return useMemo(() => {
    const refusal =
      storeLock(store.getState(), file) ?? (doc.status.editable ? undefined : doc.status.refusal);
    return refusal ? { seq: 0, refusal, ops: [], at: 0, meta: {} } : undefined;
  }, [store, file, doc, known, meta]);
}

/** The rows, their radios the scenario's event among this workflow's. */
function Rows({ model }: { model: TriggerModel }) {
  const { file } = useTriggers();
  const scenario = useSession((s) => s.scenario);
  const setScenario = useSession((s) => s.setScenario);
  if (model.odd !== undefined)
    return (
      <p className="text-xs">
        <span className="text-muted">
          <code className="font-mono">on:</code> is written as YAML these rows cannot hold.{' '}
        </span>
        <LineLink file={file} line={model.odd} label="Edit in YAML" />
      </p>
    );
  if (model.rows.length === 0)
    return <p className="text-muted text-xs">No event runs this workflow: add one.</p>;
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">The event to simulate</legend>
      <ul className="flex flex-col gap-2">
        {model.rows.map((row) => (
          <EventRow
            key={row.event}
            row={row}
            only={model.rows.length === 1}
            simulated={scenario.event === row.event}
            onSimulate={() => setScenario(withEvent(scenario, row.event))}
          />
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * + Add event: every event of the engine's table the file does not name. A schedule needs its first cron, so it asks
 * for one in place; any other event is added as it is (`push:`, or an item of `on: [a, b]`).
 */
function AddEvent({ model }: { model: TriggerModel }) {
  const { file, table } = useTriggers();
  const { refused, run } = useGesture();
  const [cron, setCron] = useState(false);
  const events = addableEvents(model, table);
  return (
    <div className="flex flex-col items-end gap-1">
      {cron ? (
        <ChipList
          label="a new schedule"
          noun="cron"
          values={[]}
          locked={false}
          open
          onClose={() => setCron(false)}
          onRemove={() => undefined}
          onAdd={(value) => {
            const added = run(
              { op: 'setSchedule', file, crons: [{ cron: value }] },
              'added the schedule trigger',
              at.event('schedule'),
            );
            if (added) setCron(false);
            return added;
          }}
        />
      ) : (
        <select
          data-add-event
          className="max-w-36 rounded border border-border bg-surface px-1 py-px text-xs"
          aria-label="Add an event"
          value=""
          onChange={(e) => {
            const event = e.target.value;
            if (event === 'schedule') setCron(true);
            else if (event) run({ op: 'addEvent', file, event }, `added the ${event} trigger`);
          }}
        >
          <option value="">+ Add event</option>
          {events.map((event) => (
            <option key={event} value={event}>
              {event}
            </option>
          ))}
        </select>
      )}
      <RefusalNote seq={refused} />
    </div>
  );
}

/** The events only other workflows listen to: simulating one leaves this workflow's rows unchecked. */
function OtherEvents() {
  const { file } = useTriggers();
  const outline = useSession(newestOutline);
  const scenario = useSession((s) => s.scenario);
  const setScenario = useSession((s) => s.setScenario);
  const others = useMemo(
    () => (outline ? eventChoices(outline, file).filter((c) => !c.focused) : []),
    [outline, file],
  );
  if (others.length === 0) return null;
  const listed = others.some((c) => c.event === scenario.event);
  return (
    <label className="flex items-center gap-2 text-muted text-xs">
      Other workflows’ events
      <select
        className="min-w-0 rounded border border-border bg-surface px-1 py-px text-text text-xs"
        value={listed ? scenario.event : ''}
        onChange={(e) => e.target.value && setScenario(withEvent(scenario, e.target.value))}
      >
        <option value="">—</option>
        {others.map((c) => (
          <option key={c.event} value={c.event}>
            {c.event}
            {c.listeners > 0 ? ` (${c.listeners})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
