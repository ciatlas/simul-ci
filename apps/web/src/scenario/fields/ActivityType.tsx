import { fieldAria } from '../aria';
import { type ActivityTypes, activityNotes, strayAction } from '../form';
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
 * The activity type (`action`): the types a listening workflow runs on first (its `types:`, or the defaults where it
 * names none), the rest of the event's types after them as a deliberate what-if, and an action that is none of them
 * shown as itself. Custom types (`repository_dispatch`) are any name, so other… opens a box for one no listener
 * names, the what-if there. Required when a listener narrows `types:`, since the engine cannot decide without one;
 * otherwise empty means any default type.
 */
export function ActivityTypeField({ f }: GroupProps) {
  const ids = useFieldIds();
  const [other, setOther] = useOther(f);
  const types = f.model.activity;
  if (!types) return null;
  const { action } = f.scenario;
  const stray = strayAction(types, action);
  const free = types.custom === true && (other || stray !== undefined);
  const hint = f.model.hints.action?.text;
  const issue = f.issue('action');
  const assumed = f.assumed('action');
  const write = (value: string): void => f.patch({ action: value || undefined });
  return (
    <Field ids={ids} label="Activity type" hint={hint} issue={issue}>
      <Assumed id={ids.assumed} on={assumed}>
        <select
          className={control + marked(assumed)}
          value={free ? OTHER : (action ?? '')}
          onChange={(e) => {
            setOther(e.target.value === OTHER);
            if (e.target.value !== OTHER) write(e.target.value);
          }}
          aria-required={types.required || undefined}
          {...fieldAria(ids, { hint, issue, assumed })}
        >
          <TypeOptions
            types={types}
            event={f.scenario.event}
            action={action}
            stray={free ? undefined : stray}
          />
        </select>
      </Assumed>
      {free && (
        <input
          className={monoControl}
          value={action ?? ''}
          onChange={(e) => write(e.target.value)}
          placeholder="any name"
          aria-label="Activity type name"
          aria-invalid={issue ? true : undefined}
          aria-errormessage={issue ? ids.error : undefined}
          spellCheck={false}
        />
      )}
    </Field>
  );
}

function TypeOptions({
  types,
  event,
  action,
  stray,
}: {
  types: ActivityTypes;
  event: string;
  action: string | undefined;
  stray: string | undefined;
}) {
  const notes = activityNotes(types, event);
  const empty = types.required ? (action === undefined ? 'choose…' : undefined) : '(any default type)';
  return (
    <>
      {empty !== undefined && <option value="">{empty}</option>}
      {stray !== undefined && (
        <option value={stray}>
          {stray} · {notes.stray}
        </option>
      )}
      {types.allowed.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
      {types.rest.map((t) => (
        <option key={t} value={t}>
          {t} · {notes.rest}
        </option>
      ))}
      {types.custom && <option value={OTHER}>other…</option>}
    </>
  );
}
