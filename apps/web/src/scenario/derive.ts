import type { ScenarioInput } from '@simulci/engine';
import type { Issue } from '../state/store';
import type { Outline, OutlineEvent, OutlineInput, OutlineWorkflow } from '../worker/protocol';
import { eventChoices } from './defaults';
import {
  type ActivityTypes,
  activityTypes,
  crons,
  namedTypes,
  PR_EVENTS,
  PULL_REF_EVENTS,
  pushRef,
  readsChangedFiles,
  workflowNames,
} from './form';
import { type SampleKind, sampleOf } from './sample';

/**
 * The scenario form as data: the events to offer, the field groups the event shows, and what each field can tell
 * from the filters that read it (a sentence, and chips that fill in a value the filters select). Pure; the
 * components under fields/ render it and write one scenario key each. It also says which field shows the worker's
 * refusal of each key, so an issue no field shows can be summed up instead.
 */

export type GroupId =
  | 'event'
  | 'activityType'
  | 'ref'
  | 'pullRequest'
  | 'release'
  | 'cron'
  | 'workflowRun'
  | 'dispatch'
  | 'changedFiles'
  | 'message'
  | 'advanced';

export interface EventOption {
  event: string;
  label: string;
}

export interface EventOptions {
  /** The focused workflow's name, heading its events. */
  title?: string;
  /** The focused workflow's events, in declaration order. */
  focused: EventOption[];
  /** Every other event a workflow listens to, then `workflow_dispatch` when none does. */
  others: EventOption[];
}

/** A value the filters select: the pattern itself when it names one, else a sample that matches it. */
export interface Chip {
  pattern: string;
  value: string;
}

export interface FieldHint {
  /** A sentence under the field, read with it. */
  text?: string;
  chips: Chip[];
}

export type HintKey =
  | 'event'
  | 'action'
  | 'branch'
  | 'tag'
  | 'base'
  | 'release'
  | 'cron'
  | 'workflow_run'
  | 'workflow_run.branch'
  | 'changed';

/** One listening workflow's dispatch inputs. */
export interface DispatchGroup {
  path: string;
  title: string;
  inputs: OutlineInput[];
}

export interface FormModel {
  events: EventOptions;
  groups: GroupId[];
  activity?: ActivityTypes;
  crons: string[];
  runNames: string[];
  dispatch: DispatchGroup[];
  hints: Partial<Record<HintKey, FieldHint>>;
  /** An issue path (`key`, or `key.sub` where a field shows one part) to the field that shows it. */
  fields: Map<string, string>;
  /** The fields under Advanced, so the panel knows a refusal of one of them. */
  advanced: string[];
}

/** What the form keeps in view while the author edits, though the scenario no longer asks for it (see keep.ts). */
export interface Keep {
  ref?: boolean;
  changed?: boolean;
}

export function deriveForm(
  outline: Outline,
  scenario: ScenarioInput,
  focus: string | undefined,
  keep: Keep = {},
): FormModel {
  const dispatch = dispatchGroups(outline, focus);
  const groups = groupsOf(outline, scenario, dispatch, keep);
  const fields = fieldsOf(groups, dispatch);
  const model: FormModel = {
    events: eventOptions(outline, focus),
    groups,
    crons: crons(outline),
    runNames: workflowNames(outline),
    dispatch,
    hints: hintsOf(outline, scenario.event, focus),
    fields,
    advanced: advancedFields(fields),
  };
  const activity = activityTypes(outline, scenario.event);
  if (activity) model.activity = activity;
  return model;
}

/** The events whose `branches` are matched against the pull request's base (the engine's BASE_BRANCH_EVENTS). */
const BASE_BRANCH_EVENTS = new Set(['pull_request', 'pull_request_target', 'merge_group']);
/** The events that read `paths` (the engine's PATH_FILTER_EVENTS). */
const PATH_FILTER_EVENTS = new Set(['push', 'pull_request', 'pull_request_target']);
/** The events whose runs a skip marker in the commit message stops (the engine's SKIP_EVENTS). */
const SKIP_EVENTS = new Set(['push', 'pull_request']);

/** The group an event owns, besides the pull-request events, which share theirs. */
const OWN_GROUP = new Map<string, GroupId>([
  ['release', 'release'],
  ['schedule', 'cron'],
  ['workflow_run', 'workflowRun'],
  ['workflow_dispatch', 'dispatch'],
]);

