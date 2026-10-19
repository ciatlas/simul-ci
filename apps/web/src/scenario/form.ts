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

/**
 * The events whose `github.ref` the engine takes from the pull request (its merge ref, or its base), never from a
 * ref the scenario gives.
 */
export const PULL_REF_EVENTS = new Set([
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'pull_request_review_comment',
]);

/** The events whose `paths` filters the engine applies (never to a tag push). */
const PATH_FILTER_EVENTS = new Set(['push', 'pull_request', 'pull_request_target']);

/** Whether the engine reads the changed files: for every event with `paths` filters but a push of a tag. */
export const readsChangedFiles = (scenario: ScenarioInput): boolean =>
  PATH_FILTER_EVENTS.has(scenario.event) && !(scenario.event === 'push' && pushRef(scenario).kind === 'tag');

/**
 * What survives an event change: the ref and the repository facts; what the event owns is dropped. A pull
 * request runs on a ref of its own, so a tag does not follow into one; a release runs on its tag, so a branch
 * does not follow into one. A fork is a pull request's head, so the actor's `fork` stays with pull requests.
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
  const actor = PR_EVENTS.has(event) ? scenario.actor : actorWith(scenario.actor, 'fork', undefined);
  if (actor === undefined) delete next.actor;
  else next.actor = actor;
  return next as ScenarioInput;
}

/** The kind of ref an event cannot run on: a tag for a pull request, a branch for a release. */
const unusedRefKind = (event: string): RefKind | undefined =>
  PR_EVENTS.has(event) ? 'tag' : event === 'release' ? 'branch' : undefined;

export type RefKind = 'branch' | 'tag';

/**
 * The branch or tag a scenario's ref names, read the way the engine reads `tag`, `branch` and `ref` (a bare
 * name is a branch); no kind when the scenario gives none, or gives a `ref` that is neither (`refs/pull/7/merge`),
 * which only the Ref row under Advanced shows as it is.
 */
export function pushRef(scenario: ScenarioInput): { kind?: RefKind; name: string } {
  if (scenario.tag !== undefined) return { kind: 'tag', name: scenario.tag };
  if (scenario.branch !== undefined) return { kind: 'branch', name: scenario.branch };
  if (scenario.ref === undefined) return { name: '' };
  const ref = scenario.ref.replace(/^refs\//, '');
  if (ref.startsWith('tags/')) return { kind: 'tag', name: ref.slice('tags/'.length) };
  if (ref.startsWith('heads/')) return { kind: 'branch', name: ref.slice('heads/'.length) };
  return isRawRef(scenario.ref) ? { name: '' } : { kind: 'branch', name: ref };
}

/** A ref the engine keeps as it is, not as a branch: anything under `refs/` but heads and tags, or `pull/…`. */
const isRawRef = (ref: string): boolean => ref.startsWith('refs/') || ref.startsWith('pull/');

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
  /** The types some listening workflow runs on: its `types:`, or the event's default types where it names none. */
  allowed: string[];
  /** The rest of the event's types, selectable as a what-if: no listening workflow runs on them. */
  rest: string[];
  /** Some listener narrows `types:`, so the engine needs one. */
  required: boolean;
  /** The types are the workflows' own names (`repository_dispatch`), not a table's: any name is one. */
  custom?: true;
}

/** What the listeners of an event say about its types. */
export interface NamedTypes {
  /** The types the narrowing listeners name, in declaration order. */
  named: string[];
  /** Some listener narrows `types:`. */
  narrowed: boolean;
  /** Some listener names none, so it runs on the event's default types (on any type, for custom ones). */
  open: boolean;
}

export function namedTypes(outline: Outline, event: string): NamedTypes {
  const named = new Set<string>();
  let narrowed = false;
  let open = false;
  for (const e of eventsOf(outline, event)) {
    if (!e.types?.narrowed) {
      open = true;
      continue;
    }
    narrowed = true;
    for (const t of e.types.allowed) named.add(t);
  }
  return { named: Array.from(named), narrowed, open };
}

/**
 * The activity types of an event, as the engine reads them: the types a listening workflow runs on first (its
 * `types:`, or the defaults where it names none), the rest of the table's types after them as a what-if. An event
 * with custom types offers what the listeners name, and nothing when none narrows, since then any type runs.
 */
export function activityTypes(outline: Outline, event: string): ActivityTypes | undefined {
  const table = Object.hasOwn(outline.events, event) ? outline.events[event] : undefined;
  const { named, narrowed, open } = namedTypes(outline, event);
  if (!table) return narrowed ? { allowed: named, rest: [], required: true, custom: true } : undefined;
  const allowed = new Set(named);
  // No listener at all reads like one that names no types.
  if (open || !narrowed) for (const t of table.default) allowed.add(t);
  return {
    allowed: Array.from(allowed),
    rest: table.types.filter((t) => !allowed.has(t)),
    required: narrowed,
  };
}

/** The scenario's action when it is none of the types offered, so the form can show it as it is. */
export function strayAction(types: ActivityTypes, action: string | undefined): string | undefined {
  if (action === undefined || types.allowed.includes(action) || types.rest.includes(action)) return undefined;
  return action;
}

/**
 * What the select says beside a type no listener runs on, and beside an action that is none of the event's types (a
 * custom type no listener names shows in a box of its own instead).
 */
