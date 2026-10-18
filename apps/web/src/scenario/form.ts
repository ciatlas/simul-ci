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
export const PATH_FILTER_EVENTS = new Set(['push', 'pull_request', 'pull_request_target']);

/** What survives an event change: the ref and the repository facts; what the event owns is dropped. */
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
  const next: Record<string, unknown> = { event };
  for (const key of KEPT_ON_EVENT_CHANGE) if (scenario[key] !== undefined) next[key] = scenario[key];
  return next as ScenarioInput;
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
  const table = outline.events[event];
  if (!table) return undefined;
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

export function changedText(changed: ScenarioInput['changed']): string {
  if (!changed) return '';
  return changed
    .map((c) => (typeof c === 'string' ? c : `${c.path} (${c.status}${c.from ? ` from ${c.from}` : ''})`))
    .join('\n');
}

export const jsonText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);