function groupsOf(
  outline: Outline,
  scenario: ScenarioInput,
  dispatch: DispatchGroup[],
  keep: Keep,
): GroupId[] {
  const { event } = scenario;
  const out: GroupId[] = ['event'];
  if (activityTypes(outline, event)) out.push('activityType');
  if (keep.ref || showsRef(scenario)) out.push('ref');
  const own = ownGroup(event, dispatch);
  if (own) out.push(own);
  if (keep.changed || showsChanged(scenario)) out.push('changedFiles');
  if (SKIP_EVENTS.has(event)) out.push('message');
  out.push('advanced');
  return out;
}

/** The group an event owns; a dispatch has none when no workflow declares inputs. */
function ownGroup(event: string, dispatch: DispatchGroup[]): GroupId | undefined {
  const own = OWN_GROUP.get(event) ?? (PR_EVENTS.has(event) ? 'pullRequest' : undefined);
  return own === 'dispatch' && dispatch.length === 0 ? undefined : own;
}

/**
 * A push and a dispatch run on the ref the author names; any other event that reads a ref shows one the scenario
 * carries, so it can be seen and cleared. A release reads its tag in a field of its own; a pull request reads none,
 * and a branch that followed it from a push stays for the way back, out of sight.
 */
export function showsRef(scenario: ScenarioInput): boolean {
  const { event } = scenario;
  if (event === 'push' || event === 'workflow_dispatch') return true;
  if (event === 'release' || PULL_REF_EVENTS.has(event)) return false;
  return pushRef(scenario).kind !== undefined;
}

/**
 * The changed files show on the events whose `paths` the engine reads (a tag push skips them), and on any other
 * while the scenario carries some: a model (a paths filter action) reads them on any event, so a pin's example there
 * can be seen, changed and cleared.
 */
export function showsChanged(scenario: ScenarioInput): boolean {
  return readsChangedFiles(scenario) || scenario.changed !== undefined;
}

/**
 * What the changed files are kept in view for (keep.ts): the event, and whether the engine reads them on it, so a
 * push that turns to a tag still lets them go while files the author clears stay under the caret.
 */
export const changedKeepKey = (scenario: ScenarioInput): string =>
  `${scenario.event}.${readsChangedFiles(scenario)}`;

type Route = readonly [path: string, field: string];

const GROUP_FIELDS: Record<GroupId, readonly Route[]> = {
  event: [['event', 'event']],
  activityType: [['action', 'action']],
  ref: [
    ['ref', 'ref'],
    ['branch', 'ref'],
    ['tag', 'ref'],
  ],
  pullRequest: [
    ['base', 'base'],
    ['head', 'head'],
    ['number', 'number'],
    ['merged', 'merged'],
    ['actor.fork', 'fork'],
  ],
  release: [
    ['tag', 'tag'],
    ['ref', 'tag'],
  ],
  cron: [['cron', 'cron']],
  workflowRun: [
    ['workflow_run', 'workflow_run'],
    ['workflow_run.branch', 'workflow_run.branch'],
    ['workflow_run.conclusion', 'workflow_run.conclusion'],
  ],
  dispatch: [['inputs', 'inputs']],
  changedFiles: [['changed', 'changed']],
  message: [['message', 'message']],
  // After the groups above, which take a path first: `ref` and the fork are rows here only where no group shows them.
  advanced: [
    ['ref', 'rawRef'],
    ['actor', 'actor.login'],
    ['actor.login', 'actor.login'],
    ['actor.bot', 'actor.bot'],
    ['actor.fork', 'actor.fork'],
    ['sha', 'sha'],
    ['defaultBranch', 'defaultBranch'],
    ['repository', 'repository'],
    ['vars', 'vars'],
    ['secrets', 'secrets'],
    ['environments', 'environments'],
    ['platform', 'platform'],
  ],
};

/** Each path to the first group's field that shows it. */
function fieldsOf(groups: GroupId[], dispatch: DispatchGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const group of groups)
    for (const [path, field] of GROUP_FIELDS[group]) if (!out.has(path)) out.set(path, field);
  if (groups.includes('dispatch'))
    for (const d of dispatch) for (const i of d.inputs) out.set(`inputs.${i.name}`, `inputs.${i.name}`);
  return out;
}

