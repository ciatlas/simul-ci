import type { DispatchInput, FilterKey, Json, WorkflowDocument, YamlPath } from '@simulci/document';
import type { FilterReason, Reason, RunPlan } from '@simulci/engine';
import type { OutlineFile, OutlineWorkflow } from '../../worker/protocol';

/**
 * The triggers editor as data (synthesis § 4.6): one row per event the file's `on:` names, read from the document so
 * the rows never lag the text, with the hints the Outline has (a cron in words, the converter's problem) and the
 * checks the plan shown makes (its trigger reasons for the scenario's event). Pure; `TriggerRows` renders it.
 */

/** What `on:` is written as: none (no `on:`, or no value), one event, a list of events, or a map of them. */
export type OnShape = 'none' | 'scalar' | 'seq' | 'map';

export interface TriggerModel {
  shape: OnShape;
  rows: EventRow[];
  /** `on:` holds YAML these rows cannot show (a number, a list holding a map): its line, for Edit in YAML. */
  odd?: number;
}

export interface EventRow {
  event: string;
  line: number;
  /** The filters written, in the file's order. */
  filters: FilterRow[];
  /** The filters the event reads that it does not have yet. */
  addable: FilterKey[];
  types?: TypesRow;
  crons?: CronRow[];
  inputs?: InputRow[];
  /** Keys under the event these rows do not edit (`workflows`, an unknown key), each with its line. */
  other: { key: string; line: number }[];
  /** The event's value is YAML these rows cannot show (a scalar, a list where a map goes). */
  odd?: boolean;
}

export interface FilterRow {
  key: FilterKey;
  patterns: string[];
  line: number;
}

export interface TypesRow {
  /** `types:` is written; else `values` are the event's default types, shown grey. */
  written: boolean;
  values: string[];
  /** Every type the event has; empty for an event whose types are free strings (`repository_dispatch`). */
  all: string[];
}

export interface CronRow {
  cron: string;
  timezone?: string;
  line: number;
}

export interface InputRow {
  name: string;
  line: number;
  input: DispatchInput;
}

/** A row's check: what the plan shown says of its filter, its types or its schedule for the scenario's event. */
export interface Check {
  mark: 'yes' | 'no' | 'maybe';
  text: string;
}

/** The activity types of every event, from the worker's `ready` (or the Outline's, for the events present). */
export type EventTable = Record<string, { types: string[]; default: string[] }>;

const FILTER_KEYS: readonly FilterKey[] = [
  'branches',
  'branches-ignore',
  'tags',
  'tags-ignore',
  'paths',
  'paths-ignore',
];

/** The filters each event reads (docs.github.com; the engine's PATH_FILTER_EVENTS and BASE_BRANCH_EVENTS). */
const FILTERS_OF: Record<string, readonly FilterKey[]> = {
  push: FILTER_KEYS,
  pull_request: ['branches', 'branches-ignore', 'paths', 'paths-ignore'],
  pull_request_target: ['branches', 'branches-ignore', 'paths', 'paths-ignore'],
  merge_group: ['branches', 'branches-ignore'],
  workflow_run: ['branches', 'branches-ignore'],
};

/** The events whose `types:` are free strings (the engine's CUSTOM_TYPES_EVENTS). */
const FREE_TYPES = new Set(['repository_dispatch']);

/** The keys of a dispatch input the rows edit, in the order the op writes them. */
const INPUT_KEYS = ['description', 'required', 'default', 'type', 'options'] as const;

const ON: YamlPath = ['on'];

/** The rows of a workflow's `on:`, from its document now. */
export function triggerModel(doc: WorkflowDocument, table: EventTable): TriggerModel {
  const on = doc.get(ON);
  const value = on?.value ?? null;
  if (value === null) return { shape: 'none', rows: [] };
  const line = doc.lineOf(ON) ?? 1;
  if (typeof value === 'string') return { shape: 'scalar', rows: [bare(value, line, table)] };
  if (Array.isArray(value)) {
    if (!value.every((e): e is string => typeof e === 'string')) return { shape: 'seq', rows: [], odd: line };
    return {
      shape: 'seq',
      rows: value.map((event, i) => bare(event, doc.lineOf([...ON, i]) ?? line, table)),
    };
  }
  if (typeof value !== 'object') return { shape: 'none', rows: [], odd: line };
  return {
    shape: 'map',
    rows: Object.entries(value).map(([event, config]) => eventRow(doc, event, config, table)),
  };
}

