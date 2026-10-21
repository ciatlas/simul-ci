import type { Fp, Json, WorkflowDocument, WorkflowOp, YamlPath } from '@simulci/document';
import { useId, useState } from 'react';
import { useApp } from '../../app/providers';
import { control, monoControl } from '../../scenario/fields/kit';
import { type DeclaredInput, mustSet } from '../catalog';
import { dispatch } from '../dispatch';
import { RefusalNote } from '../Refusal';
import { LineLink, PropertyField } from './Field';
import { asText, bindingValue, type FieldSpec } from './model';
import { fingerprintOf, type SessionTarget } from './session';

/**
 * The pairs of a map Properties edits a key at a time (synthesis § 4.4): a job's `outputs` and `env`, a step's `with`
 * and `env`, a call's `with` and `secrets`. Each value is a field of its own; × removes its key, and the last row
 * adds one. Inputs an action or a reusable workflow declares come first, with their descriptions, the required ones
 * marked and their defaults as placeholders: a required input with no default that is not set is an amber row, which
 * a value typed into it adds. A key they do not declare says so, and so does a deprecated input. A map written as
 * YAML a row cannot hold (an alias, a merge key, flow over several lines) is shown with Edit in YAML.
 */

export interface KeyValueRowsProps {
  title: string;
  target: SessionTarget;
  doc: WorkflowDocument;
  /** Where the map is in the document. */
  path: YamlPath;
  /** The op that sets one key, or removes it with `null`; a step's carries the fingerprint the gesture read. */
  op: (name: string, value: Json | null, fp?: Fp) => WorkflowOp;
  /** What may be passed: an action's or a reusable workflow's inputs, and who declares them. */
  declared?: { inputs: readonly DeclaredInput[]; by: string };
  locked?: boolean;
}

interface Row {
  name: string;
  /** Written in the file. */
  present: boolean;
  input?: DeclaredInput;
}

export function KeyValueRows({ title, target, doc, path, op, declared, locked }: KeyValueRowsProps) {
  const map = doc.get(path);
  const odd = map && (map.alias !== undefined || map.merge || map.kind !== 'map' || multilineFlow(map));
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="font-medium text-muted text-xs uppercase tracking-wide">{title}</h3>
      {odd ? (
        <p className="text-xs">
          <span className="text-muted">{title} is written as YAML these rows cannot hold. </span>
          <LineLink file={target.file} line={map.line} label="Edit in YAML" />
        </p>
      ) : (
        <>
          {rowsOf(map?.value, declared?.inputs).map((row) => (
            <PairRow key={row.name} {...{ row, target, doc, path, op, locked }} by={declared?.by} />
          ))}
          {!locked && <AddRow target={target} op={op} title={title} />}
        </>
      )}
    </section>
  );
}

/** A flow map that spans lines or holds comments: the ops refuse to splice into it. */
const multilineFlow = (map: { flow: boolean; source: string }): boolean =>
  map.flow && (map.source.includes('\n') || map.source.includes('#'));

/** The keys written, in file order, then the declared ones not written: the required first. */
function rowsOf(value: Json | undefined, inputs: readonly DeclaredInput[] = []): Row[] {
  const written = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  const byName = new Map(inputs.map((i) => [i.name.toLowerCase(), i]));
  const rows: Row[] = written.map((name) => {
    const input = byName.get(name.toLowerCase());
    return input ? { name, present: true, input } : { name, present: true };
  });
  const missing = inputs.filter((i) => !written.some((w) => w.toLowerCase() === i.name.toLowerCase()));
  for (const input of [...missing.filter((i) => i.required), ...missing.filter((i) => !i.required)])
    rows.push({ name: input.name, present: false, input });
  return rows;
}

function PairRow({
  row,
  target,
  doc,
  path,
  op,
  locked,
  by,
}: {
  row: Row;
  target: SessionTarget;
  doc: WorkflowDocument;
  path: YamlPath;
  op: KeyValueRowsProps['op'];
  locked?: boolean;
  by?: string;
}) {
  const { store } = useApp();
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const spec: FieldSpec = {
    key: row.name,
    label: row.name,
    kind: 'value',
    path: [...path, row.name],
    op: (value, fp) => op(row.name, value, fp),
    ...(row.input?.default !== undefined ? { placeholder: asText(row.input.default) } : {}),
  };
  const remove = (): void => {
    const result = dispatch(store, op(row.name, null, fingerprintOf(store, target)));
    setRefusedSeq(result.ok ? undefined : result.refused.seq);
  };
  const missing = row.input !== undefined && mustSet(row.input) && !row.present;
  const description = row.input?.description;
  return (
    <div className={`flex flex-col gap-1 ${missing ? 'border-might border-l-2 pl-1.5' : ''}`}>
      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <PropertyField spec={spec} target={target} doc={doc} locked={locked} />
        </div>
        {row.present && !locked && (
          <button
            type="button"
            className="mb-1 rounded px-1.5 text-muted hover:text-text"
            aria-label={`Remove ${row.name}`}
            onClick={remove}
          >
            ×
          </button>
        )}
      </div>
      {description && (
        <p className="truncate text-muted text-xs" title={description}>
          {description}
        </p>
      )}
      {missing ? (
        <p className="text-might-text text-xs">required by {by}, and not set</p>
      ) : (
        row.input?.required && !row.present && <p className="text-muted text-xs">required by {by}</p>
      )}
      {row.input?.deprecated && row.present && <p className="text-might-text text-xs">deprecated by {by}</p>}
      {by && !row.input && <p className="text-might-text text-xs">not an input of {by}</p>}
      <RefusalNote seq={refusedSeq} />
    </div>
  );
}

/** A new pair: its key and its value, added on Enter in the value or with Add. */
function AddRow({
  target,
  op,
  title,
}: {
  target: SessionTarget;
  op: KeyValueRowsProps['op'];
  title: string;
}) {
  const { store } = useApp();
  const id = useId();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const add = (): void => {
    if (name.trim() === '') return;
    const result = dispatch(
      store,
      op(name.trim(), bindingValue(value, undefined), fingerprintOf(store, target)),
    );
    if (!result.ok) return setRefusedSeq(result.refused.seq);
    setRefusedSeq(undefined);
    setName('');
    setValue('');
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          id={`${id}-name`}
          aria-label={`New key of ${title}`}
          placeholder="key"
          className={monoControl}
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label={`Value of the new key of ${title}`}
          placeholder="value"
          className={control}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            add();
          }}
        />
        <button
          type="button"
          className="rounded border border-border bg-surface px-2 py-1 text-xs hover:bg-chrome disabled:opacity-50"
          disabled={name.trim() === ''}
          onClick={add}
        >
          Add
        </button>
      </div>
      <RefusalNote seq={refusedSeq} />
    </div>
  );
}
