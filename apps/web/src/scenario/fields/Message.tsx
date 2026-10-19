import { fieldAria } from '../aria';
import { skipsCi, withSkipCi } from '../form';
import { Field, type GroupProps, monoControl, Switch, useFieldIds } from './kit';

/**
 * The head commit's message, which a push or a pull request reads for skip markers. The switch adds `[skip ci]`
 * to the subject or takes every marker out; it is on whenever the engine would read a skip.
 */
export function MessageField({ f }: GroupProps) {
  const ids = useFieldIds();
  const { message } = f.scenario;
  const issue = f.issue('message');
  const hint = 'a skip marker such as [skip ci], or a skip-checks: true trailer, skips the run';
  return (
    <Field ids={ids} label="Commit message" hint={hint} issue={issue}>
      <textarea
        className={`${monoControl} min-h-14`}
        value={typeof message === 'string' ? message : ''}
        onChange={(e) => f.patch({ message: e.target.value || undefined })}
        placeholder="fix: the thing"
        spellCheck={false}
        {...fieldAria(ids, { hint, issue })}
      />
      <Switch
        label="[skip ci]"
        checked={skipsCi(message)}
        onChange={(on) => f.patch({ message: withSkipCi(message, on) })}
      />
    </Field>
  );
}
