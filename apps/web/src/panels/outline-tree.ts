import type { NodeId, RunPlan, StepPlan, Tri, WorkflowPlan } from '@simulci/engine';
import type { NodeKind, PlanIndex } from '../plan/index';

/**
 * The outline tree's model, apart from React: every node of the plan index as a tree (workflows, jobs, legs, steps,
 * a composite action's inner steps under the step that uses it), the rows a set of open nodes shows, and the WAI-ARIA
 * tree keys as moves over those rows. The tree is the accessible baseline of the canvas: everything the canvas
 * shows is in it, with the same selection.
 */

export interface TreeNode {
  id: NodeId;
  kind: NodeKind;
  label: string;
  verdict: Tri;
  parent?: NodeId;
  children: NodeId[];
}

export interface OutlineModel {
  /** The depth-0 workflows in plan order. */
  roots: NodeId[];
  nodes: Map<NodeId, TreeNode>;
}

export interface TreeRow {
  node: TreeNode;
  /** From 1, as `aria-level` counts. */
  level: number;
  posinset: number;
  setsize: number;
  /** Absent for a node without children. */
  expanded?: boolean;
}

/** What a key does: moves the tab stop, opens or closes a node, or selects it. */
export type TreeMove = { focus: NodeId } | { open: NodeId } | { close: NodeId } | { select: NodeId };

