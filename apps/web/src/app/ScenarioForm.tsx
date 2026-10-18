import type { ScenarioInput } from '@simulci/engine';
import { type ReactNode, useMemo } from 'react';
import { eventChoices } from '../scenario/defaults';
import {
  activityTypes,
  changedText,
  crons,
  dispatchInputs,
  jsonText,
  parseChanged,
  PATH_FILTER_EVENTS,
  pathPatterns,
  PR_EVENTS,
  withEvent,
  workflowNames,
} from '../scenario/form';
import type { Outline, OutlineInput } from '../worker/protocol';
import { useSession } from './providers';

/**
 * The scenario, field by field, from the outline's hints. Every control writes one `ScenarioInputSchema` key; the
 * worker validates and the banner or the field shows a refusal. Chips, hints and the advanced rows are the next PR.
 */

const field = 'rounded border border-border bg-surface px-2 py-1 text-sm';
const label = 'flex flex-col gap-1 text-xs text-muted';

interface Fields {
  outline: Outline;
  scenario: ScenarioInput;
  /** Adds the assumed class to a key the page chose. */
  mark: (key: string) => string;
  issueFor: (key: string) => string | undefined;
  patch: (key: keyof ScenarioInput, value: unknown) => void;
}

export function ScenarioForm() {
  const outline = useSession((s) => s.project.outline);
  const scenario = useSession((s) => s.scenario);
  const assumed = useSession((s) => s.assumed);
  const focus = useSession((s) => s.focus);
  const issues = useSession((s) => (s.error?.kind === 'scenario' ? s.error.issues : undefined));
  const patchScenario = useSession((s) => s.patchScenario);
  const setScenario = useSession((s) => s.setScenario);
  if (!outline) return null;

  const f: Fields = {
    outline,
    scenario,
    mark: (key) => (assumed.includes(key) ? ' assumed' : ''),
    issueFor: (key) => issues?.find((i) => i.path[0] === key)?.message,
    patch: (key, value) => patchScenario({ [key]: value === '' ? undefined : value }),
  };
  const event = scenario.event;
  const Fields = FIELDS_BY_EVENT[event] ?? (PR_EVENTS.has(event) ? PullRequestFields : undefined);
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Scenario">
      <EventField f={f} focus={focus} onChange={(e) => setScenario(withEvent(scenario, e))} />
      <ActivityTypeField f={f} />
      {Fields && <Fields f={f} patchScenario={patchScenario} />}
      {PATH_FILTER_EVENTS.has(event) && scenario.tag === undefined && <ChangedFilesField f={f} />}
    </form>
  );
}

type FieldsProps = { f: Fields; patchScenario: (patch: Partial<ScenarioInput>) => void };

/** The fields an event owns; pull-request events share theirs. */
const FIELDS_BY_EVENT: Record<string, (props: FieldsProps) => ReactNode> = {
  push: PushRefField,
  release: ({ f }) => <TextField f={f} k="tag" label="Tag" placeholder="v1.2.3" />,
  schedule: CronField,
  workflow_run: WorkflowRunFields,
  workflow_dispatch: DispatchFields,
};

function EventField({
  f,
  focus,
  onChange,
}: {
  f: Fields;
  focus: string | undefined;
  onChange: (e: string) => void;
}) {
  const choices = useMemo(() => eventChoices(f.outline, focus), [f.outline, focus]);
  const known = choices.some((c) => c.event === f.scenario.event);
  return (
    <label className={label}>
      Event
      <select
        className={field + f.mark('event')}
        value={known ? f.scenario.event : '…'}
        onChange={(e) => {
          if (e.target.value !== '…') onChange(e.target.value);
        }}
        aria-invalid={f.issueFor('event') ? true : undefined}
      >
        {choices.map((c) => (
          <option key={c.event} value={c.event}>
            {c.event}
            {c.listeners
              ? ` · ${c.listeners === 1 ? '1 workflow' : `${c.listeners} workflows`}`
              : ' · none listens'}
          </option>
        ))}
        <option value="…">other…</option>
      </select>
      {!known && (
        <input
          className={field}
          value={f.scenario.event}
          onChange={(e) => onChange(e.target.value)}
          placeholder="issues, release, …"
          aria-label="Event name"
        />
      )}
      <Issue text={f.issueFor('event')} />
    </label>
  );
}

