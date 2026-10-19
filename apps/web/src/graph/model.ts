import type {
  JobPlan,
  Json,
  LegPlan,
  NodeId,
  Result,
  RunPlan,
  StepPlan,
  Tri,
  Value,
  WorkflowPlan,
} from '@simulci/engine';
import { formatReason, formatValue } from '@simulci/engine/render';
import type { Derived } from '../worker/protocol';
import { shapeHash } from './shape';
import type { EdgeModel, GraphModel, GraphUi, JobModel, LegCell, ScopeModel, StepMark } from './types';

/**
 * The canvas's model of a plan: scopes, job cards and `needs` edges (synthesis § 6). One scope per workflow instance:
 * each depth-0 workflow in plan order, and the workflow each job's representative leg calls, nested in its card.
 * Legs are cells and steps marks inside the card, never nodes, so the node count stays bounded whatever the matrix.
 * Everything is keyed by the plan's semantic ids, so a job keeps its node across plans.
 */
export function graphModel(plan: RunPlan, derived: Derived, ui: GraphUi): GraphModel {
  const b: Build = {
    derived,
    ui,
    model: { roots: [], scopes: {}, jobs: {} },
    shapes: {},
    expanded: new Set(ui.expanded),
    opened: new Set(ui.opened),
  };
  for (const wf of plan.workflows) {
    if (wf.depth !== 0 || (ui.hideUntriggered && wf.triggered.verdict === 'no')) continue;
    b.model.roots.push(scopeOf(b, wf, undefined));
  }
  return b.model;
}

interface Build {
  derived: Derived;
  ui: GraphUi;
  model: GraphModel;
  /** Each finished scope's shape, for the shape of the scope that calls it. */
  shapes: Record<NodeId, string>;
  expanded: Set<NodeId>;
  opened: Set<NodeId>;
}

/**
 * A workflow instance and, unless it is collapsed, its jobs, their callees and its edges; returns its id. The records
 * list a scope before its jobs and a job before its callee, in plan order.
 */
function scopeOf(b: Build, wf: WorkflowPlan, caller: NodeId | undefined): NodeId {
  const collapsed = wf.depth === 0 ? wf.triggered.verdict === 'no' : wf.depth > 2 && !b.opened.has(wf.id);
  const scope: ScopeModel = compact({
    id: wf.id,
    path: wf.path,
    name: wf.name,
    verdict: wf.triggered.verdict,
    clause: b.derived.clauses[wf.id] ?? '',
    counts: countsOf(wf.jobs),
    depth: wf.depth,
    caller,
    collapsed,
    jobs: [],
    edges: [],
    shape: '',
  });
  b.model.scopes[wf.id] = scope;
  const jobs = collapsed ? [] : wf.jobs.map((job) => jobOf(b, job, wf.id));
  scope.jobs = jobs.map((j) => j.id);
  if (!collapsed) scope.edges = edgesOf(b.derived, wf);
  // Callees are built first, so their shapes are known here.
  scope.shape = shapeHash(scope, jobs, b.shapes);
  b.shapes[wf.id] = scope.shape;
  return wf.id;
}

function countsOf(jobs: readonly JobPlan[]): Record<Tri, number> {
  const counts: Record<Tri, number> = { yes: 0, no: 0, maybe: 0 };
  for (const job of jobs) counts[job.runs.verdict]++;
  return counts;
}

function jobOf(b: Build, job: JobPlan, scope: NodeId): JobModel {
  const rep = job.legs.find((leg) => leg.id === b.ui.representative[job.id]) ?? job.legs[0];
  const model: JobModel = compact({
    id: job.id,
    scope,
    jobId: job.jobId,
    ...wording(b.derived, job),
    needs: job.needs,
    legs: legCells(job),
    representative: rep?.id,
    steps: (rep?.steps ?? []).map(stepMark),
    expanded: b.expanded.has(job.id),
  });
  b.model.jobs[job.id] = model;
  if (rep?.call) model.callee = scopeOf(b, rep.call, job.id);
  return model;
}