export function activityNotes(types: ActivityTypes, event: string): { rest: string; stray: string } {
  return { rest: types.required ? 'not in types:' : 'not a default type', stray: `not a type of ${event}` };
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

/** The inputs with one set or cleared; own keys only, so an input named `__proto__` stays an input. */
export function withInput(
  inputs: ScenarioInput['inputs'],
  name: string,
  value: string | boolean | number | undefined,
): ScenarioInput['inputs'] {
  const next = new Map(Object.entries(inputs ?? {}));
  if (value === undefined) next.delete(name);
  else next.set(name, value);
  return next.size ? Object.fromEntries(next) : undefined;
}

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

/** A choice input's value as the engine reads it, a boolean or a number as its text; empty when it gives none. */
export const choiceValue = (value: unknown): string => (value === undefined ? '' : jsonText(value));

/** The scenario's value when it is none of the options offered, so a select can show it as it is. */
export function stray(options: readonly string[], value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || options.includes(value)) return undefined;
  return value;
}

/** The Merged select's value: the scenario's `merged` as text, empty while it is unknown. */
export const mergedValue = (merged: unknown): string => (typeof merged === 'boolean' ? String(merged) : '');

/** What the Merged select writes: unknown sends no `merged`, which the engine reads as unknown, not as false. */
export const mergedPatch = (value: string): boolean | undefined =>
  value === '' ? undefined : value === 'true';

type Actor = NonNullable<ScenarioInput['actor']>;

/**
 * The actor with one fact changed and the rest kept; a default (`false`, an empty login) drops its key, and an
 * actor left with no key goes too.
 */
export function actorWith(
  actor: ScenarioInput['actor'],
  key: keyof Actor,
  value: string | boolean | undefined,
): ScenarioInput['actor'] {
  const next: Record<string, unknown> = { ...actor };
  if (value === undefined || value === false || value === '') delete next[key];
  else next[key] = value;
  return Object.keys(next).length ? next : undefined;
}

/** The keys under Advanced besides the actor's. */
const ADVANCED_KEYS = [
  'ref',
  'sha',
  'defaultBranch',
  'repository',
  'vars',
  'secrets',
  'environments',
  'platform',
] as const;

/**
 * Whether the scenario sets a key the Advanced rows show: an empty record or list sets nothing. The fork is a row
 * there only for an event that is no pull request, which shows it with its own fields.
 */
export function advancedSet(scenario: ScenarioInput): boolean {
  const { actor } = scenario;
  if (actor?.login !== undefined || actor?.bot !== undefined) return true;
  if (strayFork(scenario)) return true;
  return ADVANCED_KEYS.some((key) => isSet(scenario[key]));
}

/** A fork on an event that is no pull request: a link can set one, and the engine still reads it. */
export const strayFork = (scenario: ScenarioInput): boolean =>
  scenario.actor?.fork !== undefined && !PR_EVENTS.has(scenario.event);

/** What Advanced has seen: whether a key is set, and the last refusal of one of its rows. */
export interface AdvancedSeen {
  set: boolean;
  refusal: string;
}

/**
 * What Advanced has seen after a render, and whether the render opens it: a key newly set (a pin, a link), or a
 * refusal it has not shown yet. A refusal the author already saw does not reopen what they closed; it comes back
 * after every edit, since an edit clears the refusal until the worker answers.
 */
export function advancedSeen(
  prev: AdvancedSeen,
  set: boolean,
  refusal: string,
): { seen: AdvancedSeen; opens: boolean } {
  const fresh = refusal !== '' && refusal !== prev.refusal;
  return { seen: { set, refusal: refusal || prev.refusal }, opens: (set && !prev.set) || fresh };
}

function isSet(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'object' || value === null) return true;
  return Object.keys(value).length > 0;
}

/** The triggering run with its branch set, or without one when the branch is emptied. */
export function withRunBranch(run: WorkflowRun, branch: string): WorkflowRun {
  const next = { ...run };
  if (branch === '') delete next.branch;
  else next.branch = branch;
  return next;
}

/** The commit-message markers that skip `push` and `pull_request` runs; a test holds this list to the engine's. */
export const SKIP_MARKERS = [
  '[skip ci]',
  '[ci skip]',
  '[no ci]',
  '[skip actions]',
  '[actions skip]',
] as const;
const SKIP_TRAILER = /^skip-checks: ?true$/m;
const SKIP_TRAILER_LINE = /^skip-checks: ?true$\n?/gm;

/** Whether the engine reads a skip in the message: a marker anywhere, or the `skip-checks` trailer line. */
export const skipsCi = (message: string | undefined): boolean =>
  message !== undefined && (SKIP_MARKERS.some((m) => message.includes(m)) || SKIP_TRAILER.test(message));

/**
 * The message with a skip or without one: on, `[skip ci]` ends the subject line; off, every marker and the trailer
 * go. A message left empty goes too.
 */
export function withSkipCi(message: string | undefined, on: boolean): string | undefined {
  if (on) return skipsCi(message) ? message : withMarker(message ?? '');
  if (message === undefined || !skipsCi(message)) return message;
  let out = message;
  for (const m of SKIP_MARKERS) out = out.split(` ${m}`).join('').split(m).join('');
  out = out.replace(SKIP_TRAILER_LINE, '').trimEnd();
  return out === '' ? undefined : out;
}

function withMarker(message: string): string {
  const [subject = '', ...body] = message.split('\n');
  const head = subject.trimEnd();
  return [head ? `${head} [skip ci]` : '[skip ci]', ...body].join('\n');
}
