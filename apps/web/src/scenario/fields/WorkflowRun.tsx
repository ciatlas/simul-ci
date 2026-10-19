import { useState } from 'react';
import { fieldAria } from '../aria';
import { CONCLUSIONS, type Conclusion, runConclusion, runNamed, stray, withRunBranch } from '../form';
import { Assumed, Chips, control, Field, type GroupProps, marked, monoControl, useFieldIds } from './kit';

/** What the author picks before the triggering workflow is named; the schema needs the name first. */
interface Pending {
  conclusion?: Conclusion;
  branch?: string;
}

/**
 * The run that triggers a `workflow_run`: the workflow (from the `workflows:` patterns and every workflow's
 * `name:`), the branch it ran on (what `branches` reads), and its conclusion. A branch or a conclusion chosen
 * before the workflow waits here and joins the run once it is named.
 */
export function WorkflowRunFields({ f }: GroupProps) {
  const run = f.scenario.workflow_run;
  const [pending, setPending] = useState<Pending>({});
  const name = (value: string): void => {
    if (!value) {
      setPending(run ? { conclusion: run.conclusion, branch: run.branch } : pending);
      f.patch({ workflow_run: undefined });
      return;
    }
    const named = runNamed(run, value, pending.conclusion);
    setPending({});
    f.patch({ workflow_run: run || !pending.branch ? named : withRunBranch(named, pending.branch) });
  };
  return (
    <>
      <NameField f={f} onChange={name} />
      <BranchField
        f={f}
        value={run ? (run.branch ?? '') : (pending.branch ?? '')}
        onChange={(branch) =>
          run ? f.patch({ workflow_run: withRunBranch(run, branch) }) : setPending({ ...pending, branch })
        }
      />
      <ConclusionField
        f={f}
        value={runConclusion(run, pending.conclusion)}
        onChange={(conclusion) =>
          run ? f.patch({ workflow_run: { ...run, conclusion } }) : setPending({ ...pending, conclusion })
        }
      />
    </>
  );
}

function NameField({ f, onChange }: GroupProps & { onChange: (name: string) => void }) {
  const ids = useFieldIds();
  const names = f.model.runNames;
  const value = f.scenario.workflow_run?.name ?? '';
  const other = stray(names, value);
  const hint = f.model.hints.workflow_run?.text;
  const issue = f.issue('workflow_run');
  const assumed = f.assumed('workflow_run');
  return (
    <Field ids={ids} label="Triggering workflow" hint={hint} issue={issue}>
      <Assumed id={ids.assumed} on={assumed}>
        <select
          className={control + marked(assumed)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...fieldAria(ids, { hint, issue, assumed })}
        >
          <option value="">choose…</option>
          {other !== undefined && <option value={other}>{other} · no workflow has this name</option>}
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Assumed>
    </Field>
  );
}

function BranchField({
  f,
  value,
  onChange,
}: GroupProps & { value: string; onChange: (branch: string) => void }) {
  const ids = useFieldIds();
  const hint = f.model.hints['workflow_run.branch'];
  const issue = f.issue('workflow_run.branch');
  return (
    <Field ids={ids} label="Its branch" hint={hint?.text} issue={issue}>
      <input
        className={monoControl}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.scenario.defaultBranch ?? 'main'}
        spellCheck={false}
        {...fieldAria(ids, { hint: hint?.text, issue })}
      />
      <Chips chips={hint?.chips ?? []} label="Branches from the filters" current={value} onPick={onChange} />
    </Field>
  );
}

function ConclusionField({
  f,
  value,
  onChange,
}: GroupProps & { value: Conclusion; onChange: (conclusion: Conclusion) => void }) {
  const ids = useFieldIds();
  const issue = f.issue('workflow_run.conclusion');
  return (
    <Field ids={ids} label="Its conclusion" issue={issue}>
      <select
        className={control}
        value={value}
        onChange={(e) => onChange(e.target.value as Conclusion)}
        {...fieldAria(ids, { issue })}
      >
        {CONCLUSIONS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </Field>
  );
}
