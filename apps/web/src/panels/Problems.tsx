import type { NodeId } from '@simulci/engine';
import { useMemo } from 'react';
import { useApp, useSession } from '../app/providers';
import { planIndex, selectionOf } from '../plan/index';
import type { PlanState } from '../state/store';
import { EmptyNote, LocLink } from './kit';
import { type ProblemRow, placeOf, problemRows } from './problem-rows';

/**
 * The Problems tab (synthesis § 10): files that could not be read, files that are not UTF-8, files that are no
 * workflow, the plan's diagnostics.
 */
export function Problems() {
  const outline = useSession((s) => s.project.outline);
  const plan = useSession((s) => s.plan);
  const files = useSession((s) => s.files);
  const rows = useMemo(() => problemRows(outline, plan?.plan, files), [outline, plan, files]);
  if (rows.length === 0)
    return <EmptyNote>No problems: every file was read and the plan has no diagnostics.</EmptyNote>;
  return (
    <ul aria-label="Problems" className="flex flex-col">
      {rows.map((row, i) => (
        <Problem key={i} row={row} plan={plan} />
      ))}
    </ul>
  );
}

/** The severity in words, with a glyph that does not lean on its colour. */
const SEVERITY: Record<ProblemRow['severity'], { glyph: string; className: string }> = {
  error: { glyph: '✕', className: 'text-danger' },
  warning: { glyph: '!', className: 'text-might-text' },
  info: { glyph: 'i', className: 'text-muted' },
};

function Problem({ row, plan }: { row: ProblemRow; plan: PlanState | undefined }) {
  const severity = SEVERITY[row.severity];
  return (
    <li className="flex flex-col gap-1 border-border border-b py-2 first:pt-0 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span aria-hidden="true" className={`w-3 text-center font-bold font-mono ${severity.className}`}>
          {severity.glyph}
        </span>
        <span className="font-medium">{row.severity}</span>
        <span className="font-mono text-muted">{row.code}</span>
        {row.file !== undefined && row.line !== undefined && (
          <LocLink loc={{ file: row.file, line: row.line }}>{placeOf(row)}</LocLink>
        )}
        {row.node !== undefined && plan && <SelectNode node={row.node} plan={plan} />}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{row.message}</p>
    </li>
  );
}

/** The node a diagnostic is about, by its unit path; a click selects it. */
function SelectNode({ node, plan }: { node: NodeId; plan: PlanState }) {
  const { store } = useApp();
  const index = planIndex(plan);
  const label = index.nodes.get(node)?.unitPath ?? node;
  const onClick = (): void => {
    const next = selectionOf(index, node);
    store.getState().select(next.focus, next.sel);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Select ${label}`}
      className="min-w-0 break-all rounded px-1 text-left font-mono text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-text"
    >
      {label}
    </button>
  );
}