/** What the card says about the job: its name, verdict, the clause unless it plainly runs, the badge, the subline. */
function wording(
  derived: Derived,
  job: JobPlan,
): Pick<JobModel, 'label' | 'verdict' | 'clause' | 'result' | 'uses' | 'check' | 'count'> {
  return {
    label: job.name ?? job.jobId,
    verdict: job.runs.verdict,
    clause: job.runs.verdict === 'yes' ? undefined : derived.clauses[job.id],
    result: resultLabel(job.result, job.runs.verdict),
    uses: job.uses,
    check: job.check.stem,
    count: job.matrix ? (job.matrix.count ?? '?') : undefined,
  };
}

/**
 * The badge: what the result adds to the verdict. A known result other than success, or the candidates of an unknown
 * one (`success | cancelled`); `skipped` is left out where the verdict word already says it.
 */
function resultLabel(result: Value<Result>, verdict: Tri): string | undefined {
  const values = result.known ? [result.value] : (result.oneOf ?? []);
  const told = verdict === 'yes' ? values : values.filter((v) => v !== 'skipped');
  return told.length === 0 || (told.length === 1 && told[0] === 'success') ? undefined : told.join(' | ');
}

/**
 * The grid: every leg of a job with a matrix that is not skipped; a single unnamed leg is the job itself. A matrix
 * only the run knows is one `∗` cell that carries the matrix reason.
 */
function legCells(job: JobPlan): LegCell[] | undefined {
  const grid = job.legs.length > 1 || (job.legs[0]?.legKey ?? '') !== '';
  if (!grid || job.runs.verdict === 'no') return undefined;
  return job.legs.map((leg) =>
    compact({
      id: leg.id,
      legKey: leg.legKey,
      label: legLabel(leg),
      verdict: leg.runs.verdict,
      result: resultLabel(leg.result, leg.runs.verdict),
      reason: matrixReason(leg),
    }),
  );
}

/** `node=22` for one matrix key, `22 · linux` for several, `∗` for a matrix only the run knows, else the check name. */
function legLabel(leg: LegPlan): string {
  if (leg.legKey === '*') return '∗';
  const values = Object.entries(leg.values);
  if (values.length === 1) return `${values[0]![0]}=${brief(values[0]![1])}`;
  if (values.length > 1) return values.map(([, v]) => brief(v)).join(' · ');
  return leg.check?.name ?? leg.legKey;
}

/** Why a leg stands for a matrix only the run knows, as the CLI words it. */
function matrixReason(leg: LegPlan): string | undefined {
  const reason = leg.runs.chain.find((r) => r.kind === 'matrix');
  return reason && formatReason(reason);
}

function stepMark(step: StepPlan): StepMark {
  const outputs = Object.entries(step.outputs);
  return compact({
    id: step.id,
    label: step.name ?? step.uses ?? step.stepId ?? step.key,
    verdict: step.runs.verdict,
    inner: (step.composite?.steps ?? []).map(stepMark),
    outputs: outputs.length ? outputs.map(([k, v]) => `${k}=${brief(v)}`).join(' ') : undefined,
  });
}

/** A value short enough for a cell or a row: `?` for an unknown one, whose unknowns the Reasons tab names. */
const brief = (v: Value<Json>): string => (v.known ? formatValue(v) : '?');

/** One edge per `needs` entry, in declaration order. */
function edgesOf(derived: Derived, wf: WorkflowPlan): EdgeModel[] {
  const byId = new Map(wf.jobs.map((job) => [job.id, job]));
  return wf.jobs.flatMap((target) => {
    const deciding = derived.decidingNeeds[target.id] ?? [];
    return target.needs.flatMap((need) => {
      const source = byId.get(need);
      return source ? [edgeOf(source, target, deciding.includes(need))] : [];
    });
  });
}

/** The edge from a needed job, labelled with the result that decided the target when it did (worker/deciding.ts). */
function edgeOf(source: JobPlan, target: JobPlan, deciding: boolean): EdgeModel {
  const edge: EdgeModel = {
    id: `${source.id}->${target.id}`,
    source: source.id,
    target: target.id,
    from: source.runs.verdict,
    deciding,
  };
  if (deciding) edge.label = `result: ${source.result.known ? source.result.value : '?'}`;
  return edge;
}

/** The object without its undefined keys: an optional field the plan does not have is absent, not `undefined`. */
function compact<T extends object>(o: T): T {
  for (const key of Object.keys(o) as (keyof T)[]) if (o[key] === undefined) delete o[key];
  return o;
}
