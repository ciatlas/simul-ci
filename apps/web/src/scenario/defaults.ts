import type { ScenarioInput } from '@simulci/engine';
import type { Outline, OutlineEvent, OutlineWorkflow } from '../worker/protocol';

/**
 * The first scenario after a load, when the URL brought none: the first workflow's first event with the first
 * literal filter pattern, every chosen field marked as assumed so the form shows it was chosen for the author.
 */

export interface DefaultScenario {
  scenario: ScenarioInput;
  assumed: string[];
  focus?: string;
}

const PR_EVENTS = new Set([
  'pull_request',
  'pull_request_target',
  'pull_request_review',
  'pull_request_review_comment',
  'merge_group',
]);

/** A filter pattern that is itself a name: no glob characters. */
export const isLiteral = (pattern: string): boolean => !/[*?[\]+!]/.test(pattern);

const firstLiteral = (patterns: string[] | undefined): string | undefined => patterns?.find(isLiteral);

export function defaultScenario(outline: Outline, defaultBranch = 'main'): DefaultScenario {
  const workflow = outline.workflows.find((w) => !w.callable && w.events.length > 0);
  if (!workflow) return { scenario: { event: 'push' }, assumed: ['event'] };
  const event = workflow.events[0]!;
  const scenario: ScenarioInput = { event: event.event };
  const assumed = ['event'];
  const add = (key: keyof ScenarioInput, value: string | undefined): void => {
    if (value === undefined) return;
    (scenario as unknown as Record<string, unknown>)[key] = value;
    assumed.push(key);
  };
  if (event.event === 'push') {
    const branch = firstLiteral(event.branches);
    const tag = firstLiteral(event.tags);
    if (branch !== undefined || !event.tags?.length) add('branch', branch ?? defaultBranch);
    else add('tag', tag ?? 'v1.0.0');
  } else if (PR_EVENTS.has(event.event)) {
    add('base', firstLiteral(event.branches) ?? defaultBranch);
  } else if (event.event === 'schedule') {
    add('cron', event.crons?.[0]);
  } else if (event.event === 'workflow_run') {
    add('workflow_run', undefined);
    const name = event.workflows?.[0];
    if (name !== undefined) {
      scenario.workflow_run = { name };
      assumed.push('workflow_run');
    }
  }
  if (event.types?.narrowed) add('action', event.types.allowed[0]);
  return { scenario, assumed: Array.from(new Set(assumed)), focus: workflow.path };
}

/** The events the form offers: the focused workflow's first, then every other event a workflow listens to. */
export function eventChoices(
  outline: Outline,
  focus: string | undefined,
): { event: string; listeners: number; focused: boolean }[] {
  const counts = new Map<string, number>();
  const listens = (w: OutlineWorkflow): OutlineEvent[] => w.events;
  for (const w of outline.workflows)
    for (const e of listens(w)) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
  const focused = outline.workflows.find((w) => w.path === focus);
  const out: { event: string; listeners: number; focused: boolean }[] = [];
  const seen = new Set<string>();
  for (const e of focused?.events ?? []) {
    seen.add(e.event);
    out.push({ event: e.event, listeners: counts.get(e.event) ?? 0, focused: true });
  }
  for (const [event, listeners] of counts)
    if (!seen.has(event)) out.push({ event, listeners, focused: false });
  if (!counts.has('workflow_dispatch'))
    out.push({ event: 'workflow_dispatch', listeners: 0, focused: false });
  return out;
}
