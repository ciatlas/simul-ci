import { type KeyboardEvent, useState } from 'react';
import { RefusalNote } from '../Refusal';
import { ChipList, CheckMark, Row, SMALL_BUTTON } from './Chips';
import { at, useGesture, useTriggers } from './context';
import { type CronRow, cronHint, scheduleCheck } from './model';

type Cron = { cron: string; timezone?: string };

const plain = (rows: readonly CronRow[]): Cron[] =>
  rows.map(({ cron, timezone }) => (timezone === undefined ? { cron } : { cron, timezone }));

const INPUT = 'min-w-0 rounded border border-border bg-surface px-1 py-px font-mono text-[11px] text-text';

/**
 * The schedule: each cron with GitHub's words for it (or the converter's problem with it) and its timezone, both
 * edited in place and written on Enter or when the focus leaves; × removes a cron, + adds one. Removing the only cron
 * of the only event removes the event, so it asks first, as removing the event does.
 */
export function Schedule({ crons, only }: { crons: readonly CronRow[]; only: boolean }) {
  const { file, locked, chain, behind } = useTriggers();
  const { refused, run } = useGesture();
  const [asking, setAsking] = useState<number>();
  const set = (next: Cron[], words: string, focus?: string): boolean =>
    run({ op: 'setSchedule', file, crons: next }, words, focus);
  const remove = (i: number): void => {
    setAsking(undefined);
    set(plain(crons.filter((_, k) => k !== i)), `removed the cron ${crons[i]!.cron}`, at.event('schedule'));
  };
  return (
    <>
      <Row name="crons" end={<CheckMark check={scheduleCheck(chain('schedule'))} behind={behind} />}>
        <ul aria-label="schedule" className="flex flex-col gap-1">
          {crons.map((row, i) => (
            <CronItem
              key={`${i}:${row.cron}`}
              row={row}
              locked={locked}
              onSet={(next) =>
                set(
                  plain(crons).map((c, k) => (k === i ? next : c)),
                  `set the cron to ${next.cron}`,
                )
              }
              onRemove={() => (only && crons.length === 1 ? setAsking(i) : remove(i))}
            />
          ))}
          {!locked && (
            <li>
              <ChipList
                label="the schedule"
                noun="cron"
                values={[]}
                locked={false}
                onRemove={() => undefined}
                onAdd={(cron) => set([...plain(crons), { cron }], `added the cron ${cron}`)}
              />
            </li>
          )}
        </ul>
      </Row>
      {asking !== undefined && (
        <div role="group" aria-label="Remove the schedule?" className="pl-5 text-xs">
          <p>The schedule is the workflow’s only trigger: without it, nothing runs the workflow.</p>
          <div className="mt-1 flex gap-1.5">
            <button
              type="button"
              className="rounded border border-danger px-2 py-0.5"
              onClick={() => remove(asking)}
            >
              Remove the schedule
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-0.5"
              onClick={() => setAsking(undefined)}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
      <RefusalNote seq={refused} />
    </>
  );
}

function CronItem({
  row,
  locked,
  onSet,
  onRemove,
}: {
  row: CronRow;
  locked: boolean;
  onSet: (next: Cron) => void;
  onRemove: () => void;
}) {
  const { hints, outlined } = useTriggers();
  const hint = cronHint(hints, outlined, row);
  const commit = (cron: string, timezone: string): void => {
    const next: Cron =
      timezone.trim() === '' ? { cron: cron.trim() } : { cron: cron.trim(), timezone: timezone.trim() };
    if (next.cron !== '' && (next.cron !== row.cron || next.timezone !== row.timezone)) onSet(next);
  };
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <Committed
          className={`${INPUT} w-28`}
          label={`Cron ${row.cron}`}
          value={row.cron}
          locked={locked}
          onCommit={(cron) => commit(cron, row.timezone ?? '')}
        />
        <Committed
          className={`${INPUT} w-24`}
          label={`Timezone of ${row.cron}`}
          placeholder="UTC"
          value={row.timezone ?? ''}
          locked={locked}
          onCommit={(timezone) => commit(row.cron, timezone)}
        />
        {!locked && (
          <button
            type="button"
            className={SMALL_BUTTON}
            aria-label={`Remove the cron ${row.cron}`}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
      {hint && 'text' in hint && <p className="text-muted text-xs">{hint.text}</p>}
      {hint && 'problem' in hint && <p className="text-danger text-xs">{hint.problem}</p>}
    </li>
  );
}

/**
 * A text field written on Enter or when the focus leaves it, not per key: each write is an undo entry and a load.
 * Escape puts back what the file says.
 */
export function Committed({
  value,
  label,
  locked,
  onCommit,
  className,
  placeholder,
}: {
  value: string;
  label: string;
  locked: boolean;
  onCommit: (value: string) => void;
  className: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState<string>();
  const commit = (): void => {
    if (draft === undefined) return;
    setDraft(undefined);
    if (draft !== value) onCommit(draft);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape' && draft !== undefined) {
      e.stopPropagation();
      setDraft(undefined);
    }
  };
  return (
    <input
      className={className}
      aria-label={label}
      value={draft ?? value}
      placeholder={placeholder}
      readOnly={locked}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={keys}
      onBlur={commit}
    />
  );
}
