import type { AssumeEntry, Loc, MockValue, NodeId, RunPlan, Unknown, UnknownKind } from '@simulci/engine';
import type { PlanIndex } from '../plan/index';
import type { Derived } from '../worker/protocol';
import type { Outcome } from './pin-draft';
import { planLabels } from './outline-tree';

/**
 * The Unknowns tab's model (synthesis § 7), apart from React: the plan's unknowns as rows, the ones that decide a
 * verdict apart from the rest, the row the focus moves to once a pin removed one, and the PinEditor's fields as the
 * author edits them, turned back into an assume entry.
 */

export interface AffectedNode {
  id: NodeId;
  /** As the canvas words it (`planLabels`), else its unit path. */
  label: string;
}

export interface UnknownRowModel {
  unknown: Unknown;
  /** The unknown in unit-path form (`build.detect.outputs.changed`), else its id. */
  path: string;
  kind: UnknownKind;
  /** The nodes that run `maybe` because of it, in the engine's order. */
  affects: AffectedNode[];
  reads: Loc[];
}

export interface UnknownRows {
  /** The unknowns that decide a verdict (`affects` is not empty). */
  gating: UnknownRowModel[];
  /** The ones that decide none. */
  idle: UnknownRowModel[];
}

/**
 * The plan's unknowns as rows, in plan order (the engine ranks them by the nodes they affect, then by id). With
 * `affecting`, only the unknowns that affect that node or a node under it.
 */
export function unknownRows(
  plan: RunPlan,
  derived: Derived,
  index: PlanIndex,
  opts: { affecting?: NodeId } = {},
): UnknownRows {
  const labels = planLabels(plan);
  const rows: UnknownRows = { gating: [], idle: [] };
  const { affecting } = opts;
  for (const u of plan.unknowns) {
    if (affecting !== undefined && !u.affects.some((id) => isWithin(index, id, affecting))) continue;
    const row: UnknownRowModel = {
      unknown: u,
      path: derived.unknownPaths[u.id] ?? u.id,
      kind: u.kind,
      affects: u.affects.map((id) => ({ id, label: labels.get(id) ?? derived.unitPaths[id] ?? id })),
      reads: u.reads,
    };
    (u.affects.length > 0 ? rows.gating : rows.idle).push(row);
  }
  return rows;
}

/** Whether a node is `ancestor` itself or sits under it, by the index's parents. */
function isWithin(index: PlanIndex, id: NodeId, ancestor: NodeId): boolean {
  for (let at: NodeId | undefined = id; at !== undefined; at = index.nodes.get(at)?.parent) {
    if (at === ancestor) return true;
  }
  return false;
}

/** The `affects n` button's words: the count, and the nodes it names in its title (`build and deploy`). */
export function affectsText(affects: readonly AffectedNode[]): { text: string; names: string } {
  return { text: `affects ${affects.length}`, names: listed(affects.map((a) => a.label)) };
}