const advancedFields = (fields: Map<string, string>): string[] =>
  Array.from(new Set(GROUP_FIELDS.advanced.filter(([path, f]) => fields.get(path) === f).map(([, f]) => f)));

export interface RoutedIssues {
  /** The messages each field shows, joined. */
  byField: Map<string, string>;
  /** What no field shows: a key the form has no field for, or the scenario as a whole. */
  summary: Issue[];
}

export function routeIssues(issues: readonly Issue[], fields: Map<string, string>): RoutedIssues {
  const byField = new Map<string, string>();
  const summary: Issue[] = [];
  for (const issue of issues) {
    const route = routeOf(issue, fields);
    if (route === undefined) summary.push(issue);
    else {
      const [field, message] = route;
      byField.set(field, byField.has(field) ? `${byField.get(field)}; ${message}` : message);
    }
  }
  return { byField, summary };
}

/** The keys that hold entries by name: a refusal of an entry with no field of its own names it in the key's field. */
const NAMED_ENTRIES = new Set(['inputs', 'vars']);

function routeOf(issue: Issue, fields: Map<string, string>): [field: string, message: string] | undefined {
  const [key, part] = issue.path;
  if (key === undefined) return undefined;
  const own = part === undefined ? undefined : fields.get(`${key}.${part}`);
  if (own !== undefined) return [own, issue.message];
  const field = fields.get(String(key));
  if (field === undefined) return undefined;
  const named = part !== undefined && NAMED_ENTRIES.has(String(key));
  return [field, named ? `${String(part)}: ${issue.message}` : issue.message];
}

function eventOptions(outline: Outline, focus: string | undefined): EventOptions {
  const total = outline.workflows.length;
  const workflows = `workflow${total === 1 ? '' : 's'}`;
  const option = (c: { event: string; listeners: number }): EventOption => ({
    event: c.event,
    label: `${c.event} · ${c.listeners ? `${c.listeners} of ${total} ${workflows}` : 'none listens'}`,
  });
  const choices = eventChoices(outline, focus);
  const out: EventOptions = {
    focused: choices.filter((c) => c.focused).map(option),
    others: choices.filter((c) => !c.focused).map(option),
  };
  const focused = outline.workflows.find((w) => w.path === focus);
  if (focused) out.title = titleOf(focused);
  return out;
}

/** The workflows with dispatch inputs, the focused one first. */
function dispatchGroups(outline: Outline, focus: string | undefined): DispatchGroup[] {
  return byFocus(outline.workflows, focus)
    .filter((w) => (w.dispatch ?? []).length > 0)
    .map((w) => ({ path: w.path, title: titleOf(w), inputs: w.dispatch ?? [] }));
}

type Hints = FormModel['hints'];

/** The hints an event's fields take from its listeners' filters, each kind of event its own. */
const EVENT_HINTS: [applies: (event: string) => boolean, hints: (on: OutlineEvent[]) => Hints][] = [
  [
    (e) => e === 'push',
    (on) => ({
      branch: refHint(on, 'branches', 'branchesIgnore', 'branch', 'branches'),
      tag: refHint(on, 'tags', 'tagsIgnore', 'tag', 'tags'),
    }),
  ],
  [
    (e) => BASE_BRANCH_EVENTS.has(e),
    (on) => ({ base: refHint(on, 'branches', 'branchesIgnore', 'branch', 'branches (the base)') }),
  ],
  [
    (e) => e === 'workflow_run',
    (on) => ({
      workflow_run: hintOf([listed('workflows', unionOf(on, 'workflows'))], []),
      'workflow_run.branch': refHint(on, 'branches', 'branchesIgnore', 'branch', 'branches'),
    }),
  ],
  [(e) => e === 'schedule', (on) => ({ cron: cronHint(on) })],
  [
    (e) => e === 'release',
    () => ({ release: hintOf(['required: without a tag, github.ref is unknown'], []) }),
  ],
  [(e) => PATH_FILTER_EVENTS.has(e), (on) => ({ changed: changedHint(on) })],
];

