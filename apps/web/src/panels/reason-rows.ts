import type {
  Diagnostic,
  FilterKind,
  FilterReason,
  IfReason,
  Json,
  Loc,
  NodeId,
  ParentReason,
  Reason,
  Result,
  RunPlan,
  ScheduleReason,
  Tri,
  TypesReason,
  Value,
} from '@simulci/engine';
import { formatReason, formatValue, reasonGate } from '@simulci/engine/render';
import { type NodeKind, type PlanIndex, selectionOf } from '../plan/index';
import { declaredAt, decisionOf, type PlanNode, planNodes } from '../plan/nodes';
import type { PlanState, SessionStore } from '../state/store';
import type { Derived } from '../worker/protocol';
import { planLabels } from './outline-tree';

/**
 * The Reasons tab as data (synthesis § 7): the selected node's header and its chain of reasons in evaluation order,
 * one row per reason, the deciding one marked; then the diagnostics about the node. Every verdict, match and value is
 * the engine's: the rows word them and name the scenario field that would decide an open gate, nothing more.
 */

export interface ReasonsModel {
  header: ReasonsHeader;
  rows: ReasonRowModel[];
  /** The plan's diagnostics whose node is this one, in plan order. */
  diagnostics: Diagnostic[];
}

export interface ReasonsHeader {
  id: NodeId;
  kind: NodeKind;
  /** The node's label as the canvas words it. */
  label: string;
  verdict: Tri;
  /** The unit path the copy button copies; a workflow's file path, which names it in a test. */
  path: string;
  /**
   * What the result adds to the verdict, as the canvas badge says it: `failure`, `one of success, cancelled`; absent
   * for a known success and for `skipped` where the verdict word already says it.
   */
  result?: string;
  /** The deciding clause, worded as the CLI words it. */
  clause: string;
  /** Where the node is declared. */
  loc?: Loc;
}

/** A scenario field a Set … button asks the form to focus: the button's words and the field's path. */
export interface FieldRequest {
  label: string;
  path: string;
}

export interface ReasonRowModel {
  /** The reason's place in the chain, from 0. */
  index: number;
  /** What the reason's gate says (`reasonGate`): passed, failed or undecided. */
  gate: Value<boolean>;
  /** The reason that decided the verdict. */
  deciding: boolean;
  /** Where the deciding reason is written, on the deciding row when the plan or the outline knows. */
  loc?: Loc;
  body: RowBody;
}

export type RowBody = EventBody | TypesBody | FilterBody | ParentBody | IfBody | TextBody;

/** `on:` lists the event, or does not. */
export interface EventBody {
  kind: 'event';
  text: string;
  /** The events the workflow listens to. */
  on: string[];
}

/** The activity type against `types:`. */
export interface TypesBody {
  kind: 'types';
  text: string;
  allowed: string[];
  action?: string;
  set?: FieldRequest;
}

/** A branch, tag, path or workflow filter against the scenario's subject. */
export interface FilterBody {
  kind: 'filter';
  filter: FilterKind;
  /** The engine's `matched` in words: `matched`, `not matched`, `ignored`, `not ignored`, `undecided`. */
  text: string;
  patterns: string[];
  subject: Subject;
  set?: FieldRequest;
}

/** What a filter's patterns are matched against. */
export interface Subject {
  /** `ref`, `changed files` or `triggering workflow`. */
  label: string;
  /** The value as a line, or what the scenario does not say. */
  text?: string;
  /** The changed files, when the subject is the list of them. */
  files?: string[];
}

/** The node's parent decided first: its workflow, job, leg or step. */
export interface ParentBody {
  kind: 'parent';
  text: string;
  parent: NodeId;
  /** The parent's label, which the button that selects it shows. */
  label: string;
}

/** An `if:` as written and as evaluated, the status it read, its value and every context value it read. */
export interface IfBody {
  kind: 'if';
  /** As written; empty when the unit has none. */
  expr: string;
  /** As GitHub evaluates it, when that differs from what is written. */
  evaluated?: string;
  implicitSuccess: boolean;
  /** The job status the status functions read: `failure`, `one of success, cancelled`, `unknown`. */
  status: string;
  /** `true`, `false` or `unknown`. */
  value: string;
  /** The expression with the known parts folded, when something stays unknown. */
  residual?: string;
  reads: ReadRow[];
}

