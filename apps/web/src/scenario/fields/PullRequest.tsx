import { fieldAria } from '../aria';
import { actorWith, mergedPatch, mergedValue } from '../form';
import { useKept } from '../keep';
import {
  Assumed,
  Chips,
  control,
  Field,
  Flag,
  type GroupProps,
  marked,
  monoControl,
  TextField,
  useFieldIds,
} from './kit';

/**
 * A pull request (or a merge group, or a review): its base, chipped from the `branches` the engine matches against
 * the base; its head; its number; whether a closed one was merged; and whether the head is in a fork, which is the
 * actor's `fork` with the rest of the actor kept.
 */
export function PullRequestFields({ f }: GroupProps) {
  const { scenario } = f;
  const merged = useKept(
    `${scenario.event}.${scenario.action ?? ''}`,
    scenario.action === 'closed' || scenario.merged !== undefined,
    f.from === 'author',
  );
  return (
    <>
      <BaseField f={f} />
      <TextField
        f={f}
        field="head"
        label="Head branch"
        value={scenario.head ?? ''}
        onChange={(head) => f.patch({ head: head || undefined })}
        placeholder="feat/x"
      />
      <NumberField f={f} />
      {merged && <MergedField f={f} />}
      <Flag
        f={f}
        field="fork"
        label="From a fork"
        checked={scenario.actor?.fork === true}
        onChange={(on) => f.patch({ actor: actorWith(scenario.actor, 'fork', on) })}
      />
    </>
  );
}

function BaseField({ f }: GroupProps) {
  const ids = useFieldIds();
  const hint = f.model.hints.base;
  const issue = f.issue('base');
  const assumed = f.assumed('base');
  const base = f.scenario.base ?? '';
  return (
    <Field ids={ids} label="Base branch" hint={hint?.text} issue={issue}>
      <Assumed id={ids.assumed} on={assumed}>
        <input
          className={monoControl + marked(assumed)}
          value={base}
          onChange={(e) => f.patch({ base: e.target.value || undefined })}
          placeholder={f.scenario.defaultBranch ?? 'main'}
          spellCheck={false}
          {...fieldAria(ids, { hint: hint?.text, issue, assumed })}
        />
      </Assumed>
      <Chips
        chips={hint?.chips ?? []}
        label="Base branches from the filters"
        current={base}
        onPick={(value) => f.patch({ base: value })}
      />
    </Field>
  );
}

function NumberField({ f }: GroupProps) {
  const ids = useFieldIds();
  const issue = f.issue('number');
  return (
    <Field ids={ids} label="Number" issue={issue}>
      <input
        type="number"
        min={1}
        className={control}
        value={f.scenario.number ?? ''}
        onChange={(e) => f.patch({ number: e.target.value === '' ? undefined : Number(e.target.value) })}
        placeholder="1"
        {...fieldAria(ids, { issue })}
      />
    </Field>
  );
}

/**
 * Merged, not merged, or unknown: the engine reads a closed pull request with no `merged` as unknown (and offers a
 * pin), so the three are three choices, not a switch.
 */
function MergedField({ f }: GroupProps) {
  const ids = useFieldIds();
  const issue = f.issue('merged');
  return (
    <Field ids={ids} label="Merged" issue={issue}>
      <select
        className={control}
        value={mergedValue(f.scenario.merged)}
        onChange={(e) => f.patch({ merged: mergedPatch(e.target.value) })}
        {...fieldAria(ids, { issue })}
      >
        <option value="">unknown</option>
        <option value="true">merged</option>
        <option value="false">not merged</option>
      </select>
    </Field>
  );
}
