import { useState } from 'react';
import { fieldAria } from '../aria';
import { pushRef, type RefKind, refPatch } from '../form';
import { Assumed, Chips, Field, type GroupProps, marked, monoControl, useFieldIds } from './kit';

/**
 * The ref a push (or a dispatch) runs on: Branch or Tag, writing `branch` or `tag` and clearing the other two ref
 * keys, so the scenario names one. A push's chips are the literal names of its `branches`/`tags` filters and a
 * sample for each glob; the ignore lists show as what the ref must not be.
 */
export function RefField({ f }: GroupProps) {
  const ids = useFieldIds();
  const named = pushRef(f.scenario);
  // Branch or Tag is the author's choice while the field is empty; a ref the scenario names, or a scenario set
  // from outside (the URL, the defaults), decides it.
  const seed = named.kind ?? (f.from === 'author' ? undefined : 'branch');
  const [chosen, setChosen] = useState<RefKind>(seed ?? 'branch');
  if (seed !== undefined && seed !== chosen) setChosen(seed);
  const kind = seed ?? chosen;
  const choose = (next: RefKind, name: string): void => {
    setChosen(next);
    f.patch(refPatch(next, name));
  };
  const hint = f.model.hints[kind];
  const issue = f.issue('ref');
  const assumed = f.assumed(kind);
  const name = kind === 'tag' ? 'Tag' : 'Branch';
  return (
    <Field ids={ids} hint={hint?.text} issue={issue}>
      <fieldset className="flex gap-3 text-muted text-xs">
        <legend className="sr-only">Ref</legend>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`${ids.id}-kind`}
            checked={kind === 'branch'}
            onChange={() => choose('branch', f.scenario.defaultBranch ?? 'main')}
          />
          Branch
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`${ids.id}-kind`}
            checked={kind === 'tag'}
            onChange={() => choose('tag', 'v1.0.0')}
          />
          Tag
        </label>
      </fieldset>
      <Assumed id={ids.assumed} on={assumed}>
        <input
          className={monoControl + marked(assumed)}
          value={named.name}
          onChange={(e) => f.patch(refPatch(kind, e.target.value))}
          placeholder={kind === 'tag' ? 'v1.2.3' : (f.scenario.defaultBranch ?? 'main')}
          aria-label={name}
          spellCheck={false}
          {...fieldAria(ids, { hint: hint?.text, issue, assumed })}
        />
      </Assumed>
      <Chips
        chips={hint?.chips ?? []}
        label={kind === 'tag' ? 'Tags from the filters' : 'Branches from the filters'}
        current={named.name}
        onPick={(value) => f.patch(refPatch(kind, value))}
      />
    </Field>
  );
}
