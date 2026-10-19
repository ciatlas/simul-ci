import type {
  AssumeEntry,
  JobPlan,
  MockValue,
  NodeId,
  RunPlan,
  Unknown,
  Value,
  WorkflowPlan,
} from '@simulci/engine';
import { planIndex } from '../plan/index';
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
   * The entry as it would be written: `step:` or `job:` by unit path (`build.detect`, `test[node=22]`,
   * `caller/job.step`), `workflow:` only when another depth-0 workflow has a job of the same id, and the field the
   * unknown is about prefilled (an output or env value `''`, the outcome `failure`).
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

/** The draft for a step or job unknown; undefined when the id names no step, leg or job of the plan. */
export function draftFor(unknown: Unknown, ctx: PinContext): PinDraft | undefined {
  const ref = parseUnknownId(unknown.id, ctx.derived.kinds);
  if (!ref) return undefined;
  const nodes = planNodes(ctx.plan);
  const unit = unitOf(ref.node, ctx.derived.kinds[ref.node], nodes);
  if (!unit) return undefined;
  const path = ctx.derived.unitPaths[unit.id];
  if (path === undefined) return undefined;
  if (ref.about.field === 'env' && unit.kind === 'job') return undefined;
  const entry: AssumeEntry = {};
  const workflow = qualifier(nodes, unit.id, ctx.plan);
  if (workflow !== undefined) entry.workflow = workflow;
  entry[unit.kind] = path;
  if (ref.about.field === 'outcome') entry.outcome = 'failure';
  else entry[ref.about.field] = { [ref.about.name]: '' };
  const producer = nodes.get(ref.node);
  return offers(entry, ref.about, unit.kind, producer, ctx.models);
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
 * `workflow:` for the unit's depth-0 workflow, when another depth-0 workflow of the plan has a job of the same id
 * as the unit's first job, so the entry would name both without it.
 */
function qualifier(nodes: Map<NodeId, PlanNode>, unit: NodeId, plan: RunPlan): string | undefined {
  const root = rootJob(nodes, unit);
  if (!root) return undefined;
  const shared = plan.workflows.some(
    (wf) => wf.depth === 0 && wf !== root.workflow && wf.jobs.some((j) => j.jobId === root.job.jobId),
  );
  return shared ? root.workflow.path : undefined;
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
  const unit = entry.step ?? entry.job;
  const id = unit === undefined ? undefined : nodeOfPath(unit, entry.workflow, ctx);
  const producer = id === undefined ? undefined : planNodes(ctx.plan).get(id);
  return offers({ ...entry }, aboutOf(entry), kind, producer, ctx.models);
}

/**
 * The node a unit path names (the reverse of `derived.unitPaths`, per depth-0 workflow: a job before its single leg,
 * a step before its composite action), in the first workflow that has it, within `workflow` when the entry names one.
 */
function nodeOfPath(path: string, workflow: string | undefined, ctx: PinContext): NodeId | undefined {
  for (const [wf, paths] of planIndex(ctx).byPath) {
    if (workflow !== undefined && !workflowMatches(workflow, wf)) continue;
    const id = paths.get(path);
    if (id !== undefined) return id;
  }
  return undefined;
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
