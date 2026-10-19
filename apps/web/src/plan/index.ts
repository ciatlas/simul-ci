import type {
  JobPlan,
  LegPlan,
  NodeId,
  RunPlan,
  StepPlan,
  Tri,
  UnknownId,
  WorkflowPlan,
} from '@simulci/engine';
import { type CheckVerdict, checksOf } from '@simulci/engine/plan';
import type { Derived } from '../worker/protocol';

/**
 * Lookups over one plan, built once per plan: every node in pre-order with its kind, parent and verdict, the
 * unknowns that make each node maybe, the predicted checks, and the unit paths that name nodes in the URL's `sel`.
 */

export type NodeKind = Derived['kinds'][string];

export interface IndexedNode {
  id: NodeId;
  kind: NodeKind;
  parent?: NodeId;
  verdict: Tri;
  /** The depth-0 workflow it belongs to. */
  workflow: string;
  /** Its unit path within that workflow; absent for a workflow. */
  unitPath?: string;
}

export interface PlanIndex {
  /** Pre-order: a workflow, its jobs, each job's legs, each leg's steps and callee. */
  nodes: Map<NodeId, IndexedNode>;
  /** The unknowns that make a node `maybe`, from `unknown.affects`. */
  affectedBy: Map<NodeId, UnknownId[]>;
  checks: CheckVerdict[];
  /** Per depth-0 workflow, unit path → node. */
  byPath: Map<string, Map<string, NodeId>>;
}

/** One depth-0 workflow being walked: where its nodes go and the paths that name them. */
interface Walk {
  index: PlanIndex;
  derived: Derived;
  workflow: string;
  paths: Map<string, NodeId>;
}

export function indexPlan(plan: RunPlan, derived: Derived): PlanIndex {
  const index: PlanIndex = {
    nodes: new Map(),
    affectedBy: new Map(),
    checks: checksOf(plan),
    byPath: new Map(),
  };
  for (const wf of plan.workflows) {
    if (wf.depth !== 0) continue;
    const paths = new Map<string, NodeId>();
    index.byPath.set(wf.path, paths);
    addWorkflow({ index, derived, workflow: wf.path, paths }, wf, undefined);
  }
  for (const u of plan.unknowns) {
    for (const id of u.affects) {
      const list = index.affectedBy.get(id);
      if (list) list.push(u.id);
      else index.affectedBy.set(id, [u.id]);
    }
  }
  return index;
}

const indexes = new WeakMap<RunPlan, PlanIndex>();

/** The index of the store's plan, built once per plan whoever asks first: the canvas, the tree or the keys. */
export function planIndex(plan: { plan: RunPlan; derived: Derived }): PlanIndex {
  let index = indexes.get(plan.plan);
  if (!index) {
    index = indexPlan(plan.plan, plan.derived);
    indexes.set(plan.plan, index);
  }
  return index;
}

// A unit path names the first node that has it: a single leg is its job (same id), a composite is its step.
function add(w: Walk, id: NodeId, kind: NodeKind, verdict: Tri, parent: NodeId | undefined): void {
  const node: IndexedNode = { id, kind: w.derived.kinds[id] ?? kind, verdict, workflow: w.workflow };
  if (parent !== undefined) node.parent = parent;
  const unitPath = w.derived.unitPaths[id];
  if (unitPath !== undefined) {
    node.unitPath = unitPath;
    if (!w.paths.has(unitPath)) w.paths.set(unitPath, id);
  }
  w.index.nodes.set(id, node);
}

function addWorkflow(w: Walk, wf: WorkflowPlan, parent: NodeId | undefined): void {
  add(w, wf.id, 'workflow', wf.triggered.verdict, parent);
  for (const job of wf.jobs) addJob(w, job, wf.id);
}

function addJob(w: Walk, job: JobPlan, parent: NodeId): void {
  add(w, job.id, 'job', job.runs.verdict, parent);
  for (const leg of job.legs) addLeg(w, leg, job);
}

function addLeg(w: Walk, leg: LegPlan, job: JobPlan): void {
  // A job without a matrix has one bare leg that shares its id: the job stands for it.
  if (leg.id !== job.id) add(w, leg.id, 'leg', leg.runs.verdict, job.id);
  if (leg.call) addWorkflow(w, leg.call, leg.id);
  for (const step of leg.steps ?? []) addStep(w, step, leg.id);
}

function addStep(w: Walk, step: StepPlan, parent: NodeId): void {
  add(w, step.id, 'step', step.runs.verdict, parent);
  if (!step.composite) return;
  add(w, step.composite.id, 'composite', step.runs.verdict, step.id);
  for (const inner of step.composite.steps) addStep(w, inner, step.composite.id);
}

/**
 * The node a selection names. A unit path the plan no longer has falls back to its nearest ancestor path (a step to
 * its leg, a leg to its job); none at all, or no unit path, names the focused workflow.
 */
export function resolveSelection(
  index: PlanIndex,
  focus: string | undefined,
  sel: string | undefined,
): NodeId | undefined {
  const paths = focus === undefined ? undefined : index.byPath.get(focus);
  if (focus === undefined || paths === undefined) return undefined;
  if (!sel) return focus;
  return paths.get(sel) ?? nearestAncestor(paths, sel) ?? focus;
}

/** Where a part of a unit path begins: `.` a step, `/` a callee's job or a composite's step, `[` a leg. */
const BOUNDARY = new Set(['.', '/', '[']);

/** The longest prefix that ends a part and names a node: a unit's path begins with each of its ancestors' paths. */
function nearestAncestor(paths: Map<string, NodeId>, sel: string): NodeId | undefined {
  for (let i = sel.length - 1; i > 0; i--) {
    const id = BOUNDARY.has(sel[i]!) ? paths.get(sel.slice(0, i)) : undefined;
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * The focus and unit path that select a node; a called workflow is selected through the leg that calls it. An id the
 * plan does not have selects the workflow its id starts with.
 */
export function selectionOf(index: PlanIndex, id: NodeId): { focus: string; sel?: string } {
  const node = index.nodes.get(id);
  if (!node) return { focus: id.split('#')[0]! };
  if (node.kind === 'workflow' && node.parent !== undefined) return selectionOf(index, node.parent);
  return node.unitPath === undefined
    ? { focus: node.workflow }
    : { focus: node.workflow, sel: node.unitPath };
}
