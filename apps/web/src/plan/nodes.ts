import type {
  ActionPlan,
  Decision,
  JobPlan,
  LegPlan,
  Loc,
  NodeId,
  RunPlan,
  StepPlan,
  WorkflowPlan,
} from '@simulci/engine';

/**
 * Every node of a plan by id, with the plan objects around it: what the panels and the YAML pane read about the
 * selection. A job without a matrix has one bare leg that shares its id; the job stands for it. A composite action is
 * listed under its own id and its inner steps as steps of the same leg.
 */

export type PlanNode =
  | { kind: 'workflow'; workflow: WorkflowPlan }
  | { kind: 'job'; job: JobPlan; workflow: WorkflowPlan }
  | { kind: 'leg'; leg: LegPlan; job: JobPlan; workflow: WorkflowPlan }
  | { kind: 'step'; step: StepPlan; leg: LegPlan; job: JobPlan; workflow: WorkflowPlan }
  | {
      kind: 'composite';
      action: ActionPlan;
      step: StepPlan;
      leg: LegPlan;
      job: JobPlan;
      workflow: WorkflowPlan;
    };

const cache = new WeakMap<RunPlan, Map<NodeId, PlanNode>>();

/** The plan's nodes by id, built once per plan. */
export function planNodes(plan: RunPlan): Map<NodeId, PlanNode> {
  let nodes = cache.get(plan);
  if (!nodes) {
    nodes = new Map();
    for (const wf of plan.workflows) if (wf.depth === 0) addWorkflow(nodes, wf);
    cache.set(plan, nodes);
  }
  return nodes;
}

function addWorkflow(nodes: Map<NodeId, PlanNode>, workflow: WorkflowPlan): void {
  nodes.set(workflow.id, { kind: 'workflow', workflow });
  for (const job of workflow.jobs) {
    nodes.set(job.id, { kind: 'job', job, workflow });
    for (const leg of job.legs) addLeg(nodes, leg, job, workflow);
  }
}

function addLeg(nodes: Map<NodeId, PlanNode>, leg: LegPlan, job: JobPlan, workflow: WorkflowPlan): void {
  if (leg.id !== job.id) nodes.set(leg.id, { kind: 'leg', leg, job, workflow });
  if (leg.call) addWorkflow(nodes, leg.call);
  for (const step of leg.steps ?? []) addStep(nodes, step, leg, job, workflow);
}

function addStep(
  nodes: Map<NodeId, PlanNode>,
  step: StepPlan,
  leg: LegPlan,
  job: JobPlan,
  workflow: WorkflowPlan,
): void {
  nodes.set(step.id, { kind: 'step', step, leg, job, workflow });
  if (!step.composite) return;
  nodes.set(step.composite.id, { kind: 'composite', action: step.composite, step, leg, job, workflow });
  for (const inner of step.composite.steps) addStep(nodes, inner, leg, job, workflow);
}

/** The decision a node's verdict comes from: a workflow's trigger, a job's, leg's or step's `runs`; a composite's step's. */
export function decisionOf(node: PlanNode): Decision {
  if (node.kind === 'workflow') return node.workflow.triggered;
  if (node.kind === 'job') return node.job.runs;
  if (node.kind === 'leg') return node.leg.runs;
  return node.step.runs;
}

/** Where a node is declared: a job's or step's own line, a leg's matrix (else its job), a workflow's file. */
export function declaredAt(node: PlanNode): Loc | undefined {
  if (node.kind === 'workflow') return { file: node.workflow.path, line: 1, column: 1 };
  if (node.kind === 'job') return node.job.loc;
  if (node.kind === 'leg') return node.job.matrix?.loc ?? node.job.loc;
  return node.step.loc;
}
