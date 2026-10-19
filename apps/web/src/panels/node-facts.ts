import type {
  ActionPlan,
  Json,
  JobPlan,
  LegPlan,
  MatrixPlan,
  MockRef,
  NodeId,
  StepPlan,
  Tri,
  Value,
  WorkflowPlan,
} from '@simulci/engine';
import type { CheckVerdict } from '@simulci/engine/plan';
import { formatValue } from '@simulci/engine/render';
import type { NodeKind, PlanIndex } from '../plan/index';
import { type PlanNode, planNodes } from '../plan/nodes';
import type { PlanState } from '../state/store';

/**
 * The Node tab's model (synthesis § 7's Effects, in full): what the plan says of a node besides its reasons, as
 * titled sections of label and value facts. A workflow's path, events, conclusion, inputs and outputs; a job's needs,
 * result, outputs, check names and matrix; a leg's values, runner and environment; a step's outcome, `with`, `env` and
 * outputs; a composite action's inputs and outputs; then the predicted checks the node reports. Empty sections are
 * left out.
 */

/** A node a fact names, which a click selects. */
export interface NodeRef {
  id: NodeId;
  /** Its unit path, else its id. */
  label: string;
}

/** A plan value in words, and the mock that made it known (`assume[0]`, `model:actions/cache`). */
export interface ValueFact {
  kind: 'value';
  text: string;
  known: boolean;
  by?: MockRef;
}

/** What a fact says: words, a plan value, nodes to select, or a predicted check with its verdict and result. */
export type FactValue =
  | { kind: 'text'; text: string }
  | ValueFact
  | { kind: 'nodes'; nodes: NodeRef[] }
  | { kind: 'check'; verdict: Tri; result: ValueFact; node: NodeId };

/** One line of a section: a label and what the plan says of it. */
export interface Fact {
  label: string;
  value: FactValue;
  /** A qualification shown after the value (`as needs.build.result reads it`). */
  note?: string;
}

/** A titled group of facts: the node itself, its matrix, a record of values, its checks. */
export interface FactSection {
  title: string;
  facts: Fact[];
}

/** What the tab's heading shows of a node. */
export interface NodeHeading {
  kind: NodeKind;
  verdict: Tri;
  /** The node's name in the plan: a workflow's or job's name, a leg key, a step's name, `uses` or key. */
  name: string;
  /** Its unit path; a workflow's path for a workflow. */
  path: string;
}

/** The words a check name gets when the run alone knows it exactly. */
const UNCERTAIN = 'only the run knows the exact name';

type Maybe<T> = T | undefined | false;
type Sections = Maybe<FactSection>[];

/** What the facts are worded against: the unknowns' and nodes' unit paths. */
interface Ctx {
  unitPaths: Record<NodeId, string>;
  unknownPaths: Record<string, string>;
}

/** The facts of a node, section by section; none for an id the plan does not have. */
export function nodeFacts(plan: PlanState, index: PlanIndex, node: NodeId): FactSection[] {
  const found = planNodes(plan.plan).get(node);
  if (!found) return [];
  const ctx: Ctx = { unitPaths: plan.derived.unitPaths, unknownPaths: plan.derived.unknownPaths };
  return [...factsOf(found, ctx), checksSection(index, node, ctx)].filter((s): s is FactSection => !!s);
}

/** The heading of a node; undefined for an id the plan does not have. */
export function nodeHeading(plan: PlanState, index: PlanIndex, node: NodeId): NodeHeading | undefined {
  const found = planNodes(plan.plan).get(node);
  const indexed = index.nodes.get(node);
  if (!found || !indexed) return undefined;
  const path = indexed.unitPath ?? (found.kind === 'workflow' ? found.workflow.path : node);
  return { kind: indexed.kind, verdict: indexed.verdict, name: nameOf(found), path };
}

function nameOf(n: PlanNode): string {
  if (n.kind === 'workflow') return n.workflow.name ?? n.workflow.path;
  if (n.kind === 'job') return n.job.name ?? n.job.jobId;
  if (n.kind === 'leg') return n.leg.legKey;
  if (n.kind === 'step') return stepName(n.step);
  return n.action.path;
}

