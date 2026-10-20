/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import { ACTIVITY_TYPES } from '@simulci/engine';
import type { ReadyResponse } from './protocol';

/**
 * The events `on:` takes that have no activity types in the engine's table, as the workflow parser's schema names
 * them (a test keeps the two equal). Left out: `workflow_call`, which declares an interface rather than an event, and
 * the events GitHub retired (`pull_request_comment`, the classic projects' three).
 */
export const UNTYPED_EVENTS: readonly string[] = [
  'create',
  'delete',
  'deployment',
  'deployment_status',
  'fork',
  'gollum',
  'image_version',
  'page_build',
  'public',
  'push',
  'repository_dispatch',
  'schedule',
  'status',
  'workflow_dispatch',
];

/**
 * Every event `on:` takes, by name, with its activity types and the ones that apply by default: what `ready` sends
 * once, for the triggers editor's Add event.
 */
export function eventTable(): NonNullable<ReadyResponse['events']> {
  const table: NonNullable<ReadyResponse['events']> = { ...ACTIVITY_TYPES };
  for (const event of UNTYPED_EVENTS) table[event] = { types: [], default: [] };
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
}
