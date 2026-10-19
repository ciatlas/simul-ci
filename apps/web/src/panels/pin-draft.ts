import type {
  AssumeEntry,
  JobPlan,
  LegPlan,
  MockValue,
  NodeId,
  RunPlan,
  StepPlan,
  Unknown,
  Value,
  WorkflowPlan,
} from '@simulci/engine';
import { stringOf } from '@simulci/engine/plan';
import { type PlanNode, planNodes } from '../plan/nodes';
import type { Derived, ModelInfo } from '../worker/protocol';

/**
 * The PinEditor's model (synthesis § 7): an assume entry for a step or job unknown, derived from the unknown's id
 * grammar (`<node>.outputs.<name>`, `<node>.outcome`, `<node>.env.<NAME>`) and `derived.kinds`, never from a string
 * heuristic, with what the plan knows to offer beside it. When the engine later emits pins for these unknowns, the UI
 * prefers `pin.fragment` and this derivation becomes the fallback.
 */

/** What a pin is decided against: the plan, its derived tables, and the models the worker ships. */
export interface PinContext {
  plan: RunPlan;
  derived: Derived;
  models: ModelInfo[];
}

export type Outcome = 'success' | 'failure' | 'cancelled';

/** The part of the entry the unknown is about, which the editor puts first. */
export type DraftAbout = { field: 'outputs' | 'env'; name: string } | { field: 'outcome' };

export interface PinDraft {
  /**
   * The entry as it would be written: `step:` or `job:` by unit path (`build.detect`, `caller/job.step`), the leg of
   * the path's last segment as `matrix:` values (`test.detect` with `node: lts/*`), `workflow:` (the file the unit is
   * declared in) only when another depth-0 workflow has a job of the same id as the unit's first job, and the field
   * the unknown is about prefilled (an output or env value `''`, the outcome `failure`).
   */
  entry: AssumeEntry;
  about: DraftAbout;
  /** The outcomes the unit can be given: success and failure for a step, cancelled too for a job (SC104). */
  outcomes: Outcome[];
  /** Finite candidates for the output, from the producer's `outputs[name]` when it is unknown with a `oneOf`. */
  candidates: string[];
  /** The model the producing step's `uses` matches (`actions/cache`), whose presets write `as:` instead. */
  model?: { id: string; presets: string[] };
}

/** The unit an entry names: a step, or a job (a leg, or the job that calls a workflow, is a job unit). */
interface Unit {
  id: NodeId;
  kind: 'step' | 'job';
}

const STEP_OUTCOMES: Outcome[] = ['success', 'failure'];
const JOB_OUTCOMES: Outcome[] = ['success', 'failure', 'cancelled'];

/**
 * The draft for a step or job unknown; undefined when the id names no step, leg or job of the plan, or a unit under a
 * leg whose values its path cannot hold.
 */
export function draftFor(unknown: Unknown, ctx: PinContext): PinDraft | undefined {
  const ref = parseUnknownId(unknown.id, ctx.derived.kinds);
  if (!ref) return undefined;
  const nodes = planNodes(ctx.plan);
  const unit = unitOf(ref.node, ctx.derived.kinds[ref.node], nodes);
  if (!unit || (ref.about.field === 'env' && unit.kind === 'job')) return undefined;
  const named = unitNamed({ nodes, paths: ctx.derived.unitPaths }, unit.id);
  if (!named) return undefined;
  const entry: AssumeEntry = {};
  const workflow = qualifier(nodes, unit.id, ctx.plan);
  if (workflow !== undefined) entry.workflow = workflow;
  entry[unit.kind] = named.path;
  if (named.matrix) entry.matrix = named.matrix;
  if (ref.about.field === 'outcome') entry.outcome = 'failure';
  else entry[ref.about.field] = { [ref.about.name]: '' };
  const producer = nodes.get(ref.node);
  return offers(entry, ref.about, unit.kind, producer, ctx.models);
}

/** A unit as an entry names it: the unit path, and the values of the leg its last segment selects. */
interface Named {
  path: string;
  matrix?: Record<string, string>;
}

/** What a unit's name is read from: the plan's nodes and their unit paths (`derived.unitPaths`). */
interface Units {
  nodes: Map<NodeId, PlanNode>;
  paths: Record<NodeId, string>;
}