const stepName = (step: StepPlan): string => step.name ?? step.uses ?? step.stepId ?? step.key;

function factsOf(n: PlanNode, ctx: Ctx): Sections {
  if (n.kind === 'workflow') return workflowFacts(n.workflow, ctx);
  if (n.kind === 'job') return jobFacts(n.job, ctx);
  if (n.kind === 'leg') return legFacts(n.leg, ctx);
  if (n.kind === 'step') return stepFacts(n.step, ctx);
  return actionFacts(n.action, ctx);
}

function workflowFacts(wf: WorkflowPlan, ctx: Ctx): Sections {
  const concurrency = wf.concurrency;
  return [
    section('Workflow', [
      say('path', wf.path),
      say('name', wf.name),
      say('listens to', wf.on.join(', ')),
      val('conclusion', wf.conclusion, ctx),
      wf.caller !== undefined && nodes('called by', [wf.caller], ctx),
      say('concurrency group', concurrency?.group),
      concurrency?.cancelInProgress && val('cancel in progress', concurrency.cancelInProgress, ctx),
    ]),
    values('Inputs', wf.inputs, ctx),
    values('Outputs', wf.outputs, ctx),
  ];
}

/** A job without a matrix stands for its one bare leg, so the leg's runner, environment and env are the job's. */
function jobFacts(job: JobPlan, ctx: Ctx): Sections {
  const bare = job.legs.find((leg) => leg.id === job.id);
  return [
    section('Job', [...jobHead(job, ctx), ...runner(bare, ctx)]),
    job.matrix && matrixSection(job.matrix, job.legs.length, ctx),
    values('With', job.with, ctx),
    values('Secrets', job.secrets, ctx),
    values('Env', bare?.env, ctx),
    values('Outputs', job.outputs, ctx),
  ];
}

function jobHead(job: JobPlan, ctx: Ctx): Maybe<Fact>[] {
  return [
    say('job id', job.jobId),
    say('name', job.name),
    nodes('needs', job.needs, ctx),
    say('uses', job.uses),
    val('result', job.result, ctx, `as needs.${job.jobId}.result reads it`),
    val('continue-on-error', job.continueOnError, ctx),
    say('check', job.check.stem, job.check.certain ? undefined : UNCERTAIN),
    say('check when skipped', job.check.skippedName),
  ];
}

function matrixSection(m: MatrixPlan, legs: number, ctx: Ctx): Maybe<FactSection> {
  return section('Matrix', [
    say('keys', m.keys.join(', ')),
    say('count', m.count === undefined ? 'only the run knows' : String(m.count)),
    say('legs planned', String(legs)),
    say('exact', yesNo(m.exact)),
    say('dynamic', yesNo(m.dynamic)),
    m.truncated && say('truncated', 'yes'),
    val('fail-fast', m.failFast, ctx),
    m.maxParallel && val('max-parallel', m.maxParallel, ctx),
  ]);
}

/** A leg's check is listed under Checks, with its verdict and result. */
function legFacts(leg: LegPlan, ctx: Ctx): Sections {
  return [
    section('Leg', [say('leg', leg.legKey), val('result', leg.result, ctx), ...runner(leg, ctx)]),
    values('Matrix values', leg.values, ctx),
    values('Env', leg.env, ctx),
    values('Outputs', leg.outputs, ctx),
  ];
}

function runner(leg: LegPlan | undefined, ctx: Ctx): Maybe<Fact>[] {
  if (!leg) return [];
  return [
    leg.runsOn && val('runs-on', leg.runsOn, ctx),
    leg.environment && val('environment', leg.environment, ctx),
  ];
}

/** A step that uses a composite action shows the action too: the canvas selects the step, never the action. */
function stepFacts(step: StepPlan, ctx: Ctx): Sections {
  return [
    section('Step', stepHead(step, ctx)),
    values('With', step.with, ctx),
    values('Env', step.env, ctx),
    values('Outputs', step.outputs, ctx),
    ...(step.composite ? actionFacts(step.composite, ctx) : []),
  ];
}

