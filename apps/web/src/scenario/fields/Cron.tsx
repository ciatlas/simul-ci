import { fieldAria } from '../aria';
import { stray } from '../form';
import { Assumed, Field, type GroupProps, marked, monoControl, useFieldIds } from './kit';

/** The cron that fired, from every workflow's `schedule:`: the gate needs the exact string, so it is a select. */
export function CronField({ f }: GroupProps) {
  const ids = useFieldIds();
  const { crons } = f.model;
  const cron = f.scenario.cron;
  const other = stray(crons, cron);
  const hint = f.model.hints.cron?.text;
  const issue = f.issue('cron');
  const assumed = f.assumed('cron');
  return (
    <Field ids={ids} label="Cron" hint={hint} issue={issue}>
      <Assumed id={ids.assumed} on={assumed}>
        <select
          className={monoControl + marked(assumed)}
          value={cron ?? ''}
          data-field="cron"
          onChange={(e) => f.patch({ cron: e.target.value || undefined })}
          {...fieldAria(ids, { hint, issue, assumed })}
        >
          <option value="">choose…</option>
          {other !== undefined && <option value={other}>{other} · no workflow schedules it</option>}
          {crons.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Assumed>
    </Field>
  );
}