export interface TreeKey {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The index as a tree; a composite node is left out and its inner steps hang under its step. */
export function outlineModel(index: PlanIndex, labels: ReadonlyMap<NodeId, string>): OutlineModel {
  const model: OutlineModel = { roots: [], nodes: new Map() };
  const composites = new Map<NodeId, NodeId | undefined>();
  for (const n of index.nodes.values()) {
    if (n.kind === 'composite') {
      composites.set(n.id, n.parent);
      continue;
    }
    const parent = n.parent !== undefined && composites.has(n.parent) ? composites.get(n.parent) : n.parent;
    const node: TreeNode = {
      id: n.id,
      kind: n.kind,
      label: labels.get(n.id) ?? n.unitPath ?? n.id,
      verdict: n.verdict,
      children: [],
    };
    if (parent !== undefined) node.parent = parent;
    model.nodes.set(n.id, node);
    const owner = parent === undefined ? undefined : model.nodes.get(parent);
    if (owner) owner.children.push(n.id);
    else model.roots.push(n.id);
  }
  return model;
}

/**
 * Each node's label as the canvas words it: a workflow's `name ?? path`, a job's `name ?? jobId`, a leg's key, a
 * step's `name ?? uses ?? stepId ?? key`.
 */
export function planLabels(plan: RunPlan): Map<NodeId, string> {
  const labels = new Map<NodeId, string>();
  for (const wf of plan.workflows) if (wf.depth === 0) labelWorkflow(wf, labels);
  return labels;
}

function labelWorkflow(wf: WorkflowPlan, labels: Map<NodeId, string>): void {
  labels.set(wf.id, wf.name ?? wf.path);
  for (const job of wf.jobs) {
    labels.set(job.id, job.name ?? job.jobId);
    for (const leg of job.legs) {
      if (leg.id !== job.id) labels.set(leg.id, leg.legKey);
      if (leg.call) labelWorkflow(leg.call, labels);
      for (const step of leg.steps ?? []) labelStep(step, labels);
    }
  }
}

function labelStep(step: StepPlan, labels: Map<NodeId, string>): void {
  labels.set(step.id, step.name ?? step.uses ?? step.stepId ?? step.key);
  for (const inner of step.composite?.steps ?? []) labelStep(inner, labels);
}

/** The rows the open nodes show, in tree order; untriggered workflows left out when the canvas hides them. */
export function visibleRows(
  model: OutlineModel,
  open: ReadonlySet<NodeId>,
  hideUntriggered = false,
): TreeRow[] {
  const roots = hideUntriggered
    ? model.roots.filter((id) => model.nodes.get(id)?.verdict !== 'no')
    : model.roots;
  const rows: TreeRow[] = [];
  pushRows(model, roots, 1, open, rows);
  return rows;
}

function pushRows(
  model: OutlineModel,
  ids: readonly NodeId[],
  level: number,
  open: ReadonlySet<NodeId>,
  rows: TreeRow[],
): void {
  ids.forEach((id, i) => {
    const node = model.nodes.get(id)!;
    const row: TreeRow = { node, level, posinset: i + 1, setsize: ids.length };
    if (node.children.length > 0) row.expanded = open.has(id);
    rows.push(row);
    if (row.expanded) pushRows(model, node.children, level + 1, open, rows);
  });
}

function ancestorsOf(model: OutlineModel, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  for (let p = model.nodes.get(id)?.parent; p !== undefined; p = model.nodes.get(p)?.parent) out.push(p);
  return out;
}

/** The open set with the selection's ancestors added, and a selected workflow itself, so its jobs show. */
export function openedFor(
  open: ReadonlySet<NodeId>,
  model: OutlineModel,
  selected: NodeId | undefined,
): ReadonlySet<NodeId> {
  if (selected === undefined || !model.nodes.has(selected)) return open;
  const wanted = ancestorsOf(model, selected);
  if (model.nodes.get(selected)!.kind === 'workflow') wanted.push(selected);
  const missing = wanted.filter((id) => !open.has(id));
  return missing.length === 0 ? open : new Set([...open, ...missing]);
}

export const toggled = (open: ReadonlySet<NodeId>, id: NodeId): ReadonlySet<NodeId> => {
  const next = new Set(open);
  if (!next.delete(id)) next.add(id);
  return next;
};

/** The one row Tab reaches: the row the keys last moved to, else the selection, else the first row. */
export function tabStop(
  rows: readonly TreeRow[],
  active: NodeId | undefined,
  selected: NodeId | undefined,
): NodeId | undefined {
  const shown = (id: NodeId | undefined): id is NodeId =>
    id !== undefined && rows.some((r) => r.node.id === id);
  if (shown(active)) return active;
  if (shown(selected)) return selected;
  return rows[0]?.node.id;
}

const focusAt = (rows: readonly TreeRow[], i: number): TreeMove | undefined => {
  const row = rows[i];
  return row ? { focus: row.node.id } : undefined;
};

/** → opens a closed node, or goes to the first child of an open one. */
function inward(rows: readonly TreeRow[], i: number): TreeMove | undefined {
  const row = rows[i]!;
  if (row.expanded === false) return { open: row.node.id };
  return row.expanded ? focusAt(rows, i + 1) : undefined;
}

/** ← closes an open node, or goes to the parent of a closed one or a leaf. */
function outward(rows: readonly TreeRow[], i: number): TreeMove | undefined {
  const row = rows[i]!;
  if (row.expanded) return { close: row.node.id };
  return row.node.parent === undefined ? undefined : { focus: row.node.parent };
}

const MOVES = new Map<string, (rows: readonly TreeRow[], i: number) => TreeMove | undefined>([
  ['ArrowDown', (rows, i) => focusAt(rows, i + 1)],
  ['ArrowUp', (rows, i) => focusAt(rows, i - 1)],
  ['Home', (rows) => focusAt(rows, 0)],
  ['End', (rows) => focusAt(rows, rows.length - 1)],
  ['ArrowRight', inward],
  ['ArrowLeft', outward],
  ['Enter', (rows, i) => ({ select: rows[i]!.node.id })],
]);

/** The move a key makes from the row that holds the tab stop; a combination with Alt, Ctrl or Meta is the browser's. */
export function treeKey(
  key: TreeKey,
  at: NodeId | undefined,
  rows: readonly TreeRow[],
): TreeMove | undefined {
  const move = MOVES.get(key.key);
  if (!move || key.altKey || key.ctrlKey || key.metaKey) return undefined;
  const i = rows.findIndex((r) => r.node.id === at);
  return i === -1 ? focusAt(rows, 0) : move(rows, i);
}