/** One value an `if:` read: the reference, the value, the unknowns it waits for and the node that produced it. */
export interface ReadRow {
  ref: string;
  value: string;
  unknowns: { id: string; label: string }[];
  from?: string;
}

/** One sentence: a schedule, the default branch, a skip marker, a limit, a matrix, a kind this version does not know. */
export interface TextBody {
  kind: 'text';
  text: string;
}

interface Context {
  node: PlanNode;
  index: PlanIndex;
  derived: Derived;
  labels: Map<NodeId, string>;
  /** Where the deciding reason is written. */
  decidingLoc?: Loc;
}

/**
 * The header and rows for a node of the plan: the focused workflow when nothing inside it is selected
 * (`resolveSelection`), so its trigger chain shows from the first paint. Undefined when no node is named or the plan
 * does not have it.
 */
export function reasonsModel(
  state: PlanState,
  index: PlanIndex,
  id: NodeId | undefined,
): ReasonsModel | undefined {
  const node = id === undefined ? undefined : planNodes(state.plan).get(id);
  if (id === undefined || !node) return undefined;
  const { derived } = state;
  // A composite action is decided with its step: the step's tables are its own.
  const decided = node.kind === 'composite' ? node.step.id : id;
  const ctx: Context = { node, index, derived, labels: labelsOf(state.plan) };
  const loc = derived.decidingLoc[decided];
  if (loc) ctx.decidingLoc = loc;
  const decision = decisionOf(node);
  const deciding = derived.decidingIndex[decided] ?? -1;
  return {
    header: headerOf(id, decided, decision.verdict, ctx),
    rows: decision.chain.map((reason, i) => rowOf(reason, i, i === deciding, ctx)),
    diagnostics: state.plan.diagnostics.filter((d) => d.node === id),
  };
}

const labelCache = new WeakMap<RunPlan, Map<NodeId, string>>();

/** The canvas's labels of a plan, built once per plan. */
function labelsOf(plan: RunPlan): Map<NodeId, string> {
  let labels = labelCache.get(plan);
  if (!labels) {
    labels = planLabels(plan);
    labelCache.set(plan, labels);
  }
  return labels;
}

function headerOf(id: NodeId, decided: NodeId, verdict: Tri, ctx: Context): ReasonsHeader {
  const { node, derived } = ctx;
  const header: ReasonsHeader = {
    id,
    kind: node.kind,
    label: ctx.labels.get(id) ?? (node.kind === 'composite' ? node.action.path : id),
    verdict,
    path:
      derived.unitPaths[id] ??
      derived.unitPaths[decided] ??
      (node.kind === 'workflow' ? node.workflow.path : id),
    clause: derived.clauses[decided] ?? '',
  };
  const result = resultWords(resultOf(node), verdict);
  if (result !== undefined) header.result = result;
  const loc = declaredAt(node);
  if (loc) header.loc = loc;
  return header;
}

/** A job's or leg's result as `needs` reads it, a step's conclusion; a workflow has none here. */
function resultOf(node: PlanNode): Value<Result> | undefined {
  if (node.kind === 'workflow') return undefined;
  if (node.kind === 'job') return node.job.result;
  if (node.kind === 'leg') return node.leg.result;
  return node.step.conclusion;
}

/** The canvas badge's rule (graph/model.ts): a known success says nothing, nor `skipped` beside a verdict that says it. */
function resultWords(result: Value<Result> | undefined, verdict: Tri): string | undefined {
  if (!result) return undefined;
  const values = result.known ? [result.value] : (result.oneOf ?? []);
  const told = verdict === 'yes' ? values : values.filter((v) => v !== 'skipped');
  if (told.length === 0 || (told.length === 1 && told[0] === 'success')) return undefined;
  return told.length === 1 ? told[0] : `one of ${told.join(', ')}`;
}

function rowOf(reason: Reason, index: number, deciding: boolean, ctx: Context): ReasonRowModel {
  const row: ReasonRowModel = { index, gate: reasonGate(reason), deciding, body: bodyOf(reason, ctx) };
  if (deciding && ctx.decidingLoc) row.loc = ctx.decidingLoc;
  return row;
}