/** An event named with no configuration: `on: push`, an item of `on: [push, pull_request]`, `push:`. */
function bare(event: string, line: number, table: EventTable): EventRow {
  const row: EventRow = { event, line, filters: [], addable: [...(FILTERS_OF[event] ?? [])], other: [] };
  const types = typesRow(event, table);
  if (types) row.types = types;
  if (event === 'workflow_dispatch') row.inputs = [];
  return row;
}

function eventRow(doc: WorkflowDocument, event: string, config: Json, table: EventTable): EventRow {
  const row = bare(event, doc.lineOf([...ON, event]) ?? 1, table);
  if (event === 'schedule') return scheduleRow(doc, row, config);
  if (config === null) return row;
  if (!isMap(config)) return odd(row);
  for (const [key, value] of Object.entries(config)) place(doc, row, key, value);
  const present = new Set(row.filters.map((f) => f.key));
  row.addable = row.addable.filter((key) => !present.has(key));
  return row;
}

/** `schedule:` is the list of its crons. */
function scheduleRow(doc: WorkflowDocument, row: EventRow, config: Json): EventRow {
  if (config === null) return { ...row, crons: [] };
  return Array.isArray(config) ? { ...row, crons: cronsOf(doc, config) } : odd(row);
}

/** One key under an event: in the row that edits it, or among the keys left to the YAML. */
function place(doc: WorkflowDocument, row: EventRow, key: string, value: Json): void {
  const line = doc.lineOf([...ON, row.event, key]) ?? row.line;
  if (!placeList(row, key, patterns(value), line) && !placeInputs(doc, row, key, value))
    row.other.push({ key, line });
}

/** A filter the event reads, or its `types:`; false for any other key. */
function placeList(row: EventRow, key: string, list: string[] | undefined, line: number): boolean {
  if (!list) return false;
  if ((FILTERS_OF[row.event] ?? []).includes(key as FilterKey)) {
    row.filters.push({ key: key as FilterKey, patterns: list, line });
    return true;
  }
  if (key !== 'types' || !row.types) return false;
  row.types = { written: true, values: list, all: row.types.all };
  return true;
}

/** A manual run's `inputs:`; false for any other key. */
function placeInputs(doc: WorkflowDocument, row: EventRow, key: string, value: Json): boolean {
  if (key !== 'inputs' || !row.inputs || !isMap(value)) return false;
  row.inputs = inputsOf(doc, value);
  return true;
}

const odd = (row: EventRow): EventRow => ({ ...row, addable: [], odd: true });

