import type { NodeId } from '@simulci/engine';
import { useApp } from '../../app/providers';
import { type RowEdit, StepList } from '../../graph/nodes/StepList';
import type { JobModel, StepMark } from '../../graph/types';
import { planIndex, selectionOf } from '../../plan/index';
import type { SessionStore } from '../../state/store';
import { hostUi } from '../canvas/ui';
import { gestures } from '../gestures';
import { type Target, targetOf } from '../selection';
import { moveStep } from './actions';
import { DragHandle, InsertGap, useStepDrag } from './rows';

/**
 * The open step list of a card of the workflow being edited (synthesis § 4.5): the read-only list, the job's own
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
  const edit = (step: StepMark, depth: number): RowEdit | undefined => {
    const at = depth === 0 ? own.indexOf(step.id) : -1;
    if (at < 0) return undefined;
    const controls = (
      <>
        <DragHandle {...drag.handle(at)} />
        <InsertGap label={`Add a step before ${step.label}`} onInsert={() => insert(at)} />
        {at === own.length - 1 && (
          <InsertGap after label={`Add a step after ${step.label}`} onInsert={() => insert(own.length)} />
        )}
      </>
    );
    return { attrs: drag.target(at), controls };
  };
  return <StepList steps={job.steps} selected={selected} onPick={onPick} edit={edit} />;
}

/** A row's step in the text now, read as the plan names it. */
function rowTarget(store: SessionStore, id: NodeId | undefined): Target | undefined {
  const s = store.getState();
  if (id === undefined || !s.plan) return undefined;
  const { focus, sel } = selectionOf(planIndex(s.plan), id);
  return sel === undefined ? undefined : targetOf(store, focus, sel, { planned: true });
}
