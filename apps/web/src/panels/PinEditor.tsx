import type { AssumeEntry } from '@simulci/engine';
import {
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { type DraftAbout, entryProblems, entryYaml, type PinDraft } from './pin-draft';
import {
  type EditorForm,
  type EditorPair,
  entryOf,
  envAllowed,
  formOf,
  formProblems,
  outcomeOptions,
  type PairField,
  unitFacts,
  withoutPair,
  withPair,
  withPairEdit,
  withPreset,
  withValue,
} from './unknown-rows';

/**
 * The PinEditor (synthesis § 7): an assume entry for a step or a job, prefilled from the draft. The unit is read-only;
 * the outcome, the outputs, the env writes and a model's preset are the author's. What the schema refuses shows
 * before Apply does, the worker's refusal beside it; Escape and Cancel close it.
 */

interface Props {
  draft: PinDraft;
  onApply: (entry: AssumeEntry) => void;
  onCancel: () => void;
  /** The worker's refusal of the entry, its path in front (`issuesOf`). */
  issues?: string[];
}

type SetForm = Dispatch<SetStateAction<EditorForm>>;

const input =
  'w-full min-w-0 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-text text-xs hover:border-border-strong';
const small =
  'rounded border border-border px-1.5 py-0.5 text-muted text-xs hover:border-border-strong hover:text-text';

/** The editor, its fields from the draft's entry; Apply is held back while the entry has problems. */
export function PinEditor({ draft, onApply, onCancel, issues = [] }: Props) {
  const [form, setForm] = useState(() => formOf(draft.entry));
  const ids = useId();
  const root = useRef<HTMLFormElement>(null);
  const entry = entryOf(draft.entry, form);
  const problems = [...formProblems(form), ...entryProblems(entry)];
  const shown = [...problems, ...issues];

  // The field the unknown is about takes the focus when the editor opens.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-about]')?.focus();
  }, []);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (problems.length === 0) onApply(entry);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };

  return (
    <form
      ref={root}
      aria-labelledby={`${ids}-title`}
      aria-invalid={shown.length > 0}
      aria-errormessage={shown.length > 0 ? `${ids}-errors` : undefined}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 rounded border border-border-strong bg-bg p-2.5 text-xs"
    >
      <Unit id={`${ids}-title`} entry={draft.entry} />
      <OutcomeField draft={draft} form={form} setForm={setForm} name={`${ids}-outcome`} />
      <Pairs field="outputs" draft={draft} form={form} setForm={setForm} />
      {envAllowed(draft.entry) && <Pairs field="env" draft={draft} form={form} setForm={setForm} />}
      <Presets draft={draft} form={form} setForm={setForm} />
      <details>
        <summary className="cursor-default text-muted hover:text-text">Entry as YAML</summary>
        <pre className="mt-1 overflow-x-auto rounded bg-chrome p-2 font-mono text-[11px] text-text">
          {entryYaml(entry)}
        </pre>
      </details>
      {shown.length > 0 && (
        <ul id={`${ids}-errors`} className="flex flex-col gap-0.5 text-danger">
          {shown.map((message, i) => (
            <li key={`${i}:${message}`}>{message}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={problems.length > 0}
          className="rounded border border-accent bg-accent-soft px-2 py-0.5 text-text disabled:border-border disabled:bg-transparent disabled:text-muted"
        >
          Apply
        </button>
        <button type="button" onClick={onCancel} className={small}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What the entry names, read-only: `step build.detect`, a workflow, matrix values. */
function Unit({ id, entry }: { id: string; entry: AssumeEntry }) {
  return (
    <div className="flex flex-col gap-1">
      <p id={id} className="font-medium text-text">
        Pin {entry.step ?? entry.job ?? entry.uses}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        {unitFacts(entry).map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted">{key}</dt>
            <dd className="break-all font-mono text-text">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface FieldProps {
  draft: PinDraft;
  form: EditorForm;
  setForm: SetForm;
}

/** The outcome as native radios: the unit's outcomes and `none`, for an entry that states only outputs. */
function OutcomeField({ draft, form, setForm, name }: FieldProps & { name: string }) {
  const about = draft.about.field === 'outcome';
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-muted">Outcome</legend>
      <div className="flex flex-wrap gap-3">
        {outcomeOptions(draft.outcomes, form.outcome).map((outcome) => (
          <label key={outcome} className="flex items-center gap-1 text-text">
            <input
              type="radio"
              name={name}
              value={outcome}
              checked={form.outcome === outcome}
              onChange={() => setForm((f) => ({ ...f, outcome }))}
              data-about={about && form.outcome === outcome ? '' : undefined}
            />
            {outcome}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const LEGEND: Record<PairField, string> = { outputs: 'Outputs', env: 'Env writes' };
const NOUN: Record<PairField, string> = { outputs: 'output', env: 'env write' };

/** The name the unknown is about in this field, which takes the focus and the candidate chips. */
function aboutName(about: DraftAbout, field: PairField): string | undefined {
  return about.field === field ? about.name : undefined;
}

/** Name and value rows, one per output or env write; a row is added and removed with a button. */
function Pairs({ field, draft, form, setForm }: FieldProps & { field: PairField }) {
  const about = aboutName(draft.about, field);
  const list = useRef<HTMLDivElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  // The row whose name takes the focus once the rows change: the one added (-1, the last), or the one in the place
  // of a removed row; with no row left, the Add button.
  const next = useRef<number>(undefined);
  const pairs = form[field];

  useEffect(() => {
    const at = next.current;
    if (at === undefined) return;
    next.current = undefined;
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [];
    const row = rows[at === -1 ? rows.length - 1 : Math.min(at, rows.length - 1)];
    (row?.querySelector('input') ?? add.current)?.focus();
  }, [pairs.length]);

  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-muted">{LEGEND[field]}</legend>
      <div ref={list} className="flex flex-col gap-1">
        {pairs.map((pair, i) => (
          <PairRow
            key={pair.id}
            field={field}
            pair={pair}
            n={i + 1}
            about={about !== undefined && pair.name.trim() === about}
            setForm={setForm}
            onRemove={() => {
              next.current = i;
              setForm((f) => withoutPair(f, field, pair.id));
            }}
          />
        ))}
      </div>
      {field === 'outputs' && about !== undefined && (
        <Candidates name={about} candidates={draft.candidates} form={form} setForm={setForm} />
      )}
      <button
        ref={add}
        type="button"
        onClick={() => {
          next.current = -1;
          setForm((f) => withPair(f, field));
        }}
        className={`${small} self-start`}
      >
        Add {NOUN[field]}
      </button>
    </fieldset>
  );
}

interface PairRowProps {
  field: PairField;
  pair: EditorPair;
  /** From 1, to name the row while it has no name. */
  n: number;
  about: boolean;
  setForm: SetForm;
  onRemove: () => void;
}

function PairRow({ field, pair, n, about, setForm, onRemove }: PairRowProps) {
  const noun = NOUN[field];
  const called = pair.name.trim() === '' ? `${noun} ${n}` : pair.name.trim();
  const unknown = typeof pair.held === 'object';
  return (
    <div data-row="" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-1">
      <input
        aria-label={`Name of ${noun} ${n}`}
        value={pair.name}
        onChange={(e) => setForm((f) => withPairEdit(f, field, pair.id, { name: e.target.value }))}
        spellCheck={false}
        className={input}
      />
      <input
        aria-label={`Value of ${called}`}
        value={pair.value}
        placeholder={unknown ? 'unknown' : undefined}
        onChange={(e) => setForm((f) => withPairEdit(f, field, pair.id, { value: e.target.value }))}
        spellCheck={false}
        data-about={about ? '' : undefined}
        className={input}
      />
      <button
        type="button"
        aria-label={`Remove ${called}`}
        onClick={onRemove}
        className="rounded px-1 text-muted hover:text-text"
      >
        ×
      </button>
    </div>
  );
}

const chip = (on: boolean): string =>
  `rounded border px-1.5 py-px font-mono text-[11px] ${
    on
      ? 'border-accent bg-accent-soft text-text'
      : 'border-border text-muted hover:border-border-strong hover:text-text'
  }`;

/** The values the producer can give the output, each a click away. */
function Candidates({
  name,
  candidates,
  form,
  setForm,
}: Omit<FieldProps, 'draft'> & { name: string; candidates: string[] }) {
  if (candidates.length === 0) return null;
  const current = form.outputs.find((p) => p.name.trim() === name)?.value;
  return (
    <div role="group" aria-label={`Values ${name} can take`} className="flex flex-wrap gap-1">
      {candidates.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={c === current}
          onClick={() => setForm((f) => withValue(f, 'outputs', name, c))}
          className={chip(c === current)}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

/** A model's presets, written as `as:` instead of the outputs they stand for, and the way back. */
function Presets({ draft, form, setForm }: FieldProps) {
  const group = useRef<HTMLDivElement>(null);
  const presets = draft.model?.presets ?? [];
  if (presets.length === 0 && form.as === undefined) return null;
  const custom = form.as !== undefined && !presets.includes(form.as);
  // Clearing takes its own button away: the focus goes to the first preset, else the group's first control.
  const clear = (): void => {
    setForm((f) => withPreset(f, undefined, formOf(draft.entry)));
    group.current?.querySelector('button')?.focus();
  };
  return (
    <div
      ref={group}
      role="group"
      aria-label={`Presets of ${draft.model?.id ?? 'the model'}`}
      className="flex flex-col gap-1"
    >
      <span className="text-muted">
        as: {draft.model && <span className="font-mono">{draft.model.id}</span>}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={form.as === p}
            onClick={() => setForm((f) => withPreset(f, p))}
            className={chip(form.as === p)}
          >
            {p}
          </button>
        ))}
        {custom && <span className={chip(true)}>{form.as}</span>}
        {form.as !== undefined && (
          <button type="button" onClick={clear} className={small}>
            Clear as:
          </button>
        )}
      </div>
    </div>
  );
}
