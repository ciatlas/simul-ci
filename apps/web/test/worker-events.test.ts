/**
 * The event table the engine worker's `ready` sends once (synthesis § 8.3): every event `on:` takes with its activity
 * types, which the triggers editor's Add event offers. The events are the workflow parser's own list, less the ones
 * the editor leaves out.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventTable, UNTYPED_EVENTS } from '../src/worker/events';

/** The events the parser's schema accepts under `on:` (`on-mapping-strict`), read from the engine's dependency. */
function schemaEvents(): string[] {
  const schema = join(
    import.meta.dirname,
    '../../../packages/engine/node_modules/@actions/workflow-parser/dist/workflow-v1.0.min.json',
  );
  const { definitions } = JSON.parse(readFileSync(schema, 'utf8')) as {
    definitions: Record<string, { mapping?: { properties: Record<string, unknown> } }>;
  };
  return Object.keys(definitions['on-mapping-strict']!.mapping!.properties);
}

describe('the event table', () => {
  it('holds each event’s activity types and its defaults, by name', () => {
    const events = eventTable();
    expect(events.pull_request).toEqual({
      types: expect.arrayContaining(['opened', 'labeled', 'closed']),
      default: ['opened', 'synchronize', 'reopened'],
    });
    expect(events.push).toEqual({ types: [], default: [] });
    expect(Object.keys(events)).toEqual(Object.keys(events).sort());
  });

  it('offers every event the workflow parser accepts but an interface and the retired ones', () => {
    const left = new Set([
      'workflow_call',
      'pull_request_comment',
      'project',
      'project_card',
      'project_column',
    ]);
    expect(Object.keys(eventTable()).sort()).toEqual(
      schemaEvents()
        .filter((e) => !left.has(e))
        .sort(),
    );
    expect(UNTYPED_EVENTS).toEqual([...UNTYPED_EVENTS].sort());
  });
});
