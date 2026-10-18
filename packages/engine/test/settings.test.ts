import { readSettings } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const read = (yaml: string) => readSettings('.github/workflows/ci.yml', yaml);

describe('readSettings: events', () => {
  it('reads a bare event, a list and a map with filters', () => {
    expect(read('on: push\njobs: {}\n').events).toEqual({ push: {} });
    expect(read('on: [push, pull_request]\njobs: {}\n').events).toEqual({ push: {}, pull_request: {} });
    const s = read(`
on:
  push:
    branches: [main, 'release/**']
    tags-ignore: ['v*-rc*']
    paths-ignore: ['docs/**']
  pull_request:
    types: [opened, labeled]
    paths: [src/**]
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:
    inputs:
      dry:
        type: boolean
        default: true
      env:
        type: choice
        options: [staging, production]
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
jobs: {}
`);
    expect(s.events).toEqual({
      push: { branches: ['main', 'release/**'], 'tags-ignore': ['v*-rc*'], 'paths-ignore': ['docs/**'] },
      pull_request: { types: ['opened', 'labeled'], paths: ['src/**'] },
      schedule: [{ cron: '0 6 * * 1' }],
      workflow_dispatch: {
        inputs: {
          dry: { type: 'boolean', default: true },
          env: { type: 'choice', options: ['staging', 'production'] },
        },
      },
      workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['main'] },
    });
    expect(s.errors).toEqual([]);
  });

  it('reads concurrency as written, at the workflow and the job', () => {
    const s = read(`
on: push
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ubuntu-latest
    concurrency: release
    steps: [{ run: echo }]
  b:
    runs-on: ubuntu-latest
    concurrency:
      group: deploy
      cancel-in-progress: \${{ github.event_name == 'push' }}
    steps: [{ run: echo }]
`);
    expect(s.concurrency).toEqual({ group: 'ci-${{ github.ref }}', cancelInProgress: true });
    expect(s.jobs.a?.concurrency).toEqual({ group: 'release' });
    expect(s.jobs.b?.concurrency).toEqual({
      group: 'deploy',
      cancelInProgress: { expression: "github.event_name == 'push'" },
    });
  });
});

describe('readSettings: jobs and steps', () => {
  it('wraps every if in the implicit success() unless a status function appears', () => {
    const s = read(`
on: push
jobs:
  plain:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  guarded:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: echo
      - if: failure()
        run: echo
      - if: \${{ always() && matrix.os == 'linux' }}
        run: echo
      - if: contains(github.event.head_commit.message, 'deploy')
        run: echo
      - if: false
        run: echo
  wrapped:
    if: \${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps: []
  literal:
    if: true
    runs-on: ubuntu-latest
    steps: []
`);
    expect(s.jobs.plain?.if).toBe('success()');
    expect(s.jobs.guarded?.if).toBe("success() && (github.ref == 'refs/heads/main')");
    expect(s.jobs.guarded?.steps.map((st) => st.if)).toEqual([
      'success()',
      'failure()',
      "always() && matrix.os == 'linux'",
      "success() && (contains(github.event.head_commit.message, 'deploy'))",
      'success() && (false)',
    ]);
    expect(s.jobs.wrapped?.if).toBe('!cancelled()');
    expect(s.jobs.literal?.if).toBe('success() && (true)');
    expect(s.errors).toEqual([]);
  });

  it('reads continue-on-error, timeouts, fail-fast and max-parallel as literals or expressions', () => {
    const s = read(`
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    continue-on-error: true
    timeout-minutes: 15
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - run: echo
        continue-on-error: \${{ matrix.os == 'windows-latest' }}
        timeout-minutes: \${{ fromJSON(vars.T) }}
      - run: echo
        continue-on-error: false
        timeout-minutes: 3
  b:
    runs-on: ubuntu-latest
    continue-on-error: \${{ github.event_name == 'push' }}
    timeout-minutes: \${{ vars.TIMEOUT }}
    strategy:
      fail-fast: \${{ github.ref != 'refs/heads/main' }}
      matrix: { x: [1] }
    steps: []
`);
    expect(s.jobs.a).toMatchObject({
      continueOnError: true,
      timeoutMinutes: 15,
      failFast: false,
      maxParallel: 2,
    });
    expect(s.jobs.a?.steps).toEqual([
      {
        index: 0,
        if: 'success()',
        continueOnError: { expression: "matrix.os == 'windows-latest'" },
        timeoutMinutes: { expression: 'fromJSON(vars.T)' },
      },
      { index: 1, if: 'success()', continueOnError: false, timeoutMinutes: 3 },
    ]);
    expect(s.jobs.b).toMatchObject({
      continueOnError: { expression: "github.event_name == 'push'" },
      timeoutMinutes: { expression: 'vars.TIMEOUT' },
      failFast: { expression: "github.ref != 'refs/heads/main'" },
    });
    expect(s.jobs.b?.failFast).toBeDefined();
    expect(s.errors).toEqual([]);
  });

  it('keeps every job and every step index when the converter rejects parts of the file', () => {
    const s = read(`
on: push
jobs:
  broken:
    runs-on: ubuntu-latest
    if: github.ref ==
    continue-on-error: maybe
    steps:
      - name: no run or uses
      - run: echo
        if: \${{ steps.x.outputs.y
      - run: echo
        timeout-minutes: soon
  fine:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`);
    expect(Object.keys(s.jobs)).toEqual(['broken', 'fine']);
    expect(s.jobs.broken?.if).toBe('success()');
    expect(s.jobs.broken?.continueOnError).toBeUndefined();
    expect(s.jobs.broken?.steps.map((st) => st.index)).toEqual([0, 1, 2]);
    expect(s.jobs.broken?.steps[1]?.if).toBe('success()');
    expect(s.jobs.broken?.steps[2]?.timeoutMinutes).toBeUndefined();
    expect(s.jobs.fine?.steps).toEqual([{ index: 0, if: 'success()' }]);
    expect(s.errors.length).toBeGreaterThanOrEqual(3);
    for (const e of s.errors) {
      expect(e.message).not.toMatch(/^\.github\/workflows\/ci\.yml/);
      expect(e.line).toBeGreaterThan(0);
    }
    expect(s.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/continue-on-error/),
        expect.stringMatching(/timeout-minutes/),
      ]),
    );
  });

  it('gives empty settings and the error for a file that is not a workflow', () => {
    const s = read('just: text\n');
    expect(s.events).toEqual({});
    expect(s.jobs).toEqual({});
    expect(s.errors.length).toBeGreaterThan(0);
    const broken = read('on: [\n');
    expect(broken.jobs).toEqual({});
    expect(broken.errors.length).toBeGreaterThan(0);
  });
});
