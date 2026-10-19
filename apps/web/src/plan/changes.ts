import type { NodeId, RunPlan, Tri } from '@simulci/engine';
import { listed } from '../lib/words';
import type { Derived } from '../worker/protocol';
import { type IndexedNode, type NodeKind, planIndex } from './index';

/**
 * What a pin changed (synthesis § 7 and § 11): the verdicts that differ between the plan before the pin and the plan
 * that answers it, for the status line's sentence ("pinned; deploy now runs") and the cards that flash. A unit whose
 * parent changed too is left out, so a workflow that is now triggered is one change and not one per job; a leg
 * stands for nothing its job does not already say.
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

interface Planned {
  plan: RunPlan;
  derived: Derived;
}

/** A changed node of `after` and the verdict it had before. */
interface Changed {
  node: IndexedNode;
  from: Tri;
}

/** The changed units of `after`, in plan order, each under no changed ancestor. */
export function verdictChanges(before: Planned, after: Planned): VerdictChange[] {
  const was = planIndex(before).nodes;
  const now = planIndex(after).nodes;
  const changed = new Set<NodeId>();
  const found: Changed[] = [];
  for (const node of now.values()) {
    const old = was.get(node.id);
    // A leg says what its job or its steps say: it is never listed, and what changed under it still is.
    if (!old || old.verdict === node.verdict || node.kind === 'leg') continue;
    changed.add(node.id);
    if (!underChanged(node, now, changed)) found.push({ node, from: old.verdict });
  }
  const labels = labelsOf(found, after.plan);
  return found.map(({ node, from }, i) => ({
    id: node.id,
    kind: node.kind,
    from,
    to: node.verdict,
    label: labels[i]!,
  }));
}

/** Whether a changed ancestor already says it. */
function underChanged(node: IndexedNode, nodes: Map<NodeId, IndexedNode>, changed: Set<NodeId>): boolean {
  for (let at = node.parent; at !== undefined; at = nodes.get(at)?.parent) if (changed.has(at)) return true;
  return false;
}

/**
 * The changes' labels, in their order. A unit's path says nothing of its workflow, so the same path changing in two
 * workflows would read twice alike: a label that repeats among the changes names the unit's depth-0 workflow
 * (`deploy in CI`), and a workflow's own label that repeats gives way to its path. A label that does not repeat
 * stays as short as it is (`deploy`), even when another workflow has a unit of that path.
 */
function labelsOf(found: readonly Changed[], plan: RunPlan): string[] {
  const plain = found.map(({ node }) => labelOf(node, plan));
  const counts = countOf(plain);
  const names = workflowNames(plan);
  return found.map(({ node }, i) => {
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

const WORKFLOW: Record<Tri, string> = {
  yes: 'is now triggered',
  no: 'is no longer triggered',
  maybe: 'might now be triggered',
};
const UNIT: Record<Tri, string> = { yes: 'now runs', no: 'is now skipped', maybe: 'now might run' };

/** How many changes the sentence names before it counts the rest. */
const NAMED = 3;

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