/**
 * The path and `matrix:` values an entry names a unit by. The leg of the path's last segment goes in `matrix:`,
 * each value as the engine compares it (`lts/*`, an object as its JSON), since `[k=v]` cannot hold a `/`, `,` or `]`.
 * A leg further up (the leg that calls the workflow, the leg of a composite action's step) stays in the path, where
 * `matrix:` would not reach it; undefined when the path cannot hold its values.
 */
function unitNamed({ nodes, paths }: Units, id: NodeId): Named | undefined {
  const path = paths[id];
  const node = nodes.get(id);
  if (path === undefined || !node || !outerLegs(nodes, node).every(legInPath)) return undefined;
  const own = ownLeg(node);
  const named = own ? withoutLeg(path, own, paths) : { path };
  // A calling leg whose matrix only the run knows is `[*]`, which no path selects.
  return named.path.includes('[*]') ? undefined : named;
}

/** The leg of a unit's own segment: a leg's, or that of a step the leg runs (not one inside a composite action). */
function ownLeg(node: PlanNode): LegPlan | undefined {
  if (node.kind === 'leg') return node.leg;
  return node.kind === 'step' && runsInLeg(node) ? node.leg : undefined;
}

/** A step of the leg itself, where a composite action's inner step is not. */
const runsInLeg = (node: { step: StepPlan; leg: LegPlan }): boolean =>
  node.leg.steps?.includes(node.step) === true;

/** The legs a unit's path selects before its own segment: a composite action step's, then each calling leg's. */
function outerLegs(nodes: Map<NodeId, PlanNode>, node: PlanNode): LegPlan[] {
  const legs: LegPlan[] = node.kind === 'step' && !runsInLeg(node) ? [node.leg] : [];
  for (let caller = callerOf(nodes, node.workflow); caller; caller = callerOf(nodes, caller.workflow))
    if (caller.kind === 'leg') legs.push(caller.leg);
  return legs;
}

/** The job or leg that calls a workflow (a job stands for its single leg); none for a depth-0 workflow. */
function callerOf(nodes: Map<NodeId, PlanNode>, wf: WorkflowPlan): PlanNode | undefined {
  const caller = wf.depth > 0 && wf.caller !== undefined ? nodes.get(wf.caller) : undefined;
  return caller?.kind === 'workflow' ? undefined : caller;
}

/**
 * Whether `[k=v,…]` in a path reads back as the leg's values: a known matrix, no key or value with a `/`, `,`, `]`
 * or surrounding space, no key with a `=`, and no null value (`null` in the path, `''` to the engine).
 */
function legInPath(leg: LegPlan): boolean {
  if (leg.legKey !== '' && Object.keys(leg.values).length === 0) return false;
  return Object.entries(leg.values).every(
    ([key, v]) =>
      plainCell(key) &&
      !key.includes('=') &&
      (!v.known || (v.value !== null && plainCell(stringOf(v.value)))),
  );
}

const plainCell = (s: string): boolean => s.trim() === s && !/[/,\]]/.test(s);

/** The unit's path with its own leg's `[…]` taken out, and the leg's values as the engine compares them. */
function withoutLeg(path: string, leg: LegPlan, paths: Record<NodeId, string>): Named {
  const legPath = paths[leg.id];
  const suffix = `[${leg.legKey}]`;
  if (leg.legKey === '' || !legPath?.endsWith(suffix) || !path.startsWith(legPath)) return { path };
  const bare = `${legPath.slice(0, -suffix.length)}${path.slice(legPath.length)}`;
  const values = Object.entries(leg.values).map(([k, v]) => [k, v.known ? stringOf(v.value) : '?'] as const);
  return values.length ? { path: bare, matrix: Object.fromEntries(values) } : { path: bare };
}

/**
 * `<node>.outputs.<name>`, `<node>.outcome` or `<node>.env.<NAME>`, where `<node>` is the longest node id of the
 * plan the unknown's id begins with (node ids hold dots: `ci.yml#build/steps.detect`).
 */
function parseUnknownId(
  id: string,
  kinds: Derived['kinds'],
): { node: NodeId; about: DraftAbout } | undefined {
  const node = id.startsWith('race:') ? undefined : longestNode(id, Object.keys(kinds));
  const about = node === undefined ? undefined : aboutOfRest(id.slice(node.length + 1));
  return node === undefined || about === undefined ? undefined : { node, about };
}

