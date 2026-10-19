import { type KeyboardEvent, useState } from 'react';
import { fieldAria } from '../aria';
import type { EventOption } from '../derive';
import { withEvent } from '../form';
import {
  Assumed,
  control,
  Field,
  type GroupProps,
  marked,
  monoControl,
  OTHER,
  useFieldIds,
  useOther,
} from './kit';

/**
 * The event: the focused workflow's events, every other event a workflow listens to with its count, a dispatch,
 * and other… for any name at all (seeing that `issues` starts nothing is a fair question). A new event keeps the
 * fields that still apply and drops what the old one owned.
 */
export function EventField({ f }: GroupProps) {
  const ids = useFieldIds();
  const { events } = f.model;
  const [other, setOther] = useOther(f);
  const listed = [...events.focused, ...events.others].some((c) => c.event === f.scenario.event);
  const free = other || !listed;
  const change = (event: string): void => {
    const next = withEvent(f.scenario, event);
    if (next !== f.scenario) f.setScenario(next);
  };
  const hint = f.model.hints.event?.text;
  const issue = f.issue('event');
  const assumed = f.assumed('event');
  return (
    <Field ids={ids} label="Event" hint={hint} issue={issue}>
      <Assumed id={ids.assumed} on={assumed}>
        <select
          className={control + marked(assumed)}
          value={free ? OTHER : f.scenario.event}
          onChange={(e) => {
            setOther(e.target.value === OTHER);
            if (e.target.value !== OTHER) change(e.target.value);
          }}
          {...fieldAria(ids, { hint, issue, assumed })}
        >
          {events.focused.length > 0 && (
            <optgroup label={events.title ?? 'this workflow'}>
              <Options options={events.focused} />
            </optgroup>
          )}
          {events.others.length > 0 && (
            <optgroup label={events.focused.length > 0 ? 'other workflows' : 'workflows'}>
              <Options options={events.others} />
            </optgroup>
          )}
          <option value={OTHER}>other…</option>
        </select>
      </Assumed>
      {free && <EventName event={f.scenario.event} error={issue ? ids.error : undefined} onCommit={change} />}
    </Field>
  );
}

/**
 * The name of an event no option holds. The name is written when the author is done with it (Enter, or the focus
 * leaving), not on each keystroke: every new event is a new history entry, and a name half typed is no event.
 */
function EventName({
  event,
  error,
  onCommit,
}: {
  event: string;
  error: string | undefined;
  onCommit: (event: string) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const [shown, setShown] = useState(event);
  if (shown !== event) {
    setShown(event);
    setDraft(undefined);
  }
  const commit = (): void => {
    if (draft === undefined) return;
    setDraft(undefined);
    onCommit(draft);
  };
  return (
    <input
      className={monoControl}
      value={draft ?? event}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') commit();
      }}
      placeholder="issues, release, …"
      aria-label="Event name"
      aria-invalid={error ? true : undefined}
      aria-errormessage={error}
      spellCheck={false}
    />
  );
}

function Options({ options }: { options: EventOption[] }) {
  return options.map((o) => (
    <option key={o.event} value={o.event}>
      {o.label}
    </option>
  ));
}
