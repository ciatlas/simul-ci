import type { ScenarioInput } from '@simulci/engine';
import type { Outline, OutlineInput } from '../worker/protocol';

/** What the scenario form derives from the outline: pure, so the components stay thin. */

export const PR_EVENTS = new Set([
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'pull_request_review_comment',
  'merge_group',
]);

/** The events whose `paths` filters the engine applies (never to a tag push). */
const PATH_FILTER_EVENTS = new Set(['push', 'pull_request', 'pull_request_target']);

/** Whether the engine reads the changed files: for every event with `paths` filters but a push of a tag. */
export const readsChangedFiles = (scenario: ScenarioInput): boolean =>
  PATH_FILTER_EVENTS.has(scenario.event) && !(scenario.event === 'push' && pushRef(scenario).kind === 'tag');

/**
 * What survives an event change: the ref and the repository facts; what the event owns is dropped. A pull
 * request runs on a ref of its own, so a tag does not follow into one; a release runs on its tag, so a branch
 * does not follow into one.
 */
const KEPT_ON_EVENT_CHANGE: (keyof ScenarioInput)[] = [
  'ref',
  'branch',
  'tag',
  'base',
  'head',
  'number',
  'changed',
  'message',
  'actor',
  'sha',
  'defaultBranch',
  'repository',
  'vars',
  'secrets',
  'environments',
  'platform',
];

export function withEvent(scenario: ScenarioInput, event: string): ScenarioInput {
  if (event === scenario.event) return scenario;
  const next: Record<string, unknown> = { event };
  for (const key of KEPT_ON_EVENT_CHANGE) if (scenario[key] !== undefined) next[key] = scenario[key];
  const unused = unusedRefKind(event);
  if (unused !== undefined && pushRef(scenario).kind === unused) {
    delete next[unused];
    delete next.ref;
  }
  return next as ScenarioInput;
}

/** The kind of ref an event cannot run on: a tag for a pull request, a branch for a release. */
const unusedRefKind = (event: string): RefKind | undefined =>
  PR_EVENTS.has(event) ? 'tag' : event === 'release' ? 'branch' : undefined;

export type RefKind = 'branch' | 'tag';

/**
 * The branch or tag a scenario's ref names, read the way the engine reads `tag`, `branch` and `ref` (a bare
 * name is a branch); no kind when the scenario gives none.
 */
