import { fieldAria } from '../aria';
import { activityNotes, strayAction } from '../form';
import { Assumed, control, Field, type GroupProps, marked, useFieldIds } from './kit';

/**
 * The activity type (`action`): the types a listening workflow runs on first (its `types:`, or the defaults where it
 * names none), the rest of the event's types after them as a deliberate what-if, and an action that is none of them
 * shown as itself. Required when a listener narrows `types:`, since the engine cannot decide without one; otherwise
 * empty means any default type.
 */
export function ActivityTypeField({ f }: GroupProps) {
  const ids = useFieldIds();
  const types = f.model.activity;
  if (!types) return null;
  const { action, event } = f.scenario;
  const stray = strayAction(types, action);
  const notes = activityNotes(types, event);
  const empty = types.required ? (action === undefined ? 'choose…' : undefined) : '(any default type)';
  const hint = f.model.hints.action?.text;
  const issue = f.issue('action');
  const assumed = f.assumed('action');
  return (
    <Field ids={ids} label="Activity type" hint={hint} issue={issue}>
      <Assumed id={ids.assumed} on={assumed}>
        <select
          className={control + marked(assumed)}
          value={action ?? ''}
          onChange={(e) => f.patch({ action: e.target.value || undefined })}
          aria-required={types.required || undefined}
          {...fieldAria(ids, { hint, issue, assumed })}
        >
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
        </select>
      </Assumed>
    </Field>
  );
}
