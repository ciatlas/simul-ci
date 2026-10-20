import type { DispatchInput } from '@simulci/document';
import { useId } from 'react';
import { asText } from '../property/model';
import { RefusalNote } from '../Refusal';
import { ChipList, Row, SMALL_BUTTON } from './Chips';
import { at, useGesture, useTriggers } from './context';
import { defaultOf, type InputRow } from './model';
import { Committed } from './Schedule';

const TYPES = ['string', 'boolean', 'choice', 'number', 'environment'] as const;
const CONTROL = 'rounded border border-border bg-surface px-1 py-px text-[11px] text-text';

/**
 * A manual run's inputs (synthesis § 4.6): each one's type, whether it is required, its default and, for a choice,
 * its options. The name is read-only once the input exists: renaming one changes what callers pass (M3c). + input
 * adds a string input by name; × removes one, and `inputs:` with the last.
 */
export function DispatchInputs({ inputs }: { inputs: readonly InputRow[] }) {
  const { file, locked } = useTriggers();
  const { refused, run } = useGesture();
  return (
    <>
      <Row name="inputs">
        <ul aria-label="workflow_dispatch's inputs" className="flex flex-col gap-1.5">
          {inputs.map((row) => (
            <InputItem key={row.name} row={row} />
          ))}
          {!locked && (
            <li>
              <ChipList
                label="workflow_dispatch's inputs"
                noun="input"
                values={[]}
                locked={false}
                onRemove={() => undefined}
                onAdd={(name) =>
                  run(
                    { op: 'setDispatchInput', file, name, input: { type: 'string' } },
                    `added the input ${name}`,
                  )
                }
              />
            </li>
          )}
        </ul>
      </Row>
      <RefusalNote seq={refused} />
    </>
  );
}

function InputItem({ row }: { row: InputRow }) {
  const { file, locked } = useTriggers();
  const { refused, run } = useGesture();
  const id = useId();
  const { input, name } = row;
  const set = (next: DispatchInput, words: string): boolean =>
    run({ op: 'setDispatchInput', file, name, input: next }, words);
  const patch = <K extends keyof DispatchInput>(key: K, value: DispatchInput[K] | undefined): boolean => {
    const next = { ...input };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return set(next, `set ${name}'s ${key}`);
  };
  return (
    <li className="flex flex-col gap-1" aria-labelledby={id}>
      <div className="flex items-baseline gap-2">
        <span id={id} className="font-mono text-xs">
          {name}
        </span>
        {!locked && (
          <button
            type="button"
            className={`${SMALL_BUTTON} ml-auto`}
            aria-label={`Remove the input ${name}`}
            onClick={() =>
              run(
                { op: 'setDispatchInput', file, name, input: null },
                `removed the input ${name}`,
                at.event('workflow_dispatch'),
              )
            }
          >
            ×
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-2">
        <select
          className={CONTROL}
          aria-label={`Type of ${name}`}
          value={input.type ?? ''}
          disabled={locked}
          onChange={(e) => patch('type', (e.target.value || undefined) as DispatchInput['type'])}
        >
          <option value="">(string)</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={input.required === true}
            disabled={locked}
            onChange={(e) => patch('required', e.target.checked || undefined)}
          />
          required
        </label>
        <Committed
          className={`${CONTROL} w-24 font-mono`}
          label={`Default of ${name}`}
          placeholder="default"
          value={input.default === undefined || input.default === null ? '' : asText(input.default)}
          locked={locked}
          onCommit={(typed) => patch('default', defaultOf(input.type, typed))}
        />
      </div>
      {input.type === 'choice' && (
        <div className="pl-2">
          <ChipList
            label={`${name}'s options`}
            noun="option"
            values={input.options ?? []}
            locked={locked}
            onRemove={(i) => {
              const rest = (input.options ?? []).filter((_, k) => k !== i);
              patch('options', rest.length ? rest : undefined);
            }}
            onAdd={(option) => patch('options', [...(input.options ?? []), option])}
          />
        </div>
      )}
      <RefusalNote seq={refused} />
    </li>
  );
}
