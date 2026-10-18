import { loadFiles, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { scenarioLabel, summarize } from '../src/plan/summary';
import { defaultScenario, eventChoices, isLiteral } from '../src/scenario/defaults';
import type { Outline } from '../src/worker/protocol';

const outline = (events: Outline['workflows'][number]['events'], more: Partial<Outline> = {}): Outline => ({
  files: [],
  workflows: [
    { path: '.github/workflows/lib.yml', callable: true, events: [], jobs: [], onLine: 1 },
    { path: '.github/workflows/ci.yml', callable: false, events, jobs: [], onLine: 1 },
    {
      path: '.github/workflows/release.yml',
      callable: false,
      events: [{ event: 'push', tags: ['v*'] }, { event: 'workflow_dispatch' }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: {},
  ...more,
});

describe('the first scenario', () => {
  it('takes the first workflow with events, its first event and the first literal filter', () => {
    expect(defaultScenario(outline([{ event: 'push', branches: ['release/**', 'main'] }]))).toEqual({
      scenario: { event: 'push', branch: 'main' },
      assumed: ['event', 'branch'],
      focus: '.github/workflows/ci.yml',
    });
    expect(defaultScenario(outline([{ event: 'push', branches: ['release/**'] }]), 'trunk').scenario).toEqual(
      {
        event: 'push',
        branch: 'trunk',
      },
    );
    expect(defaultScenario(outline([{ event: 'push', tags: ['v1.0', 'v*'] }])).scenario).toEqual({
      event: 'push',
      tag: 'v1.0',
    });
    expect(defaultScenario(outline([{ event: 'push', tags: ['v*'] }])).scenario).toEqual({
      event: 'push',
      tag: 'v1.0.0',
    });
  });

  it('knows what each event needs', () => {
    expect(defaultScenario(outline([{ event: 'pull_request', branches: ['main'] }])).scenario).toEqual({
      event: 'pull_request',
      base: 'main',
    });
    expect(
      defaultScenario(
        outline([
          {
            event: 'pull_request',
            types: { allowed: ['labeled'], all: ['opened', 'labeled'], narrowed: true },
          },
        ]),
      ).scenario,
    ).toEqual({ event: 'pull_request', base: 'main', action: 'labeled' });
    expect(defaultScenario(outline([{ event: 'schedule', crons: ['0 6 * * 1'] }])).scenario).toEqual({
      event: 'schedule',
      cron: '0 6 * * 1',
    });
    expect(defaultScenario(outline([{ event: 'workflow_run', workflows: ['CI'] }])).scenario).toEqual({
      event: 'workflow_run',
      workflow_run: { name: 'CI' },
    });
    expect(defaultScenario(outline([{ event: 'release' }])).scenario).toEqual({ event: 'release' });
    expect(defaultScenario({ files: [], workflows: [], events: {} })).toEqual({
      scenario: { event: 'push' },
      assumed: ['event'],
    });
    expect(isLiteral('release/**')).toBe(false);
    expect(isLiteral('release-1')).toBe(true);
  });

  it("offers the focused workflow's events first, then the others, then a dispatch", () => {
    const o = outline([{ event: 'pull_request' }, { event: 'push', branches: ['main'] }]);
    expect(eventChoices(o, '.github/workflows/ci.yml')).toEqual([
      { event: 'pull_request', listeners: 1, focused: true },
      { event: 'push', listeners: 2, focused: true },
      { event: 'workflow_dispatch', listeners: 1, focused: false },
    ]);
    expect(eventChoices(o, undefined).map((c) => c.event)).toEqual([
      'pull_request',
      'push',
      'workflow_dispatch',
    ]);
    const none = eventChoices({ files: [], workflows: [], events: {} }, undefined);
    expect(none).toEqual([{ event: 'workflow_dispatch', listeners: 0, focused: false }]);
  });
});

describe('the status sentence', () => {
  const project = loadFiles({
    '.github/workflows/ci.yml': `on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps: [{ run: npm test }]
  deploy:
    needs: test
    if: github.event_name == 'push' && vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: ./deploy }]
`,
    '.github/workflows/docs.yml':
      'on:\n  push:\n    paths: [docs/**]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: make }]\n',
  });

  it('counts workflows, jobs and unknowns', () => {
    const plan = simulate({
      project,
      scenario: { event: 'push', branch: 'main' },
      assume: [],
      detail: 'steps',
    });
    const s = summarize(plan);
    expect(s.workflows).toEqual({ yes: 1, no: 0, maybe: 1 });
    expect(s.jobs.yes).toBe(1);
    expect(s.sentence).toMatch(/^push to main: 1 of 2 workflows triggered; 1 might; 1 job run, /);
    const pr = simulate({
      project,
      scenario: { event: 'pull_request', base: 'main', head: 'x', number: 3 },
      assume: [],
      detail: 'steps',
    });
    expect(summarize(pr).sentence).toMatch(
      /^pull_request to main: 1 of 2 workflows triggered; 1 job run, 1 skipped/,
    );
  });

  it('labels a scenario by event, action and ref', () => {
    const tag = simulate({ project, scenario: { event: 'push', tag: 'v1' }, assume: [], detail: 'legs' });
    expect(scenarioLabel(tag)).toBe('push of tag v1');
    const cron = simulate({
      project,
      scenario: { event: 'schedule', cron: '0 6 * * 1' },
      assume: [],
      detail: 'legs',
    });
    expect(scenarioLabel(cron)).toBe('schedule 0 6 * * 1');
    const labeled = simulate({
      project,
      scenario: { event: 'pull_request', action: 'labeled', base: 'main', head: 'x', number: 1 },
      assume: [],
      detail: 'legs',
    });
    expect(scenarioLabel(labeled)).toBe('pull_request (labeled) to main');
    const dispatch = simulate({
      project,
      scenario: { event: 'workflow_dispatch', branch: 'main' },
      assume: [],
      detail: 'legs',
    });
    expect(scenarioLabel(dispatch)).toBe('workflow_dispatch to main');
  });
});
