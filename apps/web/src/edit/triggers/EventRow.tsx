import type { FilterKey } from '@simulci/document';
import { useId, useState } from 'react';
import { LineLink } from '../property/Field';
import { RefusalNote } from '../Refusal';
import { ChipList, CheckMark, Row, SMALL_BUTTON } from './Chips';
import { at, useGesture, useTriggers } from './context';
import { DispatchInputs } from './Inputs';
import { type EventRow as Model, type FilterRow, filterCheck, typesCheck } from './model';
import { Schedule } from './Schedule';

/**
 * One event of the workflow's `on:` (synthesis § 4.6): its radio, which makes it the scenario's event, then its filters
 * as chips, its activity types, its schedule or its dispatch inputs, each row ending in what the plan says of it.
 */
export function EventRow({
  row,
  only,
  simulated,
  onSimulate,
}: {
  row: Model;
  /** The workflow's only event. */
  only: boolean;
  simulated: boolean;
  onSimulate: () => void;
}) {
  const { file, locked } = useTriggers();
  const id = useId();
  const [adding, setAdding] = useState<FilterKey>();
  // A fix of the new filter's refusal (Switch to branches) wrote it: its row takes over.
  if (adding && row.filters.some((f) => f.key === adding)) setAdding(undefined);
  return (
    <li className="flex flex-col gap-1" data-event={row.event}>
      <div className="flex flex-wrap items-center gap-x-2">
        <input
          type="radio"
          name="trigger-event"
          id={id}
          checked={simulated}
          // A reusable workflow's interface: the workflows that call it run it, not an event.
          disabled={row.event === 'workflow_call'}
          onChange={onSimulate}
        />
        <label htmlFor={id} className="min-w-0 flex-1 font-mono text-sm">
          {row.event}
        </label>
        {!locked && row.addable.length > 0 && (
          <FilterPicker event={row.event} keys={row.addable} onPick={setAdding} />
        )}
        {!locked && <RemoveEvent event={row.event} only={only} />}
      </div>
      {row.odd && (
        <Row name="">
          <span className="text-muted text-xs">written as YAML these rows cannot hold </span>
          <LineLink file={file} line={row.line} label="Edit in YAML" />
        </Row>
      )}
      {row.filters.map((filter) => (
        <Filter key={filter.key} event={row.event} filter={filter} twin={hasTwin(row, filter.key)} />
      ))}
      {adding && <NewFilter event={row.event} filter={adding} onDone={() => setAdding(undefined)} />}
      {row.types && <Types row={row} />}
      {row.crons && <Schedule crons={row.crons} only={only} />}
      {row.inputs && <DispatchInputs inputs={row.inputs} />}
      {row.other.map(({ key, line }) => (
        <Row key={key} name={key}>
          <LineLink file={file} line={line} label="Edit in YAML" />
        </Row>
      ))}
    </li>
  );
}

const TWIN: Record<FilterKey, FilterKey> = {
  branches: 'branches-ignore',
  'branches-ignore': 'branches',
  tags: 'tags-ignore',
  'tags-ignore': 'tags',
  paths: 'paths-ignore',
  'paths-ignore': 'paths',
};

const hasTwin = (row: Model, key: FilterKey): boolean => row.filters.some((f) => f.key === TWIN[key]);

/**
 * × on the event. The workflow's only event asks first: with no event nothing runs the workflow, and `on:` is left
 * with no value.
 */
