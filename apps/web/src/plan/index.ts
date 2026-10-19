import type { NodeId, RunPlan, Tri, UnknownId } from '@simulci/engine';
import type { CheckVerdict } from '@simulci/engine/plan';
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

export function indexPlan(_plan: RunPlan, _derived: Derived): PlanIndex {
  throw new Error('not built yet');
}

/**
 * The node a selection names. A unit path the plan no longer has falls back to its nearest ancestor path (a step to
 * its leg, a leg to its job); none at all, or no unit path, names the focused workflow.
 */
export function resolveSelection(
  _index: PlanIndex,
  _focus: string | undefined,
  _sel: string | undefined,
): NodeId | undefined {
  throw new Error('not built yet');
}

/** The focus and unit path that select a node; a called workflow is selected through the leg that calls it. */
export function selectionOf(_index: PlanIndex, _id: NodeId): { focus: string; sel?: string } {
  throw new Error('not built yet');
}