function ActivityTypeField({ f }: { f: Fields }) {
  const types = useMemo(() => activityTypes(f.outline, f.scenario.event), [f.outline, f.scenario.event]);
  if (!types) return null;
  const empty = types.required
    ? f.scenario.action === undefined
      ? 'choose…'
      : undefined
    : '(any default type)';
  return (
    <label className={label}>
      Activity type
      <select
        className={field + f.mark('action')}
        value={f.scenario.action ?? ''}
        onChange={(e) => f.patch('action', e.target.value)}
        aria-invalid={f.issueFor('action') ? true : undefined}
      >
        {empty !== undefined && <option value="">{empty}</option>}
        {types.allowed.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        {types.rest.map((t) => (
          <option key={t} value={t}>
            {t} · not in types:
          </option>
        ))}
      </select>
      <Issue text={f.issueFor('action')} />
    </label>
  );
}

function PushRefField({
  f,
  patchScenario,
}: {
  f: Fields;
  patchScenario: (patch: Partial<ScenarioInput>) => void;
}) {
  const kind = f.scenario.tag !== undefined ? 'tag' : 'branch';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-3 text-muted text-xs">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="ref-kind"
            checked={kind === 'branch'}
            onChange={() => patchScenario({ tag: undefined, branch: f.scenario.defaultBranch ?? 'main' })}
          />
          Branch
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="ref-kind"
            checked={kind === 'tag'}
            onChange={() => patchScenario({ branch: undefined, ref: undefined, tag: 'v1.0.0' })}
          />
          Tag
        </label>
      </div>
      <input
        className={field + f.mark(kind)}
        value={f.scenario[kind] ?? ''}
        onChange={(e) => f.patch(kind, e.target.value)}
        placeholder={kind === 'tag' ? 'v1.2.3' : 'main'}
        aria-label={kind === 'tag' ? 'Tag' : 'Branch'}
        aria-invalid={f.issueFor(kind) ? true : undefined}
        spellCheck={false}
      />
      <Issue text={f.issueFor(kind)} />
    </div>
  );
}

function PullRequestFields({ f }: { f: Fields }) {
  return (
    <>
      <TextField f={f} k="base" label="Base branch" placeholder="main" />
      <TextField f={f} k="head" label="Head branch" placeholder="feat/x" />
      <label className={label}>
        Number
        <input
          type="number"
          min={1}
          className={field}
          value={f.scenario.number ?? ''}
          onChange={(e) => f.patch('number', e.target.value === '' ? '' : Number(e.target.value))}
        />
        <Issue text={f.issueFor('number')} />
      </label>
    </>
  );
}

function CronField({ f }: { f: Fields }) {
  return (
    <SelectField
      f={f}
      k="cron"
      label="Cron"
      options={crons(f.outline)}
      value={f.scenario.cron ?? ''}
      onChange={(v) => f.patch('cron', v)}
    />
  );
}