function RemoveEvent({ event, only }: { event: string; only: boolean }) {
  const { file } = useTriggers();
  const { refused, run } = useGesture();
  const [asking, setAsking] = useState(false);
  const remove = (): void => {
    setAsking(false);
    run({ op: 'removeEvent', file, event }, `removed the ${event} trigger`, at.addEvent);
  };
  return (
    <>
      <button
        type="button"
        className={SMALL_BUTTON}
        aria-label={`Remove the ${event} trigger`}
        aria-expanded={only ? asking : undefined}
        onClick={() => (only ? setAsking(!asking) : remove())}
      >
        ×
      </button>
      {asking && (
        <div role="group" aria-label={`Remove ${event}?`} className="basis-full pl-5 text-xs">
          <p>{event} is the workflow’s only trigger: without it, nothing runs the workflow.</p>
          <div className="mt-1 flex gap-1.5">
            <button type="button" className="rounded border border-danger px-2 py-0.5" onClick={remove}>
              Remove {event}
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-0.5"
              onClick={() => setAsking(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
      <div className="basis-full">
        <RefusalNote seq={refused} />
      </div>
    </>
  );
}

/** A filter's patterns as chips, its check, and ⋯ for switching it to its twin or removing it. */
function Filter({ event, filter, twin }: { event: string; filter: FilterRow; twin: boolean }) {
  const { file, locked, chain, behind } = useTriggers();
  const { refused, run } = useGesture();
  const label = `${event}'s ${filter.key}`;
  const set = (patterns: string[] | null, words: string): boolean =>
    run({ op: 'setFilter', file, event, filter: filter.key, patterns }, words, at.addFilter(event));
  return (
    <div data-filter={filter.key}>
      <Row
        name={filter.key}
        end={
          <>
            <CheckMark check={filterCheck(chain(event), filter.key)} behind={behind} />
            {!locked && <FilterMenu event={event} filter={filter.key} twin={twin} run={run} />}
          </>
        }
      >
        <ChipList
          label={label}
          noun="pattern"
          values={filter.patterns}
          locked={locked}
          onRemove={(i) => {
            const rest = filter.patterns.filter((_, k) => k !== i);
            set(rest.length ? rest : null, `removed ${filter.patterns[i]} from ${label}`);
          }}
          onAdd={(value) => set([...filter.patterns, value], `added ${value} to ${label}`)}
        />
      </Row>
      <RefusalNote seq={refused} />
    </div>
  );
}

const MENU_ITEM = 'rounded border border-border px-1.5 text-xs hover:bg-chrome';

/** ⋯: switch the filter to its twin (`branches` to `branches-ignore`), or remove it. */
function FilterMenu({
  event,
  filter,
  twin,
  run,
}: {
  event: string;
  filter: FilterKey;
  twin: boolean;
  run: ReturnType<typeof useGesture>['run'];
}) {
  const { file } = useTriggers();
  const [open, setOpen] = useState(false);
  const id = useId();
  const other = TWIN[filter];
  const take = (op: Parameters<typeof run>[0], words: string, focus: string): void => {
    setOpen(false);
    run(op, words, focus);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        data-more
        className={SMALL_BUTTON}
        aria-label={`More for ${event}'s ${filter}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        ⋯
      </button>
      <span
        id={id}
        role="group"
        hidden={!open}
        aria-label={`${event}'s ${filter}`}
        className="inline-flex gap-1"
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        {!twin && (
          <button
            type="button"
            className={MENU_ITEM}
            onClick={() =>
              take(
                { op: 'switchFilter', file, event, from: filter, to: other },
                `switched ${event}'s ${filter} to ${other}`,
                at.filterMore(event, other),
              )
            }
          >
            Switch to {other}
          </button>
        )}
        <button
          type="button"
          className={MENU_ITEM}
          onClick={() =>
            take(
              { op: 'setFilter', file, event, filter, patterns: null },
              `removed ${event}'s ${filter}`,
              at.addFilter(event),
            )
          }
        >
          Remove filter
        </button>
      </span>
    </span>
  );
}

/** + filter: the filters the event reads and lacks; the one picked opens a row of its own for its first pattern. */
function FilterPicker({
  event,
  keys,
  onPick,
}: {
  event: string;
  keys: FilterKey[];
  onPick: (key: FilterKey) => void;
}) {
  return (
    <select
      data-add-filter
      className="max-w-28 rounded border border-border bg-surface px-1 py-px text-muted text-xs"
      aria-label={`Add a filter to ${event}`}
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value as FilterKey)}
    >
      <option value="">+ filter</option>
      {keys.map((key) => (
        <option key={key} value={key}>
          {key}
        </option>
      ))}
    </select>
  );
}

/** A filter being added: its first pattern typed in place; Enter writes it, Escape or an empty blur lets it go. */
function NewFilter({ event, filter, onDone }: { event: string; filter: FilterKey; onDone: () => void }) {
  const { file } = useTriggers();
  const { refused, run } = useGesture();
  const add = (value: string): boolean => {
    const words = `added ${value} to ${event}'s ${filter}`;
    const added = run(
      { op: 'setFilter', file, event, filter, patterns: [value] },
      words,
      at.filterAdd(event, filter),
    );
    if (added) onDone();
    return added;
  };
  return (
    <>
      <Row name={filter}>
        <ChipList
          key={filter}
          label={`${event}'s ${filter}`}
          noun="pattern"
          values={[]}
          locked={false}
          open
          onClose={onDone}
          onRemove={() => undefined}
          onAdd={add}
        />
      </Row>
      <RefusalNote seq={refused} />
    </>
  );
}

/** The activity types: the written ones as chips, else the defaults in grey; + narrows the list to what it holds. */
function Types({ row }: { row: Model }) {
  const { file, locked, chain, behind } = useTriggers();
  const { refused, run } = useGesture();
  const types = row.types!;
  const label = `${row.event}'s types`;
  const written = types.written ? types.values : [];
  const set = (next: string[], words: string): boolean =>
    run({ op: 'setTypes', file, event: row.event, types: next.length ? next : null }, words);
  return (
    <>
      <Row name="types" end={<CheckMark check={typesCheck(chain(row.event))} behind={behind} />}>
        <ChipList
          label={label}
          noun="type"
          values={types.values}
          defaults={!types.written}
          suggest={types.all.filter((t) => !written.includes(t))}
          locked={locked}
          onRemove={(i) =>
            set(
              written.filter((_, k) => k !== i),
              `removed ${written[i]} from ${label}`,
            )
          }
          onAdd={(value) => set([...written, value], `added ${value} to ${label}`)}
        />
      </Row>
      <RefusalNote seq={refused} />
    </>
  );
}