function stepHead(step: StepPlan, ctx: Ctx): Maybe<Fact>[] {
  return [
    say('key', step.key),
    say('step id', step.stepId),
    say('name', step.name),
    step.uses === undefined ? step.run === true && say('run', 'a script') : say('uses', step.uses),
    val('outcome', step.outcome, ctx),
    !sameValue(step.conclusion, step.outcome) && val('conclusion', step.conclusion, ctx),
    val('continue-on-error', step.continueOnError, ctx),
  ];
}

function actionFacts(action: ActionPlan, ctx: Ctx): Sections {
  return [
    section('Action', [say('path', action.path)]),
    values('Action inputs', action.inputs, ctx),
    values('Action outputs', action.outputs, ctx),
  ];
}

/** The checks the node reports: its own, its legs', and those of the workflow it calls. */
function checksSection(index: PlanIndex, node: NodeId, ctx: Ctx): Maybe<FactSection> {
  const facts = index.checks.filter((c) => within(index, c.node, node)).map((c) => checkFact(c, ctx));
  return section('Checks', facts);
}

function within(index: PlanIndex, id: NodeId, ancestor: NodeId): boolean {
  for (let at: NodeId | undefined = id; at !== undefined; at = index.nodes.get(at)?.parent)
    if (at === ancestor) return true;
  return false;
}

function checkFact(c: CheckVerdict, ctx: Ctx): Fact {
  const fact: Fact = {
    label: c.name,
    value: { kind: 'check', verdict: c.runs, result: valueOf(c.result, ctx), node: c.node },
  };
  if (!c.certain) fact.note = UNCERTAIN;
  return fact;
}

/**
 * A plan value as the tab shows it: `formatValue`'s words, with an empty string written `''`, a list of strings
 * joined, and an unknown's candidates and the unknowns it waits on in unit-path form.
 */
function valueOf(v: Value<Json>, ctx: Pick<Ctx, 'unknownPaths'>): ValueFact {
  if (!v.known) return { kind: 'value', text: unknownText(v, ctx), known: false };
  const fact: ValueFact = { kind: 'value', text: knownText(v.value), known: true };
  if (v.by !== undefined) fact.by = v.by;
  return fact;
}

function knownText(value: Json): string {
  if (value === '') return "''";
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) return value.join(', ');
  return formatValue({ known: true, value });
}

function unknownText(v: Extract<Value<Json>, { known: false }>, ctx: Pick<Ctx, 'unknownPaths'>): string {
  const candidates = v.oneOf ? ` one of ${v.oneOf.map(knownText).join(', ')}` : '';
  const because = v.unknowns.length ? ` (${v.unknowns.map((u) => ctx.unknownPaths[u] ?? u).join(', ')})` : '';
  return `?${candidates}${because}`;
}

function sameValue(a: Value<Json>, b: Value<Json>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

function section(title: string, facts: Maybe<Fact>[]): Maybe<FactSection> {
  const kept = facts.filter((f): f is Fact => !!f);
  return kept.length > 0 && { title, facts: kept };
}

/** Words, when there are any. */
function say(label: string, text: string | undefined, note?: string): Maybe<Fact> {
  if (text === undefined || text === '') return undefined;
  const fact: Fact = { label, value: { kind: 'text', text } };
  if (note !== undefined) fact.note = note;
  return fact;
}

function val(label: string, v: Value<Json>, ctx: Ctx, note?: string): Fact {
  const fact: Fact = { label, value: valueOf(v, ctx) };
  if (note !== undefined) fact.note = note;
  return fact;
}

function nodes(label: string, ids: NodeId[], ctx: Ctx): Maybe<Fact> {
  if (ids.length === 0) return undefined;
  return {
    label,
    value: { kind: 'nodes', nodes: ids.map((id) => ({ id, label: ctx.unitPaths[id] ?? id })) },
  };
}

/** One fact per key of a record of values, in the plan's order. */
function values(
  title: string,
  record: Record<string, Value<Json>> | undefined,
  ctx: Ctx,
): Maybe<FactSection> {
  return section(
    title,
    Object.entries(record ?? {}).map(([key, v]) => ({ label: key, value: valueOf(v, ctx) })),
  );
}
