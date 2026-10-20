import type { NodeId } from '@simulci/engine';
import type { MouseEvent } from 'react';
import { useApp } from '../../app/providers';
import { listRows } from '../../graph/card';
import { Mark, MARK_LABEL } from '../../graph/Mark';
import { CARD, type JobModel } from '../../graph/types';
import { planIndex, selectionOf } from '../../plan/index';
import type { SessionStore } from '../../state/store';
import { hostUi } from '../canvas/ui';
import { gestures } from '../gestures';
import { type Target, targetOf } from '../selection';
import { moveStep } from './actions';
import { DragHandle, InsertGap, useStepDrag } from './rows';

/**
 * The open step list of a card of the workflow being edited (synthesis § 4.5): the read-only list's rows, the job's own
 * steps with a handle to drag them to another place and + between them for the palette; a composite action's inner
 * steps stay as they are. The rows are the plan's, so each gesture reads its step with `planned`: while the plan lags
 * the text, a step known only by its position is refused rather than mistaken for another. Rows are not tab stops:
 * the canvas keys walk them, Alt+↑/↓ move the selected one, Delete removes it and `s` opens the palette after it.
 */
export function CanvasSteps({
  job,
  selected,
  onPick,
}: {
  job: JobModel;
  selected?: NodeId;
  onPick: (step: NodeId) => void;
}) {
  const { store } = useApp();
  const { rows, more } = listRows(job.steps);
  const own = job.steps.map((s) => s.id);
  const move = (from: number, to: number): void => {
    const step = rowTarget(store, own[from]);
    const place = rowTarget(store, own[to])?.step?.index;
    const ui = hostUi.of(store);
    if (step && ui && place !== undefined) moveStep(store, ui, step, place);
  };
  const insert = (before: number): void => {
    const index = before === 0 ? 0 : rowTarget(store, own[before - 1])?.step?.index;
    if (index !== undefined)
      gestures.of(store)?.palette({ job: job.jobId, index: before === 0 ? 0 : index + 1 });
  };
  const drag = useStepDrag(move);
  return (
    <ul className="sc-list sc-list-edit" aria-label={`${rows.length + more} steps`}>
      {rows.map(({ step, depth }) => {
        const at = depth === 0 ? own.indexOf(step.id) : -1;
        const pick = (e: MouseEvent): void => {
          e.stopPropagation();
          onPick(step.id);
        };
        return (
          <li
            key={step.id}
            data-step={step.id}
            data-selected={step.id === selected ? 'true' : undefined}
            style={{ height: CARD.listRow, paddingLeft: depth * 12 }}
            onClick={pick}
            {...(at >= 0 ? drag.target(at) : {})}
          >
            {at >= 0 && <DragHandle {...drag.handle(at)} />}
            {at >= 0 && <InsertGap label={`Add a step before ${step.label}`} onInsert={() => insert(at)} />}
            {at === own.length - 1 && (
              <InsertGap after label={`Add a step after ${step.label}`} onInsert={() => insert(own.length)} />
            )}
            <Mark verdict={step.verdict} title={MARK_LABEL[step.verdict]} />
            <span className="sc-list-label">{step.label}</span>
            {step.outputs && <span className="sc-list-outputs font-mono">{step.outputs}</span>}
          </li>
        );
      })}
      {more > 0 && (
        <li className="sc-list-more" style={{ height: CARD.listRow }}>
          +{more}
        </li>
      )}
    </ul>
  );
}

/** A row's step in the text now, read as the plan names it. */
function rowTarget(store: SessionStore, id: NodeId | undefined): Target | undefined {
  const s = store.getState();
  if (id === undefined || !s.plan) return undefined;
  const { focus, sel } = selectionOf(planIndex(s.plan), id);
  return sel === undefined ? undefined : targetOf(store, focus, sel, { planned: true });
}
