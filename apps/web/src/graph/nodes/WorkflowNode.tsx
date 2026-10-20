import type { NodeProps } from '@xyflow/react';
import { memo, type MouseEvent, useMemo } from 'react';
import { useApp } from '../../app/providers';
import { gestures } from '../../edit/gestures';
import { cardActions, cardAttrs, countParts, countsText, deepCallee, scopeTitle } from '../card';
import type { WorkflowFlowNode } from '../flow';
import { Mark } from '../Mark';
import { CARD } from '../types';
import { HoverCard } from './HoverCard';

/**
 * A workflow instance: a depth-0 workflow, or the one a job's representative leg calls, drawn inside that job's
 * card. Laid out, it is a frame with a title bar (mark, name or path, its jobs' counts, who calls it) around its
 * job cards; collapsed, it is one line with its deciding clause: an untriggered workflow, or a callee past depth 2
 * that a click opens (and its Open button, for the keyboard: a tab stop while the workflow is selected). The
 * untriggered workflow being edited is laid out instead, dimmed, its jobs skipped under it. The workflow being edited
 * has + Add job in its title bar.
 */
function WorkflowNodeView({ data }: NodeProps<WorkflowFlowNode>) {
  const { store } = useApp();
  const act = useMemo(() => cardActions(store), [store]);
  const { scope, state } = data;
  const deep = deepCallee(scope);
  const open = (e: MouseEvent): void => {
    e.stopPropagation();
    act.toggleOpened(scope.id);
  };
  const attrs = {
    ...cardAttrs(scope.verdict, state),
    'data-collapsed': scope.collapsed ? 'true' : undefined,
    'data-dimmed': scope.dimmed ? 'true' : undefined,
  };
  if (scope.collapsed)
    return (
      <div className="sc-scope" {...attrs}>
        <div
          className="sc-scope-line"
          style={{ height: CARD.collapsed.height }}
          onClick={deep ? () => act.toggleOpened(scope.id) : undefined}
        >
          <Mark verdict={scope.verdict} />
          <span className="sc-scope-title">{scopeTitle(scope)}</span>
          <span className="sc-scope-clause font-mono">{scope.clause}</span>
          {deep && (
            <button
              type="button"
              className="sc-open nodrag"
              tabIndex={state.selected ? 0 : -1}
              aria-expanded={false}
              onClick={open}
            >
              Open
            </button>
          )}
        </div>
        <HoverCard
          visible={state.hovered}
          facts={{ verdict: scope.verdict, label: scopeTitle(scope), clause: scope.clause }}
        />
      </div>
    );
  return (
    <div className="sc-scope" {...attrs}>
      <div className="sc-scope-bar" style={{ height: CARD.scopePadding.top - CARD.padding }}>
        <Mark verdict={scope.verdict} />
        <span className="sc-scope-title">{scopeTitle(scope)}</span>
        {scope.name !== undefined && <span className="sc-scope-path font-mono">{scope.path}</span>}
        <span className="sc-counts" aria-hidden="true">
          {countParts(scope.counts).map((p) => (
            <span key={p.verdict}>
              {p.n}{' '}
              <span className="sc-glyph-text" data-verdict={p.verdict}>
                {p.glyph}
              </span>
            </span>
          ))}
        </span>
        <span className="sr-only">{countsText(scope.counts)}</span>
        {data.caller !== undefined && <span className="sc-scope-caller">called by {data.caller}</span>}
        {data.editable && <AddJob tabStop={state.selected} />}
        {deep && (
          <button
            type="button"
            className="sc-open nodrag"
            tabIndex={state.selected ? 0 : -1}
            aria-expanded
            onClick={open}
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}

/** + Add job in the title bar of the workflow being edited: a job of its own, after the others. */
function AddJob({ tabStop }: { tabStop: boolean }) {
  const { store } = useApp();
  const add = (e: MouseEvent): void => {
    e.stopPropagation();
    cardActions(store).selectFocus();
    gestures.of(store)?.addJob();
  };
  return (
    <button
      type="button"
      className="sc-add-job nodrag nopan"
      tabIndex={tabStop ? 0 : -1}
      aria-keyshortcuts="A"
      onClick={add}
    >
      + Add job
    </button>
  );
}

export const WorkflowNode = memo(WorkflowNodeView);