function hintsOf(outline: Outline, event: string, focus: string | undefined): Hints {
  const on = listenersOf(outline, event, focus);
  const hints: Hints = { event: hintOf([eventHint(outline, event)], []) };
  const action = actionHint(outline, event);
  if (action) hints.action = action;
  for (const [applies, make] of EVENT_HINTS) if (applies(event)) Object.assign(hints, make(on));
  return hints;
}

function eventHint(outline: Outline, event: string): string {
  const titles = outline.workflows.filter((w) => w.events.some((e) => e.event === event)).map(titleOf);
  if (titles.length === 0) return `no workflow listens to ${event}`;
  const more = titles.length - 3;
  return `listened to by ${titles.slice(0, 3).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** What the listeners' `types:` say: the types named, and what a listener that names none runs on. */
function actionHint(outline: Outline, event: string): FieldHint | undefined {
  const types = activityTypes(outline, event);
  if (!types) return undefined;
  const { named, narrowed, open } = namedTypes(outline, event);
  if (!narrowed) return hintOf(['no workflow narrows types:, so the default types run'], []);
  const rest = types.custom ? 'any type' : 'the default types';
  return hintOf([listed('types', named), open ? `a workflow without types: runs on ${rest}` : undefined], []);
}

type FilterKey =
  | 'branches'
  | 'branchesIgnore'
  | 'tags'
  | 'tagsIgnore'
  | 'paths'
  | 'pathsIgnore'
  | 'workflows';

/** A ref filter's names as chips; the ignore list, and a negated pattern, as what the ref must not be. */
function refHint(
  on: OutlineEvent[],
  include: FilterKey,
  ignore: FilterKey,
  kind: SampleKind,
  name: string,
): FieldHint {
  const patterns = unionOf(on, include);
  const positive = patterns.filter((p) => !p.startsWith('!'));
  const not = [...patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)), ...unionOf(on, ignore)];
  return hintOf([listed(name, positive), listed('not', not)], chipsOf(positive, kind));
}

function changedHint(on: OutlineEvent[]): FieldHint {
  const paths = unionOf(on, 'paths');
  const ignore = unionOf(on, 'pathsIgnore');
  const chips = chipsOf(
    [...paths, ...ignore].filter((p) => !p.startsWith('!')),
    'path',
  );
  if (paths.length === 0 && ignore.length === 0)
    return hintOf(['no workflow filters paths on this event'], chips);
  return hintOf([listed('paths', paths), listed('paths-ignore', ignore)], chips);
}

function cronHint(on: OutlineEvent[]): FieldHint {
  if (unionOf(on, 'crons').length === 0) return hintOf(['no workflow schedules a cron'], []);
  return hintOf(['a schedule starts the workflows that list this exact cron'], []);
}

const listed = (name: string, items: string[]): string | undefined =>
  items.length ? `${name}: ${items.join(', ')}` : undefined;

function hintOf(parts: (string | undefined)[], chips: Chip[]): FieldHint {
  const text = parts.filter(Boolean).join('; ');
  return text ? { text, chips } : { chips };
}

/** One chip per value: two patterns that sample to the same name offer it once. */
function chipsOf(patterns: string[], kind: SampleKind): Chip[] {
  const seen = new Set<string>();
  const out: Chip[] = [];
  for (const pattern of patterns) {
    const value = sampleOf(pattern, kind);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ pattern, value });
  }
  return out;
}

function unionOf(on: OutlineEvent[], key: FilterKey | 'crons'): string[] {
  return Array.from(new Set(on.flatMap((e) => e[key] ?? [])));
}

/** The event's declarations, the focused workflow's first. */
function listenersOf(outline: Outline, event: string, focus: string | undefined): OutlineEvent[] {
  return byFocus(outline.workflows, focus).flatMap((w) => w.events.filter((e) => e.event === event));
}

function byFocus(workflows: OutlineWorkflow[], focus: string | undefined): OutlineWorkflow[] {
  const at = workflows.findIndex((w) => w.path === focus);
  if (at <= 0) return workflows;
  return [workflows[at]!, ...workflows.slice(0, at), ...workflows.slice(at + 1)];
}

/** A workflow by its `name:`, else its file name. */
const titleOf = (w: OutlineWorkflow): string => w.name ?? w.path.slice(w.path.lastIndexOf('/') + 1);
