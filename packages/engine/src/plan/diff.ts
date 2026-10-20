import { type CheckVerdict, checksOf } from './checks';
import type { JobPlan, LegPlan, NodeId, RunPlan, StepPlan, Tri, WorkflowPlan } from './types';

/**
 * What an edit changed (synthesis § 7.4): two plans of one scenario, nodes matched by id, the nodes one plan has and
 * the other lacks, the verdicts that differ, and the check names. Nothing is matched by likeness: a job whose id
 * changed is one removed and one added, unless the caller says it was renamed.
 *
 * A job's bare leg (no matrix) shares the job's id and is a node of its own, so a job that gains a matrix reads as its
 * one leg removed and the new legs added, not as every step it had. A composite action is not a node: its steps hang
 * off the step that uses it. Legs never appear among the verdict changes, as in the app's `verdictChanges`: a leg's
 * verdict is its job's (or `maybe` for an unknown matrix), and what changed under a leg is listed as if it were not
 * there. What does not run is planned as a shell, so a node that runs in one plan only hides what is under it from
 * the added and removed nodes: a job that is now skipped is one verdict change, not its steps removed.
 */

export type DiffKind = 'workflow' | 'job' | 'leg' | 'step';

export interface DiffNode {
  id: NodeId;
  kind: DiffKind;
  verdict: Tri;
}

export interface VerdictDiff {
  id: NodeId;
  kind: DiffKind;
  from: Tri;
  to: Tri;
}

export interface CheckDiff {
  name: string;
  from: Tri;
  to: Tri;
}

export interface PlanDiff {
  /** Nodes of `after` that `before` lacks, in plan order, outermost only: an added job stands for its legs and steps. */
  added: DiffNode[];
  /** Nodes of `before` that `after` lacks, in `before`'s order and by `before`'s ids, outermost only. */
  removed: DiffNode[];
  /** Nodes of both whose verdict differs, in `after`'s order and by its ids, under no changed or added ancestor. */
  changed: VerdictDiff[];
  /**
   * Check names by `checksOf`, in plan order. A name `before` reports twice and `after` once is removed once: the
   * k-th check of a name is matched with the k-th of that name.
   */
  checks: { added: string[]; removed: string[]; changed: CheckDiff[] };
}

export interface DiffOptions {
  /**
   * Old id prefixes and their new ids (`ci.yml#build` → `ci.yml#compile` renames the job, its legs and its steps). A
   * prefix renames an id it equals or that goes on past it with `#`, `[`, `/` or `>`; the longest prefix wins.
   */
  renames?: Readonly<Record<NodeId, NodeId>>;
}

/** A node of one plan; `key` is its kind and its id in `after`'s terms, since a bare leg shares its job's id. */
interface Entry {
  id: NodeId;
  kind: DiffKind;
  verdict: Tri;
  key: string;
  parent?: Entry;
}

/** The two plans of one scenario compared (synthesis § 7.4). */
export function diffPlans(before: RunPlan, after: RunPlan, opts: DiffOptions = {}): PlanDiff {
  const was = nodesOf(before, renamer(opts.renames ?? {}));
  const now = nodesOf(after, (id) => id);
  const wasByKey = byKey(was);
  const nowByKey = byKey(now);
  const unplanned = crossings(now, wasByKey);
  return {
    added: outermost(now, wasByKey, unplanned),
    removed: outermost(was, nowByKey, unplanned),
    changed: verdictDiffs(now, wasByKey),
    checks: diffChecks(checksOf(before), checksOf(after)),
  };
}

const byKey = (nodes: readonly Entry[]) => new Map(nodes.map((n) => [n.key, n]));

/**
 * The nodes that run in one plan and not in the other. The planner plans nothing under a node that does not run (an
 * untriggered workflow has no jobs, a skipped job one bare leg without steps), so what is under one of these was not
 * added or removed: the node's verdict change says it.
 */
function crossings(now: readonly Entry[], wasByKey: ReadonlyMap<string, Entry>): Set<string> {
  const keys = new Set<string>();
  for (const n of now) {
    const old = wasByKey.get(n.key);
    if (old && (old.verdict === 'no') !== (n.verdict === 'no')) keys.add(n.key);
  }
  return keys;
}

/** The nodes `other` lacks whose parent it has, under no node that runs in one plan only. */
function outermost(
  nodes: readonly Entry[],
  other: ReadonlyMap<string, Entry>,
  unplanned: ReadonlySet<string>,
): DiffNode[] {
  return nodes
    .filter((n) => !other.has(n.key) && (!n.parent || other.has(n.parent.key)))
    .filter((n) => !under(n, (at) => unplanned.has(at.key)))
    .map(({ id, kind, verdict }) => ({ id, kind, verdict }));
}

