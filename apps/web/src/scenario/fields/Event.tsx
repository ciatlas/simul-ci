import { useState } from 'react';
import { fieldAria } from '../aria';
import type { EventOption } from '../derive';
import { withEvent } from '../form';
import { Assumed, control, Field, type GroupProps, marked, monoControl, useFieldIds } from './kit';

/**
 * The event: the focused workflow's events, every other event a workflow listens to with its count, a dispatch,
 * and other… for any name at all (seeing that `issues` starts nothing is a fair question). A new event keeps the
 * fields that still apply and drops what the old one owned.
 */
export function EventField({ f }: GroupProps) {
  const ids = useFieldIds();
  const { events } = f.model;
  // Picking other… keeps the free-text field open while its text passes through the listed names; a scenario
  // set from outside (the URL, the defaults) closes it.
  const [other, setOther] = useState(false);
  const [seen, setSeen] = useState(f.scenario);
  if (seen !== f.scenario) {
    setSeen(f.scenario);
    if (f.from !== 'author') setOther(false);
  }
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
          value={free ? '…' : f.scenario.event}
          onChange={(e) => {
            setOther(e.target.value === '…');
            if (e.target.value !== '…') change(e.target.value);
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
          <option value="…">other…</option>
        </select>
      </Assumed>
      {free && (
        <input
          className={monoControl}
          value={f.scenario.event}
          onChange={(e) => change(e.target.value)}
          placeholder="issues, release, …"
          aria-label="Event name"
          aria-invalid={issue ? true : undefined}
          aria-errormessage={issue ? ids.error : undefined}
          spellCheck={false}
        />
      )}
    </Field>
  );
}

function Options({ options }: { options: EventOption[] }) {
  return options.map((o) => (
    <option key={o.event} value={o.event}>
      {o.label}
    </option>
  ));
}
