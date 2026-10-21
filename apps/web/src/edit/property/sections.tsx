import type { IfReason, Value } from '@simulci/engine';
import type { Json, WorkflowDocument, YamlPath } from '@simulci/document';
import { useState } from 'react';
import { useApp, useSession } from '../../app/providers';
import { SectionTitle, useSelected } from '../../panels/kit';
import { decisionOf, planNodes } from '../../plan/nodes';
import { newestOutline } from '../../state/store';
import { dispatch } from '../dispatch';
import { listOf, needsTransitively } from '../needs';
import { RefusalNote } from '../Refusal';
import { LineLink } from './Field';

/** The parts of Properties that are not one field: needs, the YAML-only rows, what `if` evaluates to (the steps: PanelSteps). */

/** A job's `needs` as checkboxes: every other job but those that need it, which would close a loop. */
export function Needs({
  doc,
  file,
  job,
  locked,
}: {
  doc: WorkflowDocument;
  file: string;
  job: string;
  locked?: boolean;
}) {
  const { store } = useApp();
  const outline = useSession(newestOutline);
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const info = doc.get(['jobs', job, 'needs']);
  const needs = info ? listOf(info.value) : [];
  if (info && (info.alias !== undefined || info.merge || needs === undefined))
    return <YamlRow label="Needs" source={info.source} file={file} line={info.line} />;
  const others = doc
    .jobs()
    .map((j) => j.id)
    .filter((id) => id !== job && !needsTransitively(doc, id, job));
  const outputs = (id: string) =>
    outline?.workflows.find((w) => w.path === file)?.jobs.find((j) => j.id === id)?.outputs;
  const toggle = (id: string, on: boolean): void => {
    const next = on ? [...needs!, id] : needs!.filter((n) => n.toLowerCase() !== id.toLowerCase());
    const result = dispatch(store, { op: 'setNeeds', file, job, needs: next });
    setRefusedSeq(result.ok ? undefined : result.refused.seq);
  };
  if (others.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 font-medium text-muted text-xs uppercase tracking-wide">Needs</legend>
      {others.map((id) => (
        <label key={id} className="flex items-baseline gap-2 text-sm">
          <input
            type="checkbox"
            disabled={locked}
            checked={needs!.some((n) => n.toLowerCase() === id.toLowerCase())}
            onChange={(e) => toggle(id, e.target.checked)}
          />
          <span className="font-mono">{id}</span>
          {outputs(id) && <span className="text-muted text-xs">outputs: {outputs(id)!.join(', ')}</span>}
        </label>
      ))}
      <RefusalNote seq={refusedSeq} />
    </fieldset>
  );
}

/** What Properties shows but does not edit: its source, and Edit in YAML, which opens the pane on its line. */
function YamlRow({
  label,
  source,
  file,
  line,
}: {
  label: string;
  source: string;
  file: string;
  line: number;
}) {
  const lines = source.split(/\r?\n/);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted text-xs">{label}</span>
        <LineLink file={file} line={line} label="Edit in YAML" />
      </div>
      <code className="truncate font-mono text-xs" title={source}>
        {lines[0]}
        {lines.length > 1 ? ' …' : ''}
      </code>
    </div>
  );
}

/** The YAML-only keys present under a map, each a row with Edit in YAML (§ 4.2). */
export function YamlRows({
  doc,
  file,
  at,
  keys,
}: {
  doc: WorkflowDocument;
  file: string;
  at: YamlPath;
  keys: readonly [key: string, label: string][];
}) {
  const rows = keys.flatMap(([key, label]) => {
    const info = doc.get([...at, key]);
    return info ? [{ key, label, info }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Edited in YAML">
      <SectionTitle>In the YAML</SectionTitle>
      {rows.map(({ key, label, info }) => (
        <YamlRow key={key} label={label} source={`${key}: ${info.source}`} file={file} line={info.line} />
      ))}
    </section>
  );
}

/**
 * What the selected node's `if:` evaluates to on the plan shown (synthesis § 4.4): the value, the condition as GitHub
 * evaluates it when that differs, and what it read; "(as of the last plan)" while the plan is behind the text.
 */
export function EvaluatesTo() {
  const selected = useSelected();
  const behind = useSession((s) => s.stale !== false);
  const node = selected?.node === undefined ? undefined : planNodes(selected.plan.plan).get(selected.node);
  const reason = node && decisionOf(node).chain.find((r): r is IfReason => r.kind === 'if');
  if (!reason) return null;
  const reads = reason.reads.map((r) => `${r.ref} is ${shownValue(r.value)}`);
  return (
    <p className="text-muted text-xs" data-evaluates>
      evaluates to <code className="font-mono text-text">{shownValue(reason.value)}</code>
      {reason.residual !== undefined && (
        <>
          {' — '}
          <code className="font-mono">{reason.residual}</code>
        </>
      )}
      {reads.length > 0 && <> with {reads.join(', ')}</>}
      {behind && ' (as of the last plan)'}
    </p>
  );
}

const shownValue = (value: Value<Json>): string => (value.known ? JSON.stringify(value.value) : 'unknown');