/** The verdict changes of `now`, each under no changed or added ancestor; a leg is never one. */
function verdictDiffs(now: readonly Entry[], wasByKey: ReadonlyMap<string, Entry>): VerdictDiff[] {
  const quiet = new Set<Entry>();
  const out: VerdictDiff[] = [];
  for (const n of now) {
    const old = wasByKey.get(n.key);
    if (!old) quiet.add(n);
    if (!old || old.verdict === n.verdict || n.kind === 'leg') continue;
    quiet.add(n);
    if (!under(n, (at) => quiet.has(at)))
      out.push({ id: n.id, kind: n.kind, from: old.verdict, to: n.verdict });
  }
  return out;
}

/** Whether an ancestor of the node is one. */
function under(node: Entry, is: (ancestor: Entry) => boolean): boolean {
  for (let at = node.parent; at; at = at.parent) if (is(at)) return true;
  return false;
}

/** Where an id goes on past a prefix: a job, a leg, a step, a called workflow or a composite action. */
const BOUNDARY = new Set(['#', '[', '/', '>']);

/** An id of `before` in `after`'s terms. */
function renamer(renames: Readonly<Record<NodeId, NodeId>>): (id: NodeId) => NodeId {
  const prefixes = Object.keys(renames).sort((a, b) => b.length - a.length);
  if (!prefixes.length) return (id) => id;
  return (id) => {
    const from = prefixes.find(
      (p) => id.startsWith(p) && (id.length === p.length || BOUNDARY.has(id[p.length]!)),
    );
    return from === undefined ? id : renames[from]! + id.slice(from.length);
  };
}

/** One plan being walked in pre-order. */
interface Walk {
  nodes: Entry[];
  rename: (id: NodeId) => NodeId;
}

/** Every node of the plan in pre-order: a workflow, its jobs, each job's legs, each leg's steps and callee. */
function nodesOf(plan: RunPlan, rename: (id: NodeId) => NodeId): Entry[] {
  const w: Walk = { nodes: [], rename };
  for (const wf of plan.workflows) addWorkflow(w, wf, undefined);
  return w.nodes;
}

function add(w: Walk, id: NodeId, kind: DiffKind, verdict: Tri, parent: Entry | undefined): Entry {
  const node: Entry = { id, kind, verdict, key: `${kind} ${w.rename(id)}` };
  if (parent) node.parent = parent;
  w.nodes.push(node);
  return node;
}

function addWorkflow(w: Walk, wf: WorkflowPlan, parent: Entry | undefined): void {
  const node = add(w, wf.id, 'workflow', wf.triggered.verdict, parent);
  for (const job of wf.jobs) addJob(w, job, node);
}

function addJob(w: Walk, job: JobPlan, parent: Entry): void {
  const node = add(w, job.id, 'job', job.runs.verdict, parent);
  for (const leg of job.legs) addLeg(w, leg, node);
}

function addLeg(w: Walk, leg: LegPlan, parent: Entry): void {
  const node = add(w, leg.id, 'leg', leg.runs.verdict, parent);
  if (leg.call) addWorkflow(w, leg.call, node);
  for (const step of leg.steps ?? []) addStep(w, step, node);
}

function addStep(w: Walk, step: StepPlan, parent: Entry): void {
  const node = add(w, step.id, 'step', step.runs.verdict, parent);
  for (const inner of step.composite?.steps ?? []) addStep(w, inner, node);
}

/** The checks by name, in plan order, the k-th of a name against the k-th of that name. */
function diffChecks(before: readonly CheckVerdict[], after: readonly CheckVerdict[]): PlanDiff['checks'] {
  const was = byName(before);
  const now = byName(after);
  const added: string[] = [];
  const changed: CheckDiff[] = [];
  ordinals(after).forEach((k, i) => {
    const { name, runs } = after[i]!;
    const from = was.get(name)?.[k]?.runs;
    if (from === undefined) added.push(name);
    else if (from !== runs) changed.push({ name, from, to: runs });
  });
  const kept = ordinals(before);
  const removed = before.filter((c, i) => kept[i]! >= (now.get(c.name)?.length ?? 0)).map((c) => c.name);
  return { added, removed, changed };
}

/** The checks of each name, in plan order. */
function byName(checks: readonly CheckVerdict[]): Map<string, CheckVerdict[]> {
  const out = new Map<string, CheckVerdict[]>();
  for (const c of checks) {
    const list = out.get(c.name);
    if (list) list.push(c);
    else out.set(c.name, [c]);
  }
  return out;
}

/** Each check's place among the checks of its name: 0 for the first `build`, 1 for the second. */
function ordinals(checks: readonly CheckVerdict[]): number[] {
  const seen = new Map<string, number>();
  return checks.map(({ name }) => {
    const k = seen.get(name) ?? 0;
    seen.set(name, k + 1);
    return k;
  });
}