const isMap = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A filter's patterns: a list of strings, or one string, which GitHub reads as a list of one. */
function patterns(value: Json): string[] | undefined {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

/** The types row of an event that has activity types, its defaults until `types:` is read; none for the others. */
function typesRow(event: string, table: EventTable): TypesRow | undefined {
  const all = table[event]?.types ?? [];
  if (all.length === 0 && !FREE_TYPES.has(event)) return undefined;
  return { written: false, values: table[event]?.default ?? [], all };
}

function cronsOf(doc: WorkflowDocument, items: Json[]): CronRow[] {
  return items.flatMap((item, i) => {
    if (!isMap(item) || typeof item.cron !== 'string') return [];
    const row: CronRow = { cron: item.cron, line: doc.lineOf([...ON, 'schedule', i, 'cron']) ?? 1 };
    if (typeof item.timezone === 'string') row.timezone = item.timezone;
    return [row];
  });
}

function inputsOf(doc: WorkflowDocument, inputs: { [key: string]: Json }): InputRow[] {
  return Object.entries(inputs).map(([name, value]) => ({
    name,
    line: doc.lineOf([...ON, 'workflow_dispatch', 'inputs', name]) ?? 1,
    input: inputOf(value),
  }));
}

/** An input as the op takes it: the keys it writes, each kept as the file has it. */
export function inputOf(value: Json): DispatchInput {
  const input: Record<string, Json> = {};
  if (!isMap(value)) return input;
  for (const key of INPUT_KEYS) if (value[key] !== undefined) input[key] = value[key];
  return input;
}

/** A dispatch input's default from what is typed, as its type reads it; nothing typed removes it. */
export function defaultOf(type: DispatchInput['type'], typed: string): Json | undefined {
  const text = typed.trim();
  if (text === '') return undefined;
  if (type === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  if (type === 'number' && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return typed;
}

/** The events Add event offers: every event of the table the file does not name yet. */
export function addableEvents(model: TriggerModel, table: EventTable): string[] {
  const named = new Set(model.rows.map((r) => r.event));
  return Object.keys(table)
    .filter((event) => !named.has(event))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * A cron in words, from the Outline (the worker's `describeCron`), or the converter's problem with it, which the file's
 * errors give at the cron's line. Nothing while the Outline does not know the cron yet (an edit's load on its way).
 */
export function cronHint(
  wf: OutlineWorkflow | undefined,
  file: OutlineFile | undefined,
  cron: CronRow,
): { text: string } | { problem: string } | undefined {
  const schedule = wf?.events.find((e) => e.event === 'schedule');
  const at = schedule?.crons?.indexOf(cron.cron) ?? -1;
  if (at < 0) return undefined;
  const text = schedule?.cronText?.[at];
  if (typeof text === 'string') return { text };
  const error = file?.errors.find((e) => e.line === cron.line);
  return { problem: error?.message ?? 'GitHub would not accept this cron.' };
}

/** The trigger reasons of a depth-0 workflow in a plan, when the plan is of the event: the rows' checks read them. */
export function chainOf(plan: RunPlan | undefined, path: string, event: string): Reason[] | undefined {
  if (plan?.scenario.event !== event) return undefined;
  return plan.workflows.find((w) => w.depth === 0 && w.path === path)?.triggered.chain;
}

/** A filter's words, matched or not: `[include, ignore]` per subject, each `[matched, not matched]`. */
const REF_WORDS = [
  ['matches', 'matches none'],
  ['is not ignored', 'is ignored'],
] as const;
const PATH_WORDS = [
  ['a changed file matches', 'no changed file matches'],
  ['a changed file is not ignored', 'every changed file is ignored'],
] as const;

/** What the plan says of one filter: the ref, the run's branch or the changed files against its patterns. */
export function filterCheck(chain: readonly Reason[] | undefined, key: FilterKey): Check | undefined {
  const reason = chain?.find((r): r is FilterReason => r.kind === 'filter' && r.filter === key);
  if (!reason) return undefined;
  const files = key.startsWith('paths');
  if (!reason.matched.known)
    return { mark: 'maybe', text: files ? 'changed files not given' : 'the branch is not given' };
  const ok = reason.matched.value;
  const words = (files ? PATH_WORDS : REF_WORDS)[key.endsWith('-ignore') ? 1 : 0][ok ? 0 : 1];
  const subject = files || !reason.subject.known ? '' : `${String(reason.subject.value)} `;
  return { mark: ok ? 'yes' : 'no', text: `${subject}${words}` };
}

/** What the plan says of the activity types: whether the scenario's type is among them. */
export function typesCheck(chain: readonly Reason[] | undefined): Check | undefined {
  const reason = chain?.find((r) => r.kind === 'types');
  if (reason?.kind !== 'types') return undefined;
  if (!reason.matched.known) return { mark: 'maybe', text: 'no activity type given' };
  if (reason.action === undefined) return undefined;
  return reason.matched.value
    ? { mark: 'yes', text: `${reason.action} is listed` }
    : { mark: 'no', text: `${reason.action} is not listed` };
}

/** What the plan says of the schedule: whether the scenario's cron is one of them. */
export function scheduleCheck(chain: readonly Reason[] | undefined): Check | undefined {
  const reason = chain?.find((r) => r.kind === 'schedule');
  if (reason?.kind !== 'schedule' || reason.cron === undefined) return undefined;
  return reason.matched
    ? { mark: 'yes', text: `${reason.cron} is listed` }
    : { mark: 'no', text: `${reason.cron} is not listed` };
}
