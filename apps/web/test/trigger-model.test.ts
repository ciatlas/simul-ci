/**
 * The triggers editor's rows (synthesis § 4.6): one row per event of `on:` whatever its shape, read from the document;
 * the filters each event reads, its activity types (the defaults until `types:` is written), its schedule and its
 * dispatch inputs; keys the rows do not edit left to the YAML. Each row's check is the plan's trigger reason for the
 * scenario's event, with no matcher on the page; a cron reads in GitHub's words from the Outline, or with the
 * converter's problem.
 */
import { WorkflowDocument } from '@simulci/document';
import type { RunPlan, ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import {
  addableEvents,
  chainOf,
  cronHint,
  defaultOf,
  filterCheck,
  inputOf,
  scheduleCheck,
  triggerModel,
  typesCheck,
} from '../src/edit/triggers/model';
import { handle, initialState } from '../src/worker/handle';
import type { Outline } from '../src/worker/protocol';
import { eventTable } from '../src/worker/events';

const CI = '.github/workflows/ci.yml';
const TABLE = eventTable();

const open = (text: string): WorkflowDocument => WorkflowDocument.open(text, { path: CI, kind: 'workflow' });
const model = (text: string) => triggerModel(open(text), TABLE);

const MAP = `on:
  push:
    branches: [main, 'release/**']
    paths-ignore: docs/**
  pull_request:
    types: [opened]
  pull_request_target:
  workflow_run:
    workflows: [CI]
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'
    - cron: 30 5 * * *
      timezone: Europe/Paris
  workflow_dispatch:
    inputs:
      env:
        description: Where
        type: choice
        options: [staging, prod]
        default: staging
      dry: { type: boolean, required: true }
  repository_dispatch:
jobs:
  a: { runs-on: x, steps: [{ run: a }] }
`;

describe('the trigger rows', () => {
  it('reads one event from on: push, and a list of them from on: [a, b]', () => {
    expect(model('on: push\njobs: {}\n')).toEqual({
      shape: 'scalar',
      rows: [
        {
          event: 'push',
          line: 1,
          filters: [],
          addable: ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore'],
          other: [],
        },
      ],
    });
    const list = model('on:\n  - pull_request\n  - workflow_dispatch\n');
    expect(list.shape).toBe('seq');
    expect(list.rows.map((r) => [r.event, r.line, r.addable.length])).toEqual([
      ['pull_request', 2, 4],
      ['workflow_dispatch', 3, 0],
    ]);
    // Without `types:`, the defaults show, grey.
    expect(list.rows[0]!.types).toEqual({
      written: false,
      values: ['opened', 'synchronize', 'reopened'],
      all: expect.arrayContaining(['labeled', 'closed']),
    });
    expect(list.rows[1]!.inputs).toEqual([]);
  });

  it('reads a map of events: filters, types, schedule, dispatch inputs, and the keys it leaves to the YAML', () => {
    const { shape, rows } = model(MAP);
    expect(shape).toBe('map');
    const [push, pr, target, run, schedule, dispatch, repository] = rows;
    expect(push).toMatchObject({
      line: 2,
      filters: [
        { key: 'branches', patterns: ['main', 'release/**'], line: 3 },
        { key: 'paths-ignore', patterns: ['docs/**'], line: 4 },
      ],
      addable: ['branches-ignore', 'tags', 'tags-ignore', 'paths'],
    });
    expect(pr!.types).toMatchObject({ written: true, values: ['opened'] });
    expect(target).toMatchObject({ event: 'pull_request_target', filters: [], other: [] });
    expect(run).toMatchObject({
      filters: [{ key: 'branches', patterns: ['main'], line: 10 }],
      addable: ['branches-ignore'],
      other: [{ key: 'workflows', line: 9 }],
    });
    expect(schedule!.crons).toEqual([
      { cron: '0 6 * * 1', line: 12 },
      { cron: '30 5 * * *', timezone: 'Europe/Paris', line: 13 },
    ]);
    expect(dispatch!.inputs).toEqual([
      {
        name: 'env',
        line: 17,
        input: { description: 'Where', default: 'staging', type: 'choice', options: ['staging', 'prod'] },
      },
      { name: 'dry', line: 22, input: { required: true, type: 'boolean' } },
    ]);
    // Its types are free strings: a row with nothing to default to.
    expect(repository!.types).toEqual({ written: false, values: [], all: [] });
    expect(repository!.filters).toEqual([]);
  });

  it('leaves to the YAML what the rows cannot hold', () => {
    expect(model('jobs: {}\n')).toEqual({ shape: 'none', rows: [] });
    expect(model('on:\njobs: {}\n')).toEqual({ shape: 'none', rows: [] });
    expect(model('on: 3\n')).toEqual({ shape: 'none', rows: [], odd: 1 });
    expect(model('on: [push, { pull_request: {} }]\n')).toEqual({ shape: 'seq', rows: [], odd: 1 });
    const odd = model(
      'on:\n  push: main\n  schedule: daily\n  pull_request:\n    types: opened\n    tags: [v1]\n',
    );
    expect(odd.rows.map((r) => [r.event, r.odd ?? false, r.addable])).toEqual([
      ['push', true, []],
      ['schedule', true, []],
      ['pull_request', false, ['branches', 'branches-ignore', 'paths', 'paths-ignore']],
    ]);
    // A single type reads as a list of one; tags are not a pull request's filter.
    expect(odd.rows[2]!.types).toMatchObject({ written: true, values: ['opened'] });
    expect(odd.rows[2]!.other).toEqual([{ key: 'tags', line: 6 }]);
  });

  it('offers every event of the table the file does not name', () => {
    const offered = addableEvents(model('on: [push, schedule]\n'), TABLE);
    expect(offered).toContain('pull_request');
    expect(offered).toContain('workflow_dispatch');
    expect(offered).not.toContain('push');
    expect(offered).not.toContain('schedule');
    expect(offered).toEqual([...offered].sort());
  });

  it('keeps an input’s keys as the file has them, and types a default by the input’s type', () => {
    expect(inputOf({ type: 'number', default: 3, deprecationMessage: 'x' })).toEqual({
      type: 'number',
      default: 3,
    });
    expect(inputOf(null)).toEqual({});
    expect(defaultOf('boolean', 'true')).toBe(true);
    expect(defaultOf('boolean', 'yes')).toBe('yes');
    expect(defaultOf('number', '-2.5')).toBe(-2.5);
    expect(defaultOf('string', '3')).toBe('3');
    expect(defaultOf(undefined, '  ')).toBeUndefined();
  });
});

/** The Outline and the plan of one workflow under a scenario, as the worker answers them. */
function simulated(text: string, scenario: ScenarioInput): { outline: Outline; plan: RunPlan } {
  const loaded = handle(initialState(), { id: 1, type: 'load', files: { [CI]: text } });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  const r = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (r.response.type !== 'plan') throw new Error(JSON.stringify(r.response));
  return { outline: loaded.response.outline, plan: r.response.plan };
}

const JOBS = 'jobs:\n  a:\n    runs-on: x\n    steps: [{ run: a }]\n';

describe('the rows’ checks', () => {
  it('says whether the ref matches a branch filter, and only for the plan’s own event', () => {
    const text = `on:\n  push:\n    branches: [main]\n    paths: [src/**]\n  pull_request:\n${JOBS}`;
    const { plan } = simulated(text, { event: 'push', branch: 'dev' });
    const chain = chainOf(plan, CI, 'push');
    expect(filterCheck(chain, 'branches')).toEqual({ mark: 'no', text: 'dev matches none' });
    // Changed files not given: the plan leaves it open.
    expect(filterCheck(chain, 'paths')).toEqual({ mark: 'maybe', text: 'changed files not given' });
    expect(filterCheck(chain, 'tags')).toBeUndefined();
    expect(chainOf(plan, CI, 'pull_request')).toBeUndefined();
    expect(chainOf(plan, '.github/workflows/other.yml', 'push')).toBeUndefined();
    const main = chainOf(
      simulated(text, { event: 'push', branch: 'main', changed: ['README.md'] }).plan,
      CI,
      'push',
    );
    expect(filterCheck(main, 'branches')).toEqual({ mark: 'yes', text: 'main matches' });
    expect(filterCheck(main, 'paths')).toEqual({ mark: 'no', text: 'no changed file matches' });
  });

  it('words an ignore filter by what it ignores', () => {
    const text = `on:\n  push:\n    branches-ignore: [dev]\n    paths-ignore: [docs/**]\n${JOBS}`;
    const dev = chainOf(
      simulated(text, { event: 'push', branch: 'dev', changed: ['docs/a.md'] }).plan,
      CI,
      'push',
    );
    expect(filterCheck(dev, 'branches-ignore')).toEqual({ mark: 'no', text: 'dev is ignored' });
    const main = chainOf(
      simulated(text, { event: 'push', branch: 'main', changed: ['src/a'] }).plan,
      CI,
      'push',
    );
    expect(filterCheck(main, 'branches-ignore')).toEqual({ mark: 'yes', text: 'main is not ignored' });
    expect(filterCheck(main, 'paths-ignore')).toEqual({ mark: 'yes', text: 'a changed file is not ignored' });
    // Every gate is judged, the branch's no included.
    expect(filterCheck(dev, 'paths-ignore')).toEqual({ mark: 'no', text: 'every changed file is ignored' });
  });

  it('says whether the activity type and the cron are listed', () => {
    const text = `on:\n  pull_request:\n    types: [opened]\n  schedule:\n    - cron: '0 6 * * 1'\n${JOBS}`;
    const closed = simulated(text, { event: 'pull_request', action: 'closed', base: 'main' }).plan;
    expect(typesCheck(chainOf(closed, CI, 'pull_request'))).toEqual({
      mark: 'no',
      text: 'closed is not listed',
    });
    const none = simulated(text, { event: 'pull_request', base: 'main' }).plan;
    expect(typesCheck(chainOf(none, CI, 'pull_request'))).toEqual({
      mark: 'maybe',
      text: 'no activity type given',
    });
    const cron = simulated(text, { event: 'schedule', cron: '0 7 * * *' }).plan;
    expect(scheduleCheck(chainOf(cron, CI, 'schedule'))).toEqual({
      mark: 'no',
      text: '0 7 * * * is not listed',
    });
    expect(
      scheduleCheck(chainOf(simulated(text, { event: 'schedule' }).plan, CI, 'schedule')),
    ).toBeUndefined();
  });

  it('reads a cron in GitHub’s words, or the converter’s problem with it', () => {
    const text = `on:\n  schedule:\n    - cron: '0 6 * * 1'\n    - cron: '61 6 * * 1'\n${JOBS}`;
    const { outline } = simulated(text, { event: 'schedule' });
    const wf = outline.workflows[0];
    const file = outline.files[0];
    const [ok, bad] = model(text).rows[0]!.crons!;
    expect(cronHint(wf, file, ok!)).toEqual({ text: 'Runs at 06:00, only on Monday' });
    expect(cronHint(wf, file, bad!)).toEqual({ problem: expect.stringMatching(/^Invalid cron expression/) });
    // A cron typed since the Outline: nothing yet.
    expect(cronHint(wf, file, { cron: '0 8 * * *', line: 5 })).toBeUndefined();
  });
});