function WorkflowRunFields({ f }: { f: Fields }) {
  const run = f.scenario.workflow_run;
  return (
    <>
      <SelectField
        f={f}
        k="workflow_run"
        label="Triggering workflow"
        options={workflowNames(f.outline)}
        value={run?.name ?? ''}
        onChange={(v) => f.patch('workflow_run', v ? { ...run, name: v } : '')}
      />
      <label className={label}>
        Its conclusion
        <select
          className={field}
          value={run?.conclusion ?? 'success'}
          onChange={(e) => run && f.patch('workflow_run', { ...run, conclusion: e.target.value })}
        >
          {['success', 'failure', 'cancelled', 'skipped'].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function ChangedFilesField({ f }: { f: Fields }) {
  const patterns = pathPatterns(f.outline, f.scenario.event);
  return (
    <label className={label}>
      Changed files <span className="text-muted">(one path per line; empty = unknown)</span>
      <textarea
        className={`${field} min-h-24 font-mono`}
        value={changedText(f.scenario.changed)}
        onChange={(e) => f.patch('changed', parseChanged(e.target.value) ?? '')}
        placeholder={'src/index.ts\ndocs/readme.md (added)'}
        spellCheck={false}
        aria-invalid={f.issueFor('changed') ? true : undefined}
      />
      <Issue text={f.issueFor('changed')} />
      {patterns.length > 0 && (
        <span className="text-muted">
          filters here: <span className="font-mono">{patterns.join(', ')}</span>
        </span>
      )}
    </label>
  );
}

function DispatchFields({ f }: { f: Fields }) {
  const inputs = useMemo(() => dispatchInputs(f.outline), [f.outline]);
  if (inputs.length === 0) return null;
  const set = (name: string, v: string | boolean | number | undefined): void => {
    const next = { ...f.scenario.inputs };
    if (v === undefined) delete next[name];
    else next[name] = v;
    f.patch('inputs', Object.keys(next).length ? next : '');
  };
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-border p-2">
      <legend className="px-1 text-muted text-xs">Inputs</legend>
      {inputs.map((input) => (
        <DispatchInput
          key={input.name}
          input={input}
          value={f.scenario.inputs?.[input.name]}
          onChange={(v) => set(input.name, v)}
        />
      ))}
      <Issue text={f.issueFor('inputs')} />
    </fieldset>
  );
}

type InputValue = string | boolean | number | undefined;

function DispatchInput({
  input,
  value,
  onChange,
}: {
  input: OutlineInput;
  value: InputValue;
  onChange: (v: InputValue) => void;
}) {
  const title = `${input.name}${input.required && input.default === undefined ? ' (required)' : ''}`;
  if (input.type === 'boolean')
    return <BooleanInput title={title} input={input} value={value} onChange={onChange} />;
  if (input.type === 'choice')
    return <ChoiceInput title={title} input={input} value={value} onChange={onChange} />;
  const number = input.type === 'number';
  return (
    <label className={label}>
      {title}
      <input
        type={number ? 'number' : 'text'}
        className={field}
        value={value === undefined ? '' : String(value)}
        placeholder={input.default === undefined ? input.description : jsonText(input.default)}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : number ? Number(e.target.value) : e.target.value)
        }
      />
    </label>
  );
}

interface InputProps {
  title: string;
  input: OutlineInput;
  value: InputValue;
  onChange: (v: InputValue) => void;
}

/** A switch; the default is not sent, the engine applies it. */
function BooleanInput({ title, input, value, onChange }: InputProps) {
  const fallback = input.default === true;
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={value === undefined ? fallback : value === true}
        onChange={(e) => onChange(e.target.checked === fallback ? undefined : e.target.checked)}
      />
      {title}
      {input.description && <span className="text-muted">· {input.description}</span>}
    </label>
  );
}

function ChoiceInput({ title, input, value, onChange }: InputProps) {
  return (
    <label className={label}>
      {title}
      <select
        className={field}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">
          {input.default !== undefined ? `default: ${jsonText(input.default)}` : 'choose…'}
        </option>
        {(input.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextField({
  f,
  k,
  label: text,
  placeholder,
}: {
  f: Fields;
  k: 'base' | 'head' | 'tag';
  label: string;
  placeholder: string;
}) {
  return (
    <label className={label}>
      {text}
      <input
        className={field + f.mark(k)}
        value={f.scenario[k] ?? ''}
        onChange={(e) => f.patch(k, e.target.value)}
        placeholder={placeholder}
        aria-invalid={f.issueFor(k) ? true : undefined}
        spellCheck={false}
      />
      <Issue text={f.issueFor(k)} />
    </label>
  );
}

function SelectField({
  f,
  k,
  label: text,
  options,
  value,
  onChange,
}: {
  f: Fields;
  k: string;
  label: ReactNode;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className={label}>
      {text}
      <select className={field + f.mark(k)} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">choose…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <Issue text={f.issueFor(k)} />
    </label>
  );
}

function Issue({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <span role="alert" className="text-danger">
      {text}
    </span>
  );
}