/** Words as a sentence lists them: `a`, `a and b`, `a, b and c`. */
export function listed(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * The row the focus goes to once the pinned row is gone: the first of the rows shown after it that the new plan
 * still has, else the nearest one before it. Undefined sends it to the tab's heading.
 */
export function focusAfter(
  order: readonly string[],
  pinned: string,
  present: ReadonlySet<string>,
): string | undefined {
  const at = order.indexOf(pinned);
  if (at === -1) return order.find((id) => present.has(id));
  return (
    order.slice(at + 1).find((id) => present.has(id)) ?? order.slice(0, at).findLast((id) => present.has(id))
  );
}

/** Where an entry applied, as the Assumptions list says it: `applied at build.detect, provides outcome, outputs.sha`. */
export function appliedText(applied: readonly { at: string; provides: string[] }[]): string {
  if (applied.length === 0) return 'applied nowhere';
  const groups = new Map<string, string[]>();
  for (const a of applied) {
    const provides = a.provides.join(', ');
    groups.set(provides, [...(groups.get(provides) ?? []), a.at]);
  }
  return [...groups]
    .map(([provides, at]) => `applied at ${listed(at)}${provides === '' ? '' : `, provides ${provides}`}`)
    .join('; ');
}

// --- the PinEditor's fields ----------------------------------------------------------------------------------------

/** A name and its value as the editor's rows hold them; `id` tells the rows apart while names are typed. */
export interface EditorPair {
  id: number;
  name: string;
  value: string;
  /** The entry's value when it is no string (a number, a boolean, `{ unknown: true }`), kept until the text changes. */
  held?: MockValue;
}

/** What the editor lets the author change; the unit the entry names stays as the draft wrote it. */
export interface EditorForm {
  /** `none`: the entry states no outcome, only outputs, env or a preset. */
  outcome: Outcome | 'none';
  outputs: EditorPair[];
  env: EditorPair[];
  as?: string;
}

export type PairField = 'outputs' | 'env';

const NOUN: Record<PairField, string> = { outputs: 'output', env: 'env write' };

/** The editor's fields for an entry. */
export function formOf(entry: AssumeEntry): EditorForm {
  let id = 0;
  const pairs = (record: Record<string, MockValue> | undefined): EditorPair[] =>
    Object.entries(record ?? {}).map(([name, value]) => pairOf(id++, name, value));
  const form: EditorForm = {
    outcome: entry.outcome ?? 'none',
    outputs: pairs(entry.outputs),
    env: pairs(entry.env),
  };
  if (entry.as !== undefined) form.as = entry.as;
  return form;
}

function pairOf(id: number, name: string, value: MockValue): EditorPair {
  if (typeof value === 'string') return { id, name, value };
  return { id, name, value: typeof value === 'object' ? '' : String(value), held: value };
}

const UNIT_KEYS = new Set(['workflow', 'step', 'job', 'uses', 'matrix']);

/**
 * The entry the fields state: the draft's unit (`workflow`, `step`, `job`, `uses`, `matrix`), then the outcome, the
 * named outputs and env writes (a row without a name is left out) and the preset, in the order a test file writes them.
 */
export function entryOf(base: AssumeEntry, form: EditorForm): AssumeEntry {
  const entry = Object.fromEntries(Object.entries(base).filter(([key]) => UNIT_KEYS.has(key))) as AssumeEntry;
  if (form.outcome !== 'none') entry.outcome = form.outcome;
  const outputs = recordOf(form.outputs);
  if (outputs) entry.outputs = outputs;
  const env = recordOf(form.env);
  if (env) entry.env = env;
  if (form.as !== undefined) entry.as = form.as;
  return entry;
}

function recordOf(pairs: readonly EditorPair[]): Record<string, MockValue> | undefined {
  const named = pairs.filter((p) => p.name.trim() !== '');
  if (named.length === 0) return undefined;
  return Object.fromEntries(named.map((p) => [p.name.trim(), p.held ?? p.value]));
}

/** What the fields say wrong before they are an entry: a value without a name, a name given twice. */
export function formProblems(form: EditorForm): string[] {
  const problems: string[] = [];
  for (const field of ['outputs', 'env'] as const) {
    const names = form[field].map((p) => p.name.trim());
    if (form[field].some((p, i) => names[i] === '' && (p.value !== '' || p.held !== undefined)))
      problems.push(`an ${NOUN[field]} value has no name`);
    const twice = names.find((name, i) => name !== '' && names.indexOf(name) !== i);
    if (twice !== undefined) problems.push(`two ${NOUN[field]}s are named ${twice}`);
  }
  return problems;
}

/** The fields with an empty row added at the end of `field`. */
export function withPair(form: EditorForm, field: PairField): EditorForm {
  const id = Math.max(-1, ...form.outputs.map((p) => p.id), ...form.env.map((p) => p.id)) + 1;
  return { ...form, [field]: [...form[field], { id, name: '', value: '' }] };
}

/** The fields without the row `id` of `field`. */
export function withoutPair(form: EditorForm, field: PairField, id: number): EditorForm {
  return { ...form, [field]: form[field].filter((p) => p.id !== id) };
}

/** The fields with the row `id` renamed or given a new value; typing a value drops the one it held. */
export function withPairEdit(
  form: EditorForm,
  field: PairField,
  id: number,
  patch: { name?: string; value?: string },
): EditorForm {
  return { ...form, [field]: form[field].map((p) => (p.id === id ? edited(p, patch) : p)) };
}

function edited(pair: EditorPair, patch: { name?: string; value?: string }): EditorPair {
  const next = { ...pair, ...patch };
  if (patch.value !== undefined) delete next.held;
  return next;
}

/** The fields with `name` set to `value` (a candidate chip): its row when there is one, else a new row. */
export function withValue(form: EditorForm, field: PairField, name: string, value: string): EditorForm {
  const row = form[field].find((p) => p.name.trim() === name);
  if (row) return withPairEdit(form, field, row.id, { value });
  const added = withPair(form, field);
  const pair = added[field].at(-1)!;
  return withPairEdit(added, field, pair.id, { name, value });
}

/**
 * The fields with a model's preset written as `as:`, which states what the rows would: rows still empty go. Without
 * a preset, `as:` goes; when nothing else is stated then, the draft's fields come back.
 */
export function withPreset(form: EditorForm, preset: string | undefined, draft?: EditorForm): EditorForm {
  if (preset === undefined) {
    const next = { ...form };
    delete next.as;
    const stated = next.outcome !== 'none' || next.outputs.length > 0 || next.env.length > 0;
    if (stated || !draft) return next;
    return { ...next, outcome: draft.outcome, outputs: draft.outputs, env: draft.env };
  }
  const filled = (p: EditorPair): boolean => p.value !== '' || p.held !== undefined;
  return { ...form, as: preset, outputs: form.outputs.filter(filled), env: form.env.filter(filled) };
}

/** The outcomes the radio group offers: the unit's, the entry's own when it is not one of them, and `none`. */
export function outcomeOptions(
  outcomes: readonly Outcome[],
  current: EditorForm['outcome'],
): (Outcome | 'none')[] {
  const options: (Outcome | 'none')[] = [...outcomes];
  if (current !== 'none' && !options.includes(current)) options.push(current);
  return [...options, 'none'];
}

/** Whether the entry may state env writes: a step's, or the steps a `uses` pattern names (the schema's rule). */
export function envAllowed(entry: AssumeEntry): boolean {
  return entry.step !== undefined || entry.uses !== undefined;
}

/** The unit an entry names, as the editor shows it read-only: `step build.detect`, `matrix node=22`. */
export function unitFacts(entry: AssumeEntry): [string, string][] {
  const facts: [string, string][] = [];
  for (const key of ['workflow', 'step', 'job', 'uses'] as const) {
    const value = entry[key];
    if (value !== undefined) facts.push([key, value]);
  }
  if (entry.matrix) {
    const cells = Object.entries(entry.matrix).map(([k, v]) => `${k}=${String(v)}`);
    facts.push(['matrix', cells.join(', ')]);
  }
  return facts;
}
