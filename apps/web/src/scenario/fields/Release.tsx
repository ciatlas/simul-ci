import { fieldAria } from '../aria';
import { refPatch, releaseTag } from '../form';
import { Field, type GroupProps, monoControl, Required, useFieldIds } from './kit';

/**
 * A release runs on its tag: without one `github.ref` is unknown. The field reads a tag given as `ref` too, and
 * writes it as `tag` alone.
 */
export function ReleaseFields({ f }: GroupProps) {
  const ids = useFieldIds();
  const hint = f.model.hints.release?.text;
  const issue = f.issue('tag');
  return (
    <Field ids={ids} label="Tag" tag={<Required />} hint={hint} issue={issue}>
      <input
        className={monoControl}
        value={releaseTag(f.scenario)}
        onChange={(e) => f.patch(refPatch('tag', e.target.value))}
        placeholder="v1.2.3"
        aria-required
        spellCheck={false}
        {...fieldAria(ids, { hint, issue })}
      />
    </Field>
  );
}
