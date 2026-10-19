import type { AssumeEntry } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { handle, initialState, type WorkerState } from '../src/worker/handle';
import { type CaseRequest, isEngineRequest, type SimulateRequest } from '../src/worker/protocol';

const files = {
  '.github/workflows/ci.yml': `
on:
  push:
    branches: [main]
    paths: ['src/**']
  pull_request:
    types: [opened, labeled]
  workflow_dispatch:
    inputs:
      env:
        type: choice
        options: [staging, prod]
        default: staging
      dry:
        type: boolean
        required: true
  schedule:
    - cron: '0 6 * * 1'
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - id: t
        run: npm test
      - uses: actions/checkout@v4
  deploy:
    needs: build
    if: vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: ./deploy }]
`,
  '.github/workflows/broken.yml': 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [\n',
  '.github/actions/x/action.yml':
    'name: x\nruns:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n',
};

function loaded(): { state: WorkerState; project: number } {
  const r = handle(initialState(), { id: 1, type: 'load', files });
  if (r.response.type !== 'loaded') throw new Error(JSON.stringify(r.response));
  return { state: r.state, project: r.response.project };
}

const sim = (over: Partial<SimulateRequest> = {}): SimulateRequest => ({
  id: 2,
  type: 'simulate',
  project: 1,
  scenario: { event: 'push', branch: 'main', changed: ['src/a.ts'] },
  assume: [],
  detail: 'steps',
  ...over,
});

describe('the worker handler', () => {
  it('loads a project once and answers with its outline', () => {
    const r = handle(initialState(), { id: 1, type: 'load', files });
    expect(r.response).toMatchObject({ id: 1, type: 'loaded', project: 1 });
    if (r.response.type !== 'loaded') return;
    const { outline } = r.response;
    expect(outline.files.map((f) => [f.path, f.kind, f.errors.length])).toEqual([
      ['.github/actions/x/action.yml', 'action', 0],
      ['.github/workflows/broken.yml', 'workflow', 1],
      ['.github/workflows/ci.yml', 'workflow', 0],
    ]);
    expect(outline.files[1]!.errors[0]).toMatchObject({ line: 6 });
    const ci = outline.workflows.find((w) => w.path === '.github/workflows/ci.yml')!;
    expect(ci.onLine).toBe(2);
    expect(ci.events.map((e) => e.event)).toEqual(['push', 'pull_request', 'workflow_dispatch', 'schedule']);
    expect(ci.events[0]).toMatchObject({
      branches: ['main'],
      paths: ['src/**'],
      loc: { line: 3, filters: { branches: 4, paths: 5 } },
    });
    expect(ci.events[1]!.types).toEqual({
      allowed: ['opened', 'labeled'],
      all: expect.arrayContaining(['opened', 'labeled', 'closed']),
      narrowed: true,
    });
    expect(ci.events[3]!.crons).toEqual(['0 6 * * 1']);
    expect(ci.dispatch).toEqual([
      { name: 'env', type: 'choice', required: false, default: 'staging', options: ['staging', 'prod'] },
      { name: 'dry', type: 'boolean', required: true },
    ]);
    expect(ci.jobs.map((j) => [j.id, j.needs, j.matrix, j.steps.length, j.line])).toEqual([
      ['build', [], true, 2, 20],
      ['deploy', ['build'], false, 1, 29],
    ]);
    expect(ci.jobs[0]!.steps[1]).toEqual({ index: 1, uses: 'actions/checkout@v4', line: 28 });
    expect(outline.events.pull_request!.types).toContain('synchronize');
    expect(r.state.nextVersion).toBe(2);
  });

  it('simulates against the loaded project with the plan, the derived tables and the text', () => {
    const { state, project } = loaded();
    const r = handle(state, sim({ project }));
    expect(r.response).toMatchObject({ id: 2, type: 'plan', project });
    if (r.response.type !== 'plan') return;
    const { plan, derived, text } = r.response;
    expect(text).toContain('● .github/workflows/ci.yml');
    const build = plan.workflows.find((w) => w.path.endsWith('ci.yml'))!.jobs[0]!;
    expect(derived.kinds[build.id]).toBe('job');
    expect(derived.unitPaths[build.legs[0]!.id]).toBe('build[n=1]');
    expect(derived.unitPaths[build.legs[0]!.steps![0]!.id]).toBe('build[n=1].t');
    const deploy = plan.workflows.find((w) => w.path.endsWith('ci.yml'))!.jobs[1]!;
    expect(deploy.runs.verdict).toBe('no');
    expect(derived.clauses[deploy.id]).toBe("if: vars.DEPLOY == 'true' → false");
    expect(derived.decidingIndex[deploy.id]).toBe(1);
    expect(derived.decidingLoc[deploy.id]).toMatchObject({ file: '.github/workflows/ci.yml', line: 31 });
    expect(deploy.legs[0]!.steps).toBeUndefined();
    expect(derived.decidingLoc[deploy.legs[0]!.id]).toMatchObject({ line: 31 });
    expect(derived.decidingLoc[build.legs[0]!.steps![1]!.id]).toMatchObject({ line: 28 });
    expect(r.response.ms.simulate).toBeGreaterThanOrEqual(0);
  });

  it('points an untriggered workflow at the on: line that decided it', () => {
    const { state, project } = loaded();
    const docs = handle(
      state,
      sim({ project, scenario: { event: 'push', branch: 'topic', changed: ['docs/a.md'] } }),
    );
    if (docs.response.type !== 'plan') throw new Error(docs.response.type);
    const ci = docs.response.plan.workflows.find((w) => w.path.endsWith('ci.yml'))!;
    expect(docs.response.derived.clauses[ci.id]).toBe('branches [main] ← topic: false');
    expect(docs.response.derived.decidingLoc[ci.id]).toEqual({
      file: '.github/workflows/ci.yml',
      line: 4,
      column: 1,
    });
    const paths = handle(
      state,
      sim({ project, scenario: { event: 'push', branch: 'main', changed: ['docs/a.md'] } }),
    );
    if (paths.response.type !== 'plan') throw new Error(paths.response.type);
    expect(paths.response.derived.decidingLoc[ci.id]).toMatchObject({ line: 5 });
    const unknown = handle(state, sim({ project, scenario: { event: 'push', branch: 'main' } }));
    if (unknown.response.type !== 'plan') throw new Error(unknown.response.type);
    expect(unknown.response.derived.unknownPaths['scenario.changed']).toBe('scenario.changed');
  });

  it("tells a stale project, the author's mistakes and a test case apart", () => {
    const { state, project } = loaded();
    expect(handle(state, sim({ project: 9 })).response).toMatchObject({ type: 'error', kind: 'stale' });
    const scenario = handle(
      state,
      sim({ project, scenario: { event: 'push', branch: 'main', tag: 'v1' } }),
    ).response;
    expect(scenario).toMatchObject({ type: 'invalid', what: 'scenario' });
    const key = handle(
      state,
      sim({ project, scenario: { event: 'push', brnach: 'main' } as never }),
    ).response;
    expect(key).toMatchObject({ type: 'invalid', what: 'scenario', issues: [{ path: [] }] });
    const assume = handle(state, sim({ project, assume: [{ step: 'build.t' }] as never })).response;
    expect(assume).toMatchObject({ type: 'invalid', what: 'assume', issues: [{ path: [0] }] });
    const c = handle(state, {
      id: 3,
      type: 'case',
      project,
      workflow: 'ci.yml',
      scenario: { event: 'push', branch: 'main', changed: ['src/a.ts'] },
      assume: [{ step: 'build.t', outcome: 'failure' }],
      detail: 'jobs',
      format: 'test',
    }).response;
    expect(c).toMatchObject({ id: 3, type: 'case' });
    if (c.type !== 'case') return;
    expect(c.text).toMatch(/^workflow: ci\.yml\n/);
    expect(c.case?.then).toMatchObject({ run: ['build'], skip: ['deploy'], conclusion: 'failure' });
  });

  it('sends with a test case the errors `simulci test` would report it invalid for, and none with a clean one', () => {
    const { state, project } = loaded();
    const ask = (assume: AssumeEntry[], format: CaseRequest['format'] = 'test') =>
      handle(state, {
        id: 5,
        type: 'case',
        project,
        workflow: 'ci.yml',
        scenario: { event: 'push', branch: 'main', changed: ['src/a.ts'] },
        assume,
        detail: 'jobs',
        format,
      }).response;
    const fails: AssumeEntry = { step: 'build.t', outcome: 'failure' };
    const nowhere: AssumeEntry = { step: 'build.nope', outcome: 'failure' };
    const invalid = ask([fails, nowhere]);
    expect(invalid).toMatchObject({ type: 'case', text: expect.stringMatching(/^workflow: ci\.yml\n/) });
    if (invalid.type !== 'case') return;
    expect(invalid.errors).toEqual([{ code: 'SC102', message: 'assume[1] matches nothing in this plan' }]);
    const clean = ask([fails]);
    expect(clean).toMatchObject({ type: 'case' });
    expect(Object.hasOwn(clean, 'errors')).toBe(false);
    // The plan formats are no test case: nothing for `simulci test` to refuse.
    expect(Object.hasOwn(ask([fails, nowhere], 'text'), 'errors')).toBe(false);
  });

  it('names the member issue of a union and refuses a case for a workflow the project lacks', () => {
    const { state, project } = loaded();
    const r = handle(
      state,
      sim({
        project,
        scenario: { event: 'push', branch: 'main', changed: [{ path: 'a', status: 'moved' }] } as never,
      }),
    );
    expect(r.response).toMatchObject({ type: 'invalid', what: 'scenario' });
    if (r.response.type !== 'invalid') return;
    expect(r.response.issues.some((i) => i.path.join('.') === 'changed.0.status')).toBe(true);
    expect(r.response.issues.every((i) => i.message !== 'Invalid input')).toBe(true);
    const c = handle(state, {
      id: 4,
      type: 'case',
      project,
      workflow: 'nope.yml',
      scenario: { event: 'push', branch: 'main' },
      assume: [],
      detail: 'jobs',
      format: 'test',
    }).response;
    expect(c).toMatchObject({ type: 'invalid', what: 'workflow', issues: [{ path: ['workflow'] }] });
  });

  it("points a called workflow at the caller's decision and reports what the converter rejected", () => {
    const r = handle(initialState(), {
      id: 1,
      type: 'load',
      files: {
        '.github/workflows/caller.yml':
          "on: push\njobs:\n  detect:\n    runs-on: ubuntu-latest\n    outputs:\n      go: ${{ steps.d.outputs.go }}\n    steps:\n      - id: d\n        run: ./decide.sh\n  call:\n    needs: detect\n    if: needs.detect.outputs.go == '1'\n    uses: ./.github/workflows/callee.yml\n",
        '.github/workflows/callee.yml':
          'on: workflow_call\njobs:\n  inner:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
        '.github/workflows/dup.yml':
          'on:\n  push:\n    branches: [main]\n  push:\n    branches: [dev]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
        '.github/workflows/bad-on.yml':
          'on:\n  push:\n    branchez: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
      },
    });
    if (r.response.type !== 'loaded') throw new Error(JSON.stringify(r.response));
    const { outline } = r.response;
    const dup = outline.workflows.find((w) => w.path.endsWith('dup.yml'))!;
    expect(dup.events[0]!.loc).toEqual({ line: 2, filters: { branches: 3 } });
    const badOn = outline.files.find((f) => f.path.endsWith('bad-on.yml'))!;
    expect(badOn.errors.length).toBeGreaterThan(0);
    expect(badOn.errors[0]!.message).toMatch(/branchez/);
    const p = handle(
      r.state,
      sim({ project: r.response.project, scenario: { event: 'push', branch: 'main' } }),
    );
    if (p.response.type !== 'plan') throw new Error(p.response.type);
    const caller = p.response.plan.workflows.find((w) => w.path.endsWith('caller.yml'))!;
    const callee = caller.jobs[1]!.legs[0]!.call!;
    expect(callee.triggered.verdict).toBe('maybe');
    expect(p.response.derived.decidingLoc[callee.id]).toMatchObject({
      file: '.github/workflows/caller.yml',
      line: 12,
    });
    expect(p.response.derived.decidingLoc[callee.jobs[0]!.id]).toMatchObject({
      file: '.github/workflows/caller.yml',
      line: 12,
    });
  });

  it('accepts only well-formed requests', () => {
    expect(isEngineRequest({ id: 1, type: 'load', files })).toBe(true);
    expect(isEngineRequest(sim())).toBe(true);
    expect(isEngineRequest({ id: 1, type: 'simulate', project: 1, scenario: {} })).toBe(false);
    expect(isEngineRequest({ id: '1', type: 'load', files })).toBe(false);
    expect(isEngineRequest({ type: 'other' })).toBe(false);
    expect(isEngineRequest(null)).toBe(false);
  });
});