/** The longest node id followed by a `.` that the unknown's id begins with. */
function longestNode(id: string, nodes: readonly NodeId[]): NodeId | undefined {
  let best: NodeId | undefined;
  for (const node of nodes) if (id.startsWith(`${node}.`) && node.length > (best?.length ?? -1)) best = node;
  return best;
}

/** What the id says after its node: `outcome`, `outputs.<name>` or `env.<NAME>`. */
function aboutOfRest(rest: string): DraftAbout | undefined {
  if (rest === 'outcome') return { field: 'outcome' };
  for (const field of ['outputs', 'env'] as const) {
    const prefix = `${field}.`;
    if (rest.startsWith(prefix) && rest.length > prefix.length)
      return { field, name: rest.slice(prefix.length) };
  }
  return undefined;
}

/**
 * The unit by the node's kind: a step is its own, a job or leg a job unit; a composite action's or a called
 * workflow's unit is the one around it.
 */
function unitOf(
  id: NodeId,
  kind: Derived['kinds'][string] | undefined,
  nodes: Map<NodeId, PlanNode>,
): Unit | undefined {
  if (kind === 'step') return { id, kind: 'step' };
  if (kind === 'job' || kind === 'leg') return { id, kind: 'job' };
  return enclosingUnit(nodes.get(id));
}

/**
 * A composite action's unit is the step that uses it, a called workflow's the leg that calls it; a depth-0 workflow
 * has none.
 */
function enclosingUnit(node: PlanNode | undefined): Unit | undefined {
  if (node?.kind === 'composite') return { id: node.step.id, kind: 'step' };
  if (node?.kind !== 'workflow' || node.workflow.depth === 0) return undefined;
  const { caller } = node.workflow;
  return caller === undefined ? undefined : { id: caller, kind: 'job' };
}

/**
 * `workflow:` when another depth-0 workflow of the plan has a job of the same id as the unit's first job, so the
 * entry would name both without it: the file the unit is declared in, which the engine matches it against (a called
 * workflow's unit is in the callee's file).
 */
function qualifier(nodes: Map<NodeId, PlanNode>, unit: NodeId, plan: RunPlan): string | undefined {
  const root = rootJob(nodes, unit);
  if (!root) return undefined;
  const shared = plan.workflows.some(
    (wf) => wf.depth === 0 && wf !== root.workflow && wf.jobs.some((j) => j.jobId === root.job.jobId),
  );
  return shared ? nodes.get(unit)?.workflow.path : undefined;
}

/** The depth-0 workflow a unit belongs to and its job there: a called workflow's unit climbs to the calling job. */
function rootJob(
  nodes: Map<NodeId, PlanNode>,
  id: NodeId,
): { workflow: WorkflowPlan; job: JobPlan } | undefined {
  let node = nodes.get(id);
  while (node && node.kind !== 'workflow' && node.workflow.depth > 0) {
    const caller = node.workflow.caller;
    node = caller === undefined ? undefined : nodes.get(caller);
  }
  return node && node.kind !== 'workflow' ? { workflow: node.workflow, job: node.job } : undefined;
}

/** The draft around an entry: the outcomes its unit takes, the producer's candidates, its model's presets. */
function offers(
  entry: AssumeEntry,
  about: DraftAbout,
  kind: Unit['kind'],
  producer: PlanNode | undefined,
  models: readonly ModelInfo[],
): PinDraft {
  const draft: PinDraft = {
    entry,
    about,
    outcomes: kind === 'step' ? [...STEP_OUTCOMES] : [...JOB_OUTCOMES],
    candidates: about.field === 'outputs' ? candidatesOf(outputsOf(producer), about.name) : [],
  };
  const uses = usesOf(entry, kind, producer);
  const model = uses === undefined ? undefined : modelOf(uses, models);
  if (model) draft.model = { id: model.id, presets: [...model.presets] };
  return draft;
}

/** The action a step unit runs: the entry's `uses:` pattern, else the producing step's. */
function usesOf(entry: AssumeEntry, kind: Unit['kind'], producer: PlanNode | undefined): string | undefined {
  if (kind !== 'step') return undefined;
  if (entry.uses !== undefined) return entry.uses;
  return producer?.kind === 'step' ? producer.step.uses : undefined;
}