function bodyOf(reason: Reason, ctx: Context): RowBody {
  if (reason.kind === 'event') {
    const text = reason.listens ? `Listens to ${reason.event}` : `Does not listen to ${reason.event}`;
    return { kind: 'event', text, on: ctx.node.workflow.on };
  }
  if (reason.kind === 'types') return typesBody(reason);
  if (reason.kind === 'filter') return filterBody(reason);
  if (reason.kind === 'parent') return parentBody(reason, ctx);
  if (reason.kind === 'if') return ifBody(reason, ctx);
  return { kind: 'text', text: sentence(reason) };
}

function typesBody(r: TypesReason): TypesBody {
  const body: TypesBody = { kind: 'types', text: typesText(r), allowed: r.allowed };
  if (r.action !== undefined) body.action = r.action;
  if (!r.matched.known) body.set = { label: 'Set the activity type', path: 'action' };
  return body;
}

function typesText(r: TypesReason): string {
  if (!r.matched.known) return 'No activity type given and types: is narrowed';
  if (r.action === undefined) return 'No activity type given: any of the default types triggers it';
  return r.matched.value ? `${r.action} is one of its types` : `${r.action} is not one of its types`;
}

const SUBJECT_LABEL: Record<FilterKind, string> = {
  branches: 'ref',
  'branches-ignore': 'ref',
  tags: 'ref',
  'tags-ignore': 'ref',
  paths: 'changed files',
  'paths-ignore': 'changed files',
  workflows: 'triggering workflow',
};

const CHANGED: FieldRequest = { label: 'Set changed files', path: 'changed' };
const FILTER_FIELD: Partial<Record<FilterKind, FieldRequest>> = {
  paths: CHANGED,
  'paths-ignore': CHANGED,
  workflows: { label: 'Set the triggering workflow', path: 'workflow_run' },
};
const RUN_BRANCH: FieldRequest = { label: "Set the triggering run's branch", path: 'workflow_run.branch' };
/** The unknown a `workflow_run` branch filter waits for when the scenario names no branch. */
const RUN_BRANCH_UNKNOWN = 'scenario.workflow_run.branch';

function filterBody(r: FilterReason): FilterBody {
  const body: FilterBody = {
    kind: 'filter',
    filter: r.filter,
    text: filterOutcome(r),
    patterns: r.patterns,
    subject: subjectOf(r),
  };
  const set = filterField(r);
  if (set) body.set = set;
  return body;
}

/** `matched` is the engine's: whether the filter lets the run through, which an `-ignore` filter words the other way. */
function filterOutcome(r: FilterReason): string {
  if (!r.matched.known) return 'undecided';
  const ignore = r.filter.endsWith('-ignore');
  if (r.matched.value) return ignore ? 'not ignored' : 'matched';
  return ignore ? 'ignored' : 'not matched';
}

function subjectOf(r: FilterReason): Subject {
  const label = SUBJECT_LABEL[r.filter] ?? 'subject';
  const { subject } = r;
  if (!subject.known) return { label, text: missingSubject(r) };
  if (Array.isArray(subject.value)) return { label, files: subject.value };
  return { label, text: formatValue(subject) };
}

function missingSubject(r: FilterReason): string {
  if (waitsForRunBranch(r)) return 'no branch given for the triggering run';
  if (r.filter === 'paths' || r.filter === 'paths-ignore') return 'no changed files given';
  if (r.filter === 'workflows') return 'no triggering workflow given';
  return formatValue(r.subject);
}

const waitsForRunBranch = (r: FilterReason): boolean =>
  r.filter.startsWith('branches') && !r.subject.known && r.subject.unknowns.includes(RUN_BRANCH_UNKNOWN);

/** The field that decides an open filter: the changed files, the triggering workflow, the branch it ran on. */
function filterField(r: FilterReason): FieldRequest | undefined {
  if (r.matched.known) return undefined;
  return waitsForRunBranch(r) ? RUN_BRANCH : FILTER_FIELD[r.filter];
}