export function pushRef(scenario: ScenarioInput): { kind?: RefKind; name: string } {
  if (scenario.tag !== undefined) return { kind: 'tag', name: scenario.tag };
  if (scenario.branch !== undefined) return { kind: 'branch', name: scenario.branch };
  if (scenario.ref === undefined) return { name: '' };
  const ref = scenario.ref.replace(/^refs\//, '');
  if (ref.startsWith('tags/')) return { kind: 'tag', name: ref.slice('tags/'.length) };
  return { kind: 'branch', name: ref.replace(/^heads\//, '') };
}

/** The tag a release runs on, given as `tag` or as a `ref` that names one; empty when it gives none. */
export function releaseTag(scenario: ScenarioInput): string {
  const named = pushRef(scenario);
  return named.kind === 'tag' ? named.name : '';
}

/** The patch that makes the scenario's ref the branch or the tag named: `ref` and the other kind go. */
export function refPatch(kind: RefKind, name: string): Partial<ScenarioInput> {
  const value = name === '' ? undefined : name;
  return {
    ref: undefined,
    branch: kind === 'branch' ? value : undefined,
    tag: kind === 'tag' ? value : undefined,
  };
}

export interface ActivityTypes {
  /** What the listening workflows allow (or every type, when none narrows). */
  allowed: string[];
  /** The rest of the event's types, selectable as a what-if. */
  rest: string[];
  /** Some listener narrows `types:`, so the engine needs one. */
  required: boolean;
}

/** The activity types of an event: what listening workflows allow first, the rest selectable as a what-if. */
export function activityTypes(outline: Outline, event: string): ActivityTypes | undefined {
  if (!Object.hasOwn(outline.events, event)) return undefined;
  const table = outline.events[event]!;
  const allowed = new Set<string>();
  let required = false;
  for (const e of eventsOf(outline, event)) {
    if (!e.types?.narrowed) continue;
    required = true;
    for (const t of e.types.allowed) allowed.add(t);
  }
  if (!required) return { allowed: table.types, rest: [], required };
  return { allowed: Array.from(allowed), rest: table.types.filter((t) => !allowed.has(t)), required };
}

/** The scenario's action when it is none of the types offered, so the form can show it as it is. */
export function strayAction(types: ActivityTypes, action: string | undefined): string | undefined {
  if (action === undefined || types.allowed.includes(action) || types.rest.includes(action)) return undefined;
  return action;
}

function* eventsOf(
  outline: Outline,
  event: string,
): Generator<Outline['workflows'][number]['events'][number]> {
  for (const w of outline.workflows) for (const e of w.events) if (e.event === event) yield e;
}

/** The dispatch inputs of every workflow, by name, the first declaration winning. */
export function dispatchInputs(outline: Outline): OutlineInput[] {
  const seen = new Map<string, OutlineInput>();
  for (const w of outline.workflows)
    for (const i of w.dispatch ?? []) if (!seen.has(i.name)) seen.set(i.name, i);
  return Array.from(seen.values());
}

/** The value the scenario gives a dispatch input; own keys only, so `constructor` reads nothing inherited. */
export const inputValue = (
  inputs: ScenarioInput['inputs'],
  name: string,
): string | boolean | number | undefined =>
  inputs !== undefined && Object.hasOwn(inputs, name) ? inputs[name] : undefined;

/** A boolean input's value as the engine coerces it: `true` and the string `'true'`, nothing else. */
export const asBoolean = (value: unknown): boolean => value === true || value === 'true';

export function crons(outline: Outline): string[] {
  const out = new Set<string>();
  for (const e of eventsOf(outline, 'schedule')) for (const c of e.crons ?? []) out.add(c);
  return Array.from(out);
}

/** The names `workflow_run` can be about: the `workflows:` patterns and every workflow's `name:`. */
export function workflowNames(outline: Outline): string[] {
  const out = new Set<string>();
  for (const e of eventsOf(outline, 'workflow_run')) for (const n of e.workflows ?? []) out.add(n);
  for (const w of outline.workflows) if (w.name) out.add(w.name);
  return Array.from(out);
}

export const CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped'] as const;
export type Conclusion = (typeof CONCLUSIONS)[number];

type WorkflowRun = NonNullable<ScenarioInput['workflow_run']>;

/** The triggering run once the author names its workflow; a conclusion chosen before the name joins it. */
export function runNamed(
  run: ScenarioInput['workflow_run'],
  name: string,
  chosen: Conclusion | undefined,
): WorkflowRun {
  const conclusion = run ? run.conclusion : chosen;
  return conclusion === undefined ? { ...run, name } : { ...run, name, conclusion };
}

/** The conclusion the form shows: a named run's own (the engine's default is success), else the one chosen. */
export const runConclusion = (
  run: ScenarioInput['workflow_run'],
  chosen: Conclusion | undefined,
): Conclusion => (run ? run.conclusion : chosen) ?? 'success';

/** The `paths` and `paths-ignore` patterns an event's listeners use. */
export function pathPatterns(outline: Outline, event: string): string[] {
  const out = new Set<string>();
  for (const e of eventsOf(outline, event))
    for (const p of [...(e.paths ?? []), ...(e.pathsIgnore ?? [])]) out.add(p);
  return Array.from(out);
}

type Status = 'added' | 'modified' | 'removed' | 'renamed';
const STATUS = /^(.*?)\s+\((added|modified|removed|renamed)(?:\s+from\s+(.+?))?\)$/;

/** `path`, or `path (added)`, or `path (renamed from old)`, one per line; nothing when no line holds a path. */
export function parseChanged(text: string): ScenarioInput['changed'] | undefined {
  const out: NonNullable<ScenarioInput['changed']> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = STATUS.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const entry: { path: string; status: Status; from?: string } = { path: m[1]!, status: m[2] as Status };
    if (m[3]) entry.from = m[3];
    out.push(entry);
  }
  return out.length ? out : undefined;
}

/** The lines of the changed files; an entry of the wrong shape (a URL's) shows as its JSON, to be fixed. */
export function changedText(changed: unknown): string {
  if (!Array.isArray(changed)) return '';
  return changed.map(changedLine).join('\n');
}

function changedLine(c: unknown): string {
  if (typeof c === 'string') return c;
  const entry = c as { path?: unknown; status?: unknown; from?: unknown } | null;
  if (typeof entry?.path !== 'string') return JSON.stringify(c) ?? String(c);
  if (entry.status === undefined) return entry.path;
  return `${entry.path} (${jsonText(entry.status)}${entry.from ? ` from ${jsonText(entry.from)}` : ''})`;
}

/** Whether the text spells the changed files the scenario holds, so the author's spacing can stay. */
export const sameChanged = (text: string, changed: unknown): boolean =>
  JSON.stringify(parseChanged(text) ?? null) === JSON.stringify(changed ?? null);

export const jsonText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);