/** The outputs a node produces: a step's, a composite action's, a leg's or job's as readers see them, a callee's. */
function outputsOf(node: PlanNode | undefined): Record<string, Value<string>> | undefined {
  if (!node) return undefined;
  if (node.kind === 'step') return node.step.outputs;
  if (node.kind === 'composite') return node.action.outputs;
  if (node.kind === 'leg') return node.leg.outputs;
  if (node.kind === 'job') return node.job.outputs;
  return node.workflow.outputs;
}

/** The finite values an unknown output may take; an output the producer does not have offers none. */
function candidatesOf(outputs: Record<string, Value<string>> | undefined, name: string): string[] {
  const value = outputs && Object.hasOwn(outputs, name) ? outputs[name] : undefined;
  return value && !value.known && value.oneOf ? value.oneOf.map(String) : [];
}

/** The model whose id is the action `uses` names, without its `@ref` and whatever the case. */
function modelOf(uses: string, models: readonly ModelInfo[]): ModelInfo | undefined {
  const at = uses.indexOf('@');
  const action = (at === -1 ? uses : uses.slice(0, at)).trim().toLowerCase();
  return models.find((m) => m.id.toLowerCase() === action);
}

/** The draft for editing an entry the author already has: the same offers, about its first stated field. */
export function draftOfEntry(entry: AssumeEntry, ctx: PinContext): PinDraft {
  const kind: Unit['kind'] = entry.step !== undefined || entry.uses !== undefined ? 'step' : 'job';
  const units: Units = { nodes: planNodes(ctx.plan), paths: ctx.derived.unitPaths };
  const id = nodeOfEntry(entry, units);
  const producer = id === undefined ? undefined : units.nodes.get(id);
  return offers({ ...entry }, aboutOf(entry), kind, producer, ctx.models);
}

/**
 * The node an entry's unit names, the first in plan order (a job before its single leg, a step before its composite
 * action): by its unit path as written (`test[node=22].detect`), or by the path and `matrix:` values a draft writes,
 * within the file `workflow:` names when the entry names one (the unit's own, as the engine matches it).
 */
function nodeOfEntry(entry: AssumeEntry, units: Units): NodeId | undefined {
  const path = entry.step ?? entry.job;
  if (path === undefined) return undefined;
  for (const [id, node] of units.nodes)
    if (inFile(entry.workflow, node) && namesNode(entry, path, id, units)) return id;
  return undefined;
}

/** A job, leg or step, in the file `workflow:` names when the entry names one. */
function inFile(workflow: string | undefined, node: PlanNode): boolean {
  if (node.kind === 'workflow' || node.kind === 'composite') return false;
  return workflow === undefined || workflowMatches(workflow, node.workflow.path);
}

/** Whether an entry's path names a node: as written, or as a draft writes it with values the node's leg has. */
function namesNode(entry: AssumeEntry, path: string, id: NodeId, units: Units): boolean {
  if (entry.matrix === undefined && units.paths[id] === path) return true;
  const named = unitNamed(units, id);
  if (named?.path !== path) return false;
  return Object.entries(entry.matrix ?? {}).every(([k, v]) => named.matrix?.[k] === String(v));
}

/** The engine's rule (paths.ts `workflowMatches`): the path, its file name, or the file name without `.yml`. */
function workflowMatches(name: string, path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return name === path || name === base || name === base.replace(/\.ya?ml$/i, '');
}

/** The entry's first stated field: an output, else an env write, else its outcome. */
function aboutOf(entry: AssumeEntry): DraftAbout {
  const output = Object.keys(entry.outputs ?? {})[0];
  if (output !== undefined) return { field: 'outputs', name: output };
  const env = Object.keys(entry.env ?? {})[0];
  return env === undefined ? { field: 'outcome' } : { field: 'env', name: env };
}

/** What the editor can say before the worker does: the schema's refinements, worded as the schema words them. */
export function entryProblems(entry: AssumeEntry): string[] {
  const problems = emptyFields(entry);
  if (!namesOneUnit(entry)) problems.push('name a step, a job, or a uses pattern (with a job as its scope)');
  if (
    entry.outcome === undefined &&
    entry.outputs === undefined &&
    entry.env === undefined &&
    entry.as === undefined
  )
    problems.push('state an outcome, outputs, env or as');
  if (entry.job !== undefined && entry.uses === undefined && entry.env !== undefined)
    problems.push('env writes belong to a step');
  return problems;
}