const PARENT_NOUN: Record<NodeKind, string> = {
  workflow: 'workflow',
  job: 'job',
  leg: 'leg',
  step: 'step',
  composite: 'action',
};
const TRIGGERED: Record<Tri, string> = {
  yes: 'is triggered',
  no: 'is not triggered',
  maybe: 'might not be triggered',
};
const RUNS: Record<Tri, string> = { yes: 'runs', no: 'is skipped', maybe: 'might not run' };

/** "Its workflow is not triggered", "Its job is skipped", "The calling job might not run" for a called workflow. */
function parentBody(r: ParentReason, ctx: Context): ParentBody {
  const kind = ctx.index.nodes.get(r.node)?.kind ?? ctx.derived.kinds[r.node] ?? 'job';
  const noun = PARENT_NOUN[kind];
  const subject = ctx.node.kind === 'workflow' ? `The calling ${noun}` : `Its ${noun}`;
  const verb = kind === 'workflow' ? TRIGGERED[r.verdict] : RUNS[r.verdict];
  return {
    kind: 'parent',
    text: `${subject} ${verb}`,
    parent: r.node,
    label: ctx.labels.get(r.node) ?? ctx.derived.unitPaths[r.node] ?? r.node,
  };
}

function ifBody(r: IfReason, ctx: Context): IfBody {
  const body: IfBody = {
    kind: 'if',
    expr: r.expr,
    implicitSuccess: r.implicitSuccess,
    status: statusWords(r.status),
    value: r.value.known ? String(r.value.value) : 'unknown',
    reads: (r.reads ?? []).map((read) => readRow(read, ctx)),
  };
  if (r.evaluated !== r.expr.trim()) body.evaluated = r.evaluated;
  if (r.residual !== undefined) body.residual = r.residual;
  return body;
}

function statusWords(status: Value<Result>): string {
  if (status.known) return status.value;
  return status.oneOf?.length ? `one of ${status.oneOf.join(', ')}` : 'unknown';
}

function readRow(read: IfReason['reads'][number], ctx: Context): ReadRow {
  const { value } = read;
  const row: ReadRow = {
    ref: read.ref,
    value: readValue(value),
    unknowns: value.known
      ? []
      : value.unknowns.map((id) => ({ id, label: ctx.derived.unknownPaths[id] ?? id })),
  };
  if (read.from !== undefined) row.from = ctx.labels.get(read.from) ?? read.from;
  return row;
}

/** `formatValue`'s words for a known value, the empty string shown as `''`; `?` and the candidates for an unknown. */
function readValue(value: Value<Json>): string {
  if (value.known) return value.value === '' ? "''" : formatValue(value);
  const candidates = value.oneOf?.map((c) => JSON.stringify(c)).join(', ');
  return candidates ? `? one of ${candidates}` : '?';
}

function sentence(reason: Reason): string {
  if (reason.kind === 'schedule') return scheduleText(reason);
  if (reason.kind === 'default-branch')
    return reason.matched ? 'The ref is the default branch' : 'The ref is not the default branch';
  if (reason.kind === 'skip-ci') return `The commit message carries ${reason.marker}, which skips the run`;
  if (reason.kind === 'limit') return `GitHub's ${reason.limit} limit stops it here`;
  if (reason.kind === 'matrix') return 'The matrix is only known at run time';
  // A kind this version does not know: the engine's own clause, which names it.
  return formatReason(reason);
}

function scheduleText(r: ScheduleReason): string {
  const crons = r.crons.join(', ');
  if (r.cron === undefined) return `No cron given: any of its schedules triggers it (${crons})`;
  return r.matched ? `${r.cron} is one of its schedules` : `${r.cron} is not one of its schedules (${crons})`;
}

/** Selects a node the way the canvas and the tree do: through the focus and unit path that name it. */
export function selectNode(store: SessionStore, index: PlanIndex, id: NodeId): void {
  const { focus, sel } = selectionOf(index, id);
  store.getState().select(focus, sel);
}

/** Asks the form to focus a scenario field, opening the scenario column first when the author closed it. */
export function requestField(store: SessionStore, path: string): void {
  const state = store.getState();
  if (state.ui.prefs.collapsed.left) state.togglePane('left');
  store.getState().focusField({ path });
}
