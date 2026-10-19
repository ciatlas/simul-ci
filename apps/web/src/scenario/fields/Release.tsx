import { fieldAria } from '../aria';
import { refPatch, releaseTag } from '../form';
import { Assumed, Field, type GroupProps, marked, monoControl, Required, useFieldIds } from './kit';

/**
 * A release runs on its tag: without one `github.ref` is unknown. The field reads a tag given as `ref` too, and
 * writes it as `tag` alone.
 */
export function ReleaseFields({ f }: GroupProps) {
  const ids = useFieldIds();
  const hint = f.model.hints.release?.text;
  const issue = f.issue('tag');
  const assumed = f.assumed('tag');
  return (
    <Field ids={ids} label="Tag" tag={<Required />} hint={hint} issue={issue}>
      <Assumed id={ids.assumed} on={assumed}>
        <input
          className={monoControl + marked(assumed)}
          value={releaseTag(f.scenario)}
          onChange={(e) => f.patch(refPatch('tag', e.target.value))}
          placeholder="v1.2.3"
          aria-required
          spellCheck={false}
          data-field="tag"
          {...fieldAria(ids, { hint, issue, assumed })}
        />
      </Assumed>
    </Field>
  );
}
