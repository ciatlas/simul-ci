import type { Rename } from '@simulci/document';
import type { NodeId, RunPlan, WorkflowPlan } from '@simulci/engine';
import type { SelectionRef } from '../../state/history';
import { type Renames, renamedUnit } from '../../state/renames';
import type { SessionState } from '../../state/store';
import type { PlannedOp } from '../types';

/**
 * A rename's ids as the page keeps them (synthesis § 4.10, § 7.4): the plan's NodeIds it changes, read from the plan
 * on screen, which is of the text the rename was made on, and the unit path of the selection.
 */

/**
 * The renames of a commit, with the NodeIds of the plan shown they change: a job's, in every instance of its workflow
 * (a called one included, under its caller's leg); a step's id, in each leg of its job. Undefined when nothing is
 * renamed.
 */
export function renamesOf(s: Pick<SessionState, 'plan'>, renames: readonly Rename[]): Renames | undefined {
  if (renames.length === 0) return undefined;
  const nodes: Record<NodeId, NodeId> = {};
  for (const wf of s.plan ? workflowsOf(s.plan.plan) : [])
    for (const r of renames) if (wf.path === r.file) Object.assign(nodes, nodesOf(wf, r));
  return { nodes, ids: renames };
}

/** A workflow's NodeIds a rename changes. A step without an id has no `steps.<id>` key to follow. */
function nodesOf(wf: WorkflowPlan, r: Rename): Record<NodeId, NodeId> {
  if (r.kind === 'job') return { [`${wf.id}#${r.from}`]: `${wf.id}#${r.to}` };
  const job = wf.jobs.find((j) => j.jobId === r.job);
  const nodes: Record<NodeId, NodeId> = {};
  for (const leg of job?.legs ?? [])
    for (const step of leg.steps ?? [])
      if (step.stepId === r.from) nodes[step.id] = `${leg.id}/steps.${r.to}`;
  return nodes;
}

/** Every workflow of the plan, the called ones under their callers' legs included. */
function workflowsOf(plan: RunPlan): WorkflowPlan[] {
  const out: WorkflowPlan[] = [];
  const visit = (wf: WorkflowPlan): void => {
    out.push(wf);
    for (const job of wf.jobs) for (const leg of job.legs) if (leg.call) visit(leg.call);
  };
  for (const wf of plan.workflows) visit(wf);
  return out;
}

/**
 * The selection in the terms after the renames: a leg or a step of a job renamed keeps its place under the new id, and
 * so does a step selected by its position (`build[os=b].#1`) that is given its first id.
 */
export function renamedSelection(
  s: Pick<SessionState, 'focus' | 'sel'>,
  renames: readonly Rename[],
  ops: readonly PlannedOp[] = [],
): SelectionRef {
  const all = [...renames, ...ops.flatMap(({ op }) => firstId(op))];
  const sel =
    s.sel === undefined
      ? undefined
      : all.reduce((path, r) => (r.file === s.focus ? renamedUnit(path, r) : path), s.sel);
  return { ...(s.focus === undefined ? {} : { focus: s.focus }), ...(sel === undefined ? {} : { sel }) };
}

/** A step given its first id, as a rename of its position: no plan node or reference names that position. */
const firstId = (op: PlannedOp['op']): Rename[] =>
  op.op === 'renameStepId' && op.fp.id === undefined
    ? [{ kind: 'step', file: op.file, job: op.job, from: `#${op.index + 1}`, to: op.to }]
    : [];
