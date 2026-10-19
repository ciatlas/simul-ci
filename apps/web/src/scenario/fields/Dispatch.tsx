import type { ScenarioInput } from '@simulci/engine';
import { useId } from 'react';
import { fieldAria } from '../aria';
import type { DispatchGroup } from '../derive';
import { asBoolean, choiceValue, inputValue, jsonText, stray, withInput } from '../form';
import { control, Field, type FieldContext, type GroupProps, Required, Switch, useFieldIds } from './kit';

/**
 * The dispatch inputs, grouped by the workflow that declares them (with a heading when more than one does). Each
 * input takes the control its type asks for: a switch, a select of its options, a number, or text (an
 * environment's text suggests the scenario's environments). A default shows as the placeholder and is not sent:
 * the engine applies it, and the test case's `when` stays minimal.
 */
export function DispatchFields({ f }: GroupProps) {
  const groups = f.model.dispatch;
  // A refusal of the inputs as a whole, or of one no workflow declares (named in the message), describes the group.
  const issue = f.issue('inputs');
  const id = useId();
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3 rounded border border-border p-2"
      aria-describedby={issue ? id : undefined}
    >
      <legend className="px-1 text-muted text-xs">Inputs</legend>
      {groups.map((group) => (
        <InputGroup key={group.path} f={f} group={group} heading={groups.length > 1} />
      ))}
      {issue && (
        <p id={id} className="text-danger text-xs">
          {issue}
        </p>
      )}
    </fieldset>
  );
}

function InputGroup({ f, group, heading }: { f: FieldContext; group: DispatchGroup; heading: boolean }) {
  const body = group.inputs.map((input) => <DispatchInput key={input.name} f={f} input={input} />);
  if (!heading) return body;
  return (
    <section className="flex flex-col gap-2" aria-label={group.title}>
      <h3 className="font-medium text-text text-xs">{group.title}</h3>
      {body}
    </section>
  );
}

type Input = DispatchGroup['inputs'][number];
type Value = string | boolean | number | undefined;

function DispatchInput({ f, input }: { f: FieldContext; input: Input }) {
  const set = (value: Value): void => f.patch({ inputs: withInput(f.scenario.inputs, input.name, value) });
  const props: InputProps = {
    f,
    input,
    value: inputValue(f.scenario.inputs, input.name),
    onChange: set,
    issue: f.issue(`inputs.${input.name}`),
  };
  if (input.type === 'boolean') return <BooleanInput {...props} />;
  if (input.type === 'choice') return <ChoiceInput {...props} />;
  return <TextInput {...props} />;
}

interface InputProps {
  f: FieldContext;
  input: Input;
  value: Value;
  onChange: (value: Value) => void;
  issue: string | undefined;
}

const required = (input: Input): boolean => input.required && input.default === undefined;

/** A switch; the default is not sent, so turning it back to the default sends nothing. */
function BooleanInput({ input, value, onChange, issue }: InputProps) {
  const ids = useFieldIds();
  const fallback = asBoolean(input.default);
  const hint = input.description;
  return (
    <Field ids={ids} hint={hint} issue={issue}>
      <Switch
        label={
          <>
            <span className="font-mono">{input.name}</span>
            {required(input) && <> · required</>}
          </>
        }
        checked={value === undefined ? fallback : asBoolean(value)}
        onChange={(on) => onChange(on === fallback ? undefined : on)}
        aria={{ ...fieldAria(ids, { hint, issue }) }}
      />
    </Field>
  );
}

/** A select of the options; a value of another type shows as the text the engine reads it as (`true` as 'true'). */
function ChoiceInput({ input, value, onChange, issue }: InputProps) {
  const ids = useFieldIds();
  const options = input.options ?? [];
  const shown = choiceValue(value);
  const other = stray(options, shown);
  const hint = input.description;
  return (
    <Field ids={ids} label={input.name} tag={required(input) && <Required />} hint={hint} issue={issue}>
      <select
        className={control}
        value={shown}
        onChange={(e) => onChange(e.target.value || undefined)}
        aria-required={required(input) || undefined}
        {...fieldAria(ids, { hint, issue })}
      >
        <option value="">
          {input.default !== undefined ? `default: ${jsonText(input.default)}` : 'choose…'}
        </option>
        {other !== undefined && <option value={other}>{other} · not an option</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Text, a number, or an environment's name with the scenario's environments suggested. */
function TextInput({ f, input, value, onChange, issue }: InputProps) {
  const ids = useFieldIds();
  const number = input.type === 'number';
  const environments = input.type === 'environment' ? namesOf(f.scenario.environments) : [];
  const hint = input.description;
  return (
    <Field ids={ids} label={input.name} tag={required(input) && <Required />} hint={hint} issue={issue}>
      <input
        type={number ? 'number' : 'text'}
        className={`${control}${number ? '' : ' font-mono'}`}
        value={value === undefined ? '' : String(value)}
        placeholder={input.default === undefined ? undefined : jsonText(input.default)}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : number ? Number(e.target.value) : e.target.value)
        }
        list={environments.length ? `${ids.id}-environments` : undefined}
        aria-required={required(input) || undefined}
        spellCheck={false}
        {...fieldAria(ids, { hint, issue })}
      />
      {environments.length > 0 && (
        <datalist id={`${ids.id}-environments`}>
          {environments.map((e) => (
            <option key={e} value={e} />
          ))}
        </datalist>
      )}
    </Field>
  );
}

/** The scenario's environments; a list of the wrong shape (a URL's) suggests the names it does hold. */
const namesOf = (environments: ScenarioInput['environments']): string[] =>
  Array.isArray(environments) ? environments.filter((e): e is string => typeof e === 'string') : [];
