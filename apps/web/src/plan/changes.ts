import type { NodeId, RunPlan, Tri, WorkflowPlan } from '@simulci/engine';
import { diffPlans, type PlanDiff } from '@simulci/engine/plan';
import { listed } from '../lib/words';
import type { Derived } from '../worker/protocol';
import { type IndexedNode, type NodeKind, planIndex } from './index';

/**
 * What a pin or an edit changed (synthesis § 7.4): the engine's diff of the plan before it and the plan that answers
 * it, and the verdict changes of that diff with the labels the status line says them by ("pinned; deploy now runs").
 * The diff already leaves out a unit whose parent changed too, so a workflow that is now triggered is one change and
 * not one per job, and it never lists a leg, which stands for nothing its job does not already say.
 */

export interface VerdictChange {
  id: NodeId;
  kind: NodeKind;
  from: Tri;
  to: Tri;
  /**
   * A workflow's name, else the unit's path in its workflow (`deploy`, `build.detect`, `test[node=22]`). A label that
   * repeats among the changes names its workflow (`deploy in CI`), and a workflow's own label that repeats is its path.
   */
  label: string;
}

export interface Planned {
  plan: RunPlan;
  derived: Derived;
}

/**
 * The diff of two plans of one scenario, made as if both were planned with the same `planUntriggered` (E1's rule):
 * edit mode plans the focused workflow's jobs although it is not triggered (C2), so a plan from before edit mode, or
 * of another focus, has that workflow as a shell. A workflow untriggered in both whose jobs only one plan has is a
 * shell in both, and its jobs are neither added nor removed. `renames` come from the transaction (C11), never guessed.
 */
export function diffOf(
  before: RunPlan,
  after: RunPlan,
  renames?: Readonly<Record<NodeId, NodeId>>,
): PlanDiff {
  const [was, now] = samePlanning(before, after);
  return diffPlans(was, now, renames ? { renames } : {});
}

function samePlanning(before: RunPlan, after: RunPlan): [RunPlan, RunPlan] {
  const was = new Map(before.workflows.map((w) => [w.id, w]));
  const shells = new Set<NodeId>();
  for (const wf of after.workflows) {
    const old = was.get(wf.id);
    if (old && untriggered(wf) && untriggered(old) && planned(wf) !== planned(old)) shells.add(wf.id);
  }
  if (!shells.size) return [before, after];
  const bare = (plan: RunPlan): RunPlan => ({
    ...plan,
    workflows: plan.workflows.map((w) => (shells.has(w.id) ? { ...w, jobs: [] } : w)),
  });
  return [bare(before), bare(after)];
}

const untriggered = (wf: WorkflowPlan): boolean => wf.triggered.verdict === 'no';
const planned = (wf: WorkflowPlan): boolean => wf.jobs.length > 0;

/** The changed units of `after`, in plan order, each under no changed ancestor: the diff's verdict changes, labelled. */
export function verdictChanges(
  before: Planned,
  after: Planned,
  diff: PlanDiff = diffOf(before.plan, after.plan),
): VerdictChange[] {
  const nodes = planIndex(after).nodes;
  const found = diff.changed.flatMap((c) => {
    const node = nodes.get(c.id);
    return node ? [{ node, from: c.from }] : [];
  });
  const labels = labelsOf(
    found.map((f) => f.node),
    after.plan,
  );
  return found.map(({ node, from }, i) => ({
    id: node.id,
    kind: node.kind,
    from,
    to: node.verdict,
    label: labels[i]!,
  }));
}

/**
 * The nodes' labels, in their order. A unit's path says nothing of its workflow, so the same path in two workflows
 * would read twice alike: a label that repeats among the nodes names the unit's depth-0 workflow (`deploy in CI`),
 * and a workflow's own label that repeats gives way to its path. A label that does not repeat stays as short as it
 * is (`deploy`), even when another workflow has a unit of that path.
 */
export function labelsOf(nodes: readonly IndexedNode[], plan: RunPlan): string[] {
  const plain = nodes.map((node) => labelOf(node, plan));
  const counts = countOf(plain);
  const names = workflowNames(plan);
  return nodes.map((node, i) => {
    const label = plain[i]!;
    if (counts.get(label) === 1) return label;
    if (node.kind === 'workflow') return workflowOf(plan, node.id)?.path ?? label;
    return `${label} in ${names.get(node.workflow) ?? node.workflow}`;
  });
}

function labelOf(node: IndexedNode, plan: RunPlan): string {
  if (node.kind !== 'workflow') return node.unitPath ?? node.id;
  const wf = workflowOf(plan, node.id);
  return wf?.name ?? wf?.path ?? node.id;
}

const workflowOf = (plan: RunPlan, id: NodeId) => plan.workflows.find((w) => w.id === id);

/**
 * What a qualified label calls each depth-0 workflow, by its path: its name, else its path. Two workflows of the
 * plan that share a name go by their paths, since the name would not tell the reader which one it is.
 */
function workflowNames(plan: RunPlan): Map<string, string> {
  const roots = plan.workflows.filter((w) => w.depth === 0);
  const named = countOf(roots.flatMap((w) => (w.name === undefined ? [] : [w.name])));
  return new Map(
    roots.map((w) => [w.path, w.name !== undefined && named.get(w.name) === 1 ? w.name : w.path]),
  );
}

/** How many times each word occurs. */
function countOf(words: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

export const WORKFLOW: Record<Tri, string> = {
  yes: 'is now triggered',
  no: 'is no longer triggered',
  maybe: 'might now be triggered',
};
export const UNIT: Record<Tri, string> = { yes: 'now runs', no: 'is now skipped', maybe: 'now might run' };

/** How many changes the sentence names before it counts the rest. */
export const NAMED = 3;

/**
 * What the status line says of a pin: `pinned; deploy now runs`, `pinned; build.#3 now runs, deploy now runs and
 * preview is now skipped; 2 more changed`.
 */
export function pinSentence(changes: readonly VerdictChange[]): string {
  if (!changes.length) return 'pinned; no verdict changed';
  const named = changes
    .slice(0, NAMED)
    .map((c) => `${c.label} ${(c.kind === 'workflow' ? WORKFLOW : UNIT)[c.to]}`);
  const rest = changes.length - named.length;
  return `pinned; ${listed(named)}${rest > 0 ? `; ${rest} more changed` : ''}`;
}