/** A step alone, or a job, a uses pattern, or both. */
const namesOneUnit = (e: AssumeEntry): boolean =>
  e.step === undefined
    ? e.job !== undefined || e.uses !== undefined
    : e.job === undefined && e.uses === undefined;

const NAMED_FIELDS = [
  ['workflow', 'the workflow is empty'],
  ['step', 'the step is empty'],
  ['job', 'the job is empty'],
  ['uses', 'the uses pattern is empty'],
  ['as', 'the preset is empty'],
] as const;

/** A unit or preset written empty, and an output or env write without a name. */
function emptyFields(entry: AssumeEntry): string[] {
  const out: string[] = [];
  for (const [key, message] of NAMED_FIELDS) if (entry[key]?.trim() === '') out.push(message);
  if (Object.keys(entry.outputs ?? {}).some((k) => k.trim() === '')) out.push('an output needs a name');
  if (Object.keys(entry.env ?? {}).some((k) => k.trim() === '')) out.push('an env write needs a name');
  return out;
}

/** The order a test file writes an entry's keys in. */
const KEY_ORDER = ['workflow', 'step', 'job', 'uses', 'matrix', 'as', 'outcome', 'outputs', 'env'] as const;

/** The entry as a test file writes it under `assume:` (a `- ` item, two-space indents, scalars quoted as YAML needs). */
export function entryYaml(entry: AssumeEntry): string {
  const lines: string[] = [];
  for (const key of KEY_ORDER) {
    const value = entry[key];
    if (value === undefined) continue;
    if (typeof value !== 'object') {
      lines.push(`${key}: ${yamlScalar(value)}`);
      continue;
    }
    const pairs = Object.entries(value);
    lines.push(pairs.length ? `${key}:` : `${key}: {}`);
    for (const [name, v] of pairs) lines.push(`  ${yamlScalar(name)}: ${yamlValue(v)}`);
  }
  if (!lines.length) return '- {}';
  return lines.map((line, i) => `${i === 0 ? '- ' : '  '}${line}`).join('\n');
}

function yamlValue(value: MockValue): string {
  return typeof value === 'object' ? '{ unknown: true }' : yamlScalar(value);
}

/**
 * A string, number or boolean as a YAML plain scalar, single-quoted when YAML would read it as something else; a
 * line break or another character YAML cannot hold as written goes in a double-quoted scalar, escaped.
 */
function yamlScalar(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  if (Array.from(value).some(unprintable)) return doubleQuoted(value);
  return needsQuotes(value) ? `'${value.replaceAll("'", "''")}'` : value;
}

/** C0 and C1 controls, DEL, the line and paragraph separators (line breaks to YAML 1.1) and the byte order mark. */
function unprintable(c: string): boolean {
  const code = c.charCodeAt(0);
  return (
    code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0xfeff
  );
}

/** JSON's string escapes are YAML's; what JSON leaves as written is escaped as `\uXXXX`. */
function doubleQuoted(s: string): string {
  let out = '';
  for (const c of JSON.stringify(s))
    out += unprintable(c) ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c;
  return out;
}

/** A first character that starts something other than a plain scalar (an indicator, a quote, a reserved one). */
const INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;
/** Words YAML 1.1 or 1.2 reads as a boolean or null, and the merge key. */
const KEYWORDS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 'on', 'off', 'null', '~', '<<']);
/** What YAML reads as a number besides what `Number` does: octal, binary, underscores, sexagesimal, inf and nan. */
const NUMERIC = [
  /^[-+]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][-+]?\d+)?$/,
  /^0o[0-7_]+$/i,
  /^0b[01_]+$/i,
  /^0x[\da-f_]+$/i,
  /^[-+]?\d[\d_]*(:[0-5]?\d)+(\.\d*)?$/,
  /^[-+]?\.(inf|nan)$/i,
];

function needsQuotes(s: string): boolean {
  if (s === '' || s.trim() !== s || INDICATOR.test(s)) return true;
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return true;
  if (KEYWORDS.has(s.toLowerCase())) return true;
  return !Number.isNaN(Number(s)) || NUMERIC.some((re) => re.test(s));
}
