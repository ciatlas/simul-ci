import { readFileSync } from 'node:fs';
import {
  ACTIVITY_TYPES,
  matchTrigger,
  parseScenario,
  readSettings,
  type ScenarioInput,
  skipMarker,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const fixture = (name: string): Record<string, unknown> =>
  parse(readFileSync(new URL(`../../../fixtures/triggers/${name}.yml`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

/** Builds `on:` from a fixture case's filter keys and matches it against the scenario the case describes. */
function verdictFor(c: Record<string, unknown>, event: string, scenario: ScenarioInput): string {
  const filters: Record<string, unknown> = {};
  for (const key of [
    'branches',
    'branches-ignore',
    'tags',
    'tags-ignore',
    'paths',
    'paths-ignore',
    'types',
    'workflows',
  ]) {
    if (key in c) filters[key] = c[key];
  }
  if ('patterns' in c && typeof c.filter === 'string') filters[c.filter] = c.patterns;
  const body =
    event === 'schedule'
      ? "  schedule:\n    - cron: '0 0 * * *'"
      : `  ${event}:${Object.keys(filters).length ? '' : ' {}'}\n${Object.entries(filters)
          .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
          .join('\n')}`;
  const yaml = `on:\n${body}\njobs: {}\n`;
  const settings = readSettings('.github/workflows/w.yml', yaml);
  expect(settings.errors, yaml).toEqual([]);
  return matchTrigger(settings.events, parseScenario(scenario)).decision.verdict;
}

/** The scenario a fixture case describes: its ref, base (or merge-group target), head and changed files. */
function scenarioOf(c: Record<string, unknown>): ScenarioInput {
  const base = c.base ?? c.target;
  const scenario: ScenarioInput = { event: c.event as string, ...given(c, 'ref'), ...given(c, 'head') };
  if (typeof base === 'string') scenario.base = base;
  // A branch filter case with a path filter attached needs some changed file that matches it.
  if (Array.isArray(c.changed)) scenario.changed = c.changed as string[];
  else if (Array.isArray(c.paths) || Array.isArray(c['paths-ignore'])) scenario.changed = ['src/a.js'];
  if (c.event === 'pull_request' && Array.isArray(c.types)) scenario.action = (c.types as string[])[0];
  return scenario;
}

const given = (c: Record<string, unknown>, key: 'ref' | 'head'): Partial<ScenarioInput> =>
  typeof c[key] === 'string' ? { [key]: c[key] } : {};

const cases = (section: unknown): Record<string, unknown>[] =>
  (section as { cases?: Record<string, unknown>[] }[]).flatMap((r) => r.cases ?? []);

describe('activity types', () => {
  it('equals the docs-derived table in fixtures/triggers/types-defaults.yml', () => {
    const table = fixture('types-defaults').table as Record<string, { types: unknown; default: unknown }>;
    const expected = Object.fromEntries(
      Object.entries(table)
        .filter(([, v]) => Array.isArray(v.types))
        .map(([event, v]) => [event, { types: v.types, default: v.default }]),
    );
    expect(ACTIVITY_TYPES).toEqual(expected);
  });

  it('defaults pull_request to opened, synchronize and reopened, and most events to every type', () => {
    const pr = readSettings('w.yml', 'on: pull_request\njobs: {}\n').events;
    expect(
      matchTrigger(pr, parseScenario({ event: 'pull_request', action: 'opened' })).decision.verdict,
    ).toBe('yes');
    expect(
      matchTrigger(pr, parseScenario({ event: 'pull_request', action: 'labeled' })).decision.verdict,
    ).toBe('no');
    const issues = readSettings('w.yml', 'on: issues\njobs: {}\n').events;
    expect(matchTrigger(issues, parseScenario({ event: 'issues', action: 'labeled' })).decision.verdict).toBe(
      'yes',
    );
    const narrowed = readSettings('w.yml', 'on:\n  issues:\n    types: [opened]\njobs: {}\n').events;
    expect(
      matchTrigger(narrowed, parseScenario({ event: 'issues', action: 'labeled' })).decision.verdict,
    ).toBe('no');
  });

  it('assumes a default activity when none is given, unless types: narrows them', () => {
    const pr = readSettings('w.yml', 'on: pull_request\njobs: {}\n').events;
    expect(matchTrigger(pr, parseScenario({ event: 'pull_request' })).decision.verdict).toBe('yes');
    const narrowed = readSettings('w.yml', 'on:\n  pull_request:\n    types: [labeled]\njobs: {}\n').events;
    const m = matchTrigger(narrowed, parseScenario({ event: 'pull_request' }));
    expect(m.decision.verdict).toBe('maybe');
    expect(m.unknowns).toEqual([
      {
        id: 'scenario.action',
        kind: 'event',
        reads: [],
        affects: [],
        pin: { layer: 'scenario', fragment: { action: 'labeled' }, at: ['when'] },
      },
    ]);
  });

  it('replays the workflow_run type cases', () => {
    for (const c of cases(fixture('workflow-run').types)) {
      if (c.rerun) continue;
      const types = c.types === null ? {} : { types: c.types };
      const v = verdictFor(types, 'workflow_run', {
        event: 'workflow_run',
        action: c.activity as string,
        workflow_run: { name: 'x' },
      });
      expect(v, JSON.stringify(c)).toBe(c.runs ? 'yes' : 'no');
    }
  });
});

describe('filters from fixtures/triggers/filters.yml', () => {
  const filters = fixture('filters');

  it('replays the push, pull_request and merge_group cases', () => {
    const all = [
      ...cases(filters.refs_prefix_handling),
      ...cases(filters.combining_filters),
      ...cases(filters.ordered_negation),
    ];
    const replayable = all.filter(
      (c) => typeof c.event === 'string' && ('runs' in c || 'matches' in c) && !('commit_count' in c),
    );
    for (const c of replayable) {
      const expected = (c.runs ?? c.matches) ? 'yes' : 'no';
      expect(verdictFor(c, c.event as string, scenarioOf(c)), JSON.stringify(c)).toBe(expected);
    }
    expect(replayable.length).toBeGreaterThan(30);
  });

  it('replays the paths aggregation cases on a push', () => {
    for (const c of cases(filters.paths_aggregation)) {
      if (typeof c.filter !== 'string' || 'commit_count' in c) continue;
      const scenario: ScenarioInput = { event: 'push', changed: c.changed as string[] };
      if (typeof c.ref === 'string') scenario.ref = c.ref;
      expect(verdictFor(c, 'push', scenario), JSON.stringify(c)).toBe(c.runs ? 'yes' : 'no');
    }
  });

  it('replays the workflow_run branch cases', () => {
    for (const c of [...cases(filters.workflow_run_branches), ...cases(fixture('workflow-run').branches)]) {
      if (!('runs' in c) || 'valid' in c) continue;
      const scenario: ScenarioInput = {
        event: 'workflow_run',
        action: 'requested',
        workflow_run: { name: 'Build', branch: c.triggering_branch as string },
      };
      expect(verdictFor(c, 'workflow_run', scenario), JSON.stringify(c)).toBe(c.runs ? 'yes' : 'no');
    }
  });

  it('replays the workflows name cases', () => {
    for (const c of cases(fixture('workflow-run').workflows)) {
      if (!('runs' in c) || typeof c.triggering_workflow_name !== 'string') continue;
      const scenario: ScenarioInput = {
        event: 'workflow_run',
        action: 'completed',
        workflow_run: { name: c.triggering_workflow_name },
      };
      expect(verdictFor(c, 'workflow_run', scenario), JSON.stringify(c)).toBe(c.runs ? 'yes' : 'no');
    }
  });

  it('cannot decide a path filter without the changed files, and names the pin', () => {
    const events = readSettings('w.yml', 'on:\n  push:\n    paths: [src/**]\njobs: {}\n').events;
    const m = matchTrigger(events, parseScenario({ event: 'push' }));
    expect(m.decision.verdict).toBe('maybe');
    expect(m.unknowns[0]).toMatchObject({
      id: 'scenario.changed',
      kind: 'changed-files',
      pin: { layer: 'scenario', fragment: { changed: ['src/**'] } },
    });
    expect(matchTrigger(events, parseScenario({ event: 'push', tag: 'v1' })).decision.verdict).toBe('yes');
  });
});

describe('skip markers and schedules', () => {
  it('replays the skip-ci cases', () => {
    const skip = fixture('skip-ci');
    for (const c of cases(skip.markers)) {
      if (c.skipped === 'UNVERIFIED') continue;
      expect(skipMarker(c.message as string) !== undefined, JSON.stringify(c)).toBe(c.skipped);
    }
    for (const c of cases(skip.events_honouring)) {
      if (!('skipped' in c)) continue;
      const message = (c.head_commit_message ?? c.pr_head_commit_message) as string;
      const scenario: ScenarioInput = { event: c.event as string, message };
      if (c.event === 'workflow_run') scenario.workflow_run = { name: 'x' };
      expect(verdictFor({}, c.event as string, scenario), JSON.stringify(c)).toBe(c.skipped ? 'no' : 'yes');
    }
  });

  it('matches a schedule by cron when the scenario names one', () => {
    const events = readSettings('w.yml', "on:\n  schedule:\n    - cron: '0 6 * * 1'\njobs: {}\n").events;
    expect(matchTrigger(events, parseScenario({ event: 'schedule' })).decision.verdict).toBe('yes');
    expect(
      matchTrigger(events, parseScenario({ event: 'schedule', cron: '0 6 * * 1' })).decision.verdict,
    ).toBe('yes');
    const m = matchTrigger(events, parseScenario({ event: 'schedule', cron: '0 0 * * *' }));
    expect(m.decision).toEqual({
      verdict: 'no',
      chain: [
        { kind: 'event', event: 'schedule', listens: true },
        { kind: 'schedule', crons: ['0 6 * * 1'], cron: '0 0 * * *', matched: false },
      ],
    });
  });

  it('does not listen to events the workflow lacks', () => {
    const events = readSettings('w.yml', 'on: [push]\njobs: {}\n').events;
    expect(matchTrigger(events, parseScenario({ event: 'pull_request' })).decision).toEqual({
      verdict: 'no',
      chain: [{ kind: 'event', event: 'pull_request', listens: false }],
    });
  });
});
