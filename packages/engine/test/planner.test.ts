import { checksOf, type RunPlan, type ScenarioInput, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const wf = (yaml: string, scenario: ScenarioInput, extra: Record<string, string> = {}): RunPlan =>
  simulate({ files: { '.github/workflows/ci.yml': yaml, ...extra }, scenario });

const verdicts = (plan: RunPlan) =>
  Object.fromEntries(plan.workflows.flatMap((w) => w.jobs.map((j) => [j.jobId, j.runs.verdict])));
const results = (plan: RunPlan) =>
  Object.fromEntries(
    plan.workflows.flatMap((w) => w.jobs.map((j) => [j.jobId, j.result.known ? j.result.value : j.result])),
  );

describe('simulate: workflows and jobs', () => {
  const ci = `
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;

  it('lists every workflow with its trigger decision and plans the jobs of the triggered ones', () => {
    const plan = wf(ci, { event: 'push', branch: 'main' });
    expect(plan.schemaVersion).toBe(1);
    expect(plan.workflows.map((w) => [w.path, w.triggered.verdict, w.jobs.length])).toEqual([
      ['.github/workflows/ci.yml', 'yes', 2],
    ]);
    expect(verdicts(plan)).toEqual({ build: 'yes', deploy: 'yes' });
    expect(results(plan)).toEqual({ build: 'success', deploy: 'success' });
    expect(plan.workflows[0]!.conclusion).toEqual({ known: true, value: 'success' });
    expect(plan.unknowns).toEqual([]);
  });

  it('skips a job whose if is false, with the reason chain, and leaves an untriggered workflow without jobs', () => {
    const plan = wf(ci, { event: 'pull_request', base: 'main', head: 'topic' });
    expect(verdicts(plan)).toEqual({ build: 'yes', deploy: 'no' });
    expect(results(plan)).toEqual({ build: 'success', deploy: 'skipped' });
    const deploy = plan.workflows[0]!.jobs[1]!;
    expect(deploy.runs.chain[1]).toMatchObject({
      kind: 'if',
      expr: "github.ref == 'refs/heads/main' && github.event_name == 'push'",
      evaluated: "success() && (github.ref == 'refs/heads/main' && github.event_name == 'push')",
      implicitSuccess: true,
      status: { known: true, value: 'success' },
      value: { known: true, value: false },
    });
    expect(deploy.legs).toHaveLength(1);
    expect(deploy.legs[0]!.steps).toBeUndefined();
    expect(checksOf(plan).map((c) => [c.name, c.runs])).toEqual([
      ['build', 'yes'],
      ['deploy', 'no'],
    ]);
    const other = wf(ci, { event: 'push', branch: 'topic' });
    expect(other.workflows[0]!.triggered.verdict).toBe('no');
    expect(other.workflows[0]!.jobs).toEqual([]);
  });

  it('cascades a skipped need the way the lab saw it (lab 1)', () => {
    const plan = wf(
      `
on: push
jobs:
  a:
    if: false
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  c:
    needs: a
    if: always()
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  d:
    needs: a
    if: failure()
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  e:
    needs: a
    if: "!cancelled()"
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  f:
    needs: a
    if: success()
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`,
      { event: 'push' },
    );
    expect(verdicts(plan)).toEqual({ a: 'no', b: 'no', c: 'yes', d: 'no', e: 'yes', f: 'no' });
    expect(results(plan)).toEqual({
      a: 'skipped',
      b: 'skipped',
      c: 'success',
      d: 'skipped',
      e: 'success',
      f: 'skipped',
    });
    expect(plan.workflows[0]!.conclusion).toEqual({ known: true, value: 'success' });
  });

  it('expands a matrix into legs with check names, and reads matrix values in steps', () => {
    const plan = wf(
      `
on: push
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [20, 22]
        exclude:
          - { os: windows-latest, node: 20 }
    steps:
      - run: echo
      - if: matrix.os == 'windows-latest'
        run: echo windows
`,
      { event: 'push' },
    );
    const job = plan.workflows[0]!.jobs[0]!;
    expect(job.matrix).toMatchObject({
      keys: ['os', 'node'],
      exact: true,
      count: 3,
      failFast: { known: true, value: false },
    });
    expect(job.legs.map((l) => l.legKey)).toEqual([
      'node=20,os=ubuntu-latest',
      'node=22,os=ubuntu-latest',
      'node=22,os=windows-latest',
    ]);
    expect(job.legs.map((l) => l.check?.name)).toEqual([
      'test (ubuntu-latest, 20)',
      'test (ubuntu-latest, 22)',
      'test (windows-latest, 22)',
    ]);
    expect(job.legs.map((l) => l.steps![1]!.runs.verdict)).toEqual(['no', 'no', 'yes']);
    expect(job.legs[2]!.runsOn).toEqual({ known: true, value: ['windows-latest'] });
    expect(job.legs[0]!.id).toBe('.github/workflows/ci.yml#test[node=20,os=ubuntu-latest]');
    expect(job.legs[0]!.steps![1]!.id).toBe(
      '.github/workflows/ci.yml#test[node=20,os=ubuntu-latest]/~echo-windows',
    );
  });

  it('is maybe with the unknown named and pinned when the actor decides the route, and no when a missing var does', () => {
    const plan = wf(
      `
on: push
jobs:
  deploy:
    if: github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  gated:
    if: vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`,
      { event: 'push' },
    );
    expect(verdicts(plan)).toEqual({ deploy: 'maybe', gated: 'no' });
    expect(plan.workflows[0]!.jobs[0]!.result).toEqual({
      known: false,
      unknowns: ['github.actor'],
      oneOf: ['skipped', 'success'],
    });
    expect(plan.unknowns).toEqual([
      {
        id: 'github.actor',
        kind: 'event',
        reads: [],
        affects: ['.github/workflows/ci.yml#deploy'],
        pin: { layer: 'scenario', fragment: { actor: { login: '' } }, at: ['when'] },
      },
    ]);
    const pinned = simulate({
      files: {
        '.github/workflows/ci.yml': `
on: push
jobs:
  deploy:
    if: vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`,
      },
      scenario: { event: 'push', vars: { DEPLOY: 'true' } },
    });
    expect(verdicts(pinned)).toEqual({ deploy: 'yes' });
  });
});

describe('simulate: steps, outputs and composition', () => {
  it('names a script output as an unknown that a later if depends on, and reads a skipped step as empty (lab 3)', () => {
    const plan = wf(
      `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: detect
        run: echo "changed=$(./detect.sh)" >> "$GITHUB_OUTPUT"
      - id: s
        if: false
        run: echo "x=1" >> "$GITHUB_OUTPUT"
      - if: steps.detect.outputs.changed == 'true'
        run: echo gated
      - if: steps.s.outputs.x == ''
        run: echo empty
      - if: steps.s.outcome == 'skipped'
        run: echo skipped
`,
      { event: 'push' },
    );
    const steps = plan.workflows[0]!.jobs[0]!.legs[0]!.steps!;
    const detect = steps[0]!;
    expect(detect.outputs).toEqual({ changed: { known: false, unknowns: [`${detect.id}.outputs.changed`] } });
    expect(steps.map((s) => s.runs.verdict)).toEqual(['yes', 'no', 'maybe', 'yes', 'yes']);
    expect(steps[1]!.outcome).toEqual({ known: true, value: 'skipped' });
    expect(plan.unknowns[0]).toMatchObject({
      id: `${detect.id}.outputs.changed`,
      kind: 'step-output',
      affects: [steps[2]!.id],
    });
  });

  it('nests a reusable workflow under the calling leg with inputs, outputs and composed check names (lab 9, 10)', () => {
    const plan = wf(
      `
on: push
jobs:
  call:
    uses: ./.github/workflows/callee.yml
    with:
      flag: true
      name: \${{ github.event_name }}
  after:
    needs: call
    runs-on: ubuntu-latest
    steps:
      - if: needs.call.outputs.o == 'push-yes'
        run: echo
  skipped-call:
    if: false
    uses: ./.github/workflows/callee.yml
`,
      { event: 'push' },
      {
        '.github/workflows/callee.yml': `
on:
  workflow_call:
    inputs:
      flag: { type: boolean, default: false }
      name: { type: string, required: true }
    outputs:
      o:
        value: \${{ jobs.x.outputs.o }}
jobs:
  x:
    runs-on: ubuntu-latest
    outputs:
      o: \${{ inputs.name }}-\${{ inputs.flag && 'yes' || 'no' }}
    steps: [{ run: echo }]
  y:
    if: \${{ !inputs.flag }}
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`,
      },
    );
    const [call, after, skippedCall] = plan.workflows.find(
      (w) => w.path === '.github/workflows/ci.yml',
    )!.jobs;
    expect(call!.legs[0]!.call).toMatchObject({ caller: call!.legs[0]!.id, depth: 1 });
    expect(call!.legs[0]!.call!.inputs).toEqual({
      flag: { known: true, value: true },
      name: { known: true, value: 'push' },
    });
    expect(call!.legs[0]!.call!.jobs.map((j) => [j.jobId, j.runs.verdict])).toEqual([
      ['x', 'yes'],
      ['y', 'no'],
    ]);
    expect(call!.outputs).toEqual({ o: { known: true, value: 'push-yes' } });
    expect(after!.legs[0]!.steps![0]!.runs.verdict).toBe('yes');
    expect(skippedCall!.legs[0]!.call).toBeUndefined();
    expect(checksOf(plan).map((c) => [c.name, c.runs])).toEqual([
      ['call / x', 'yes'],
      ['call / y', 'no'],
      ['after', 'yes'],
      ['skipped-call', 'no'],
    ]);
    expect(plan.workflows.map((w) => [w.path, w.triggered.verdict])).toEqual([
      ['.github/workflows/callee.yml', 'no'],
      ['.github/workflows/ci.yml', 'yes'],
    ]);
  });

  it('expands a composite action under its step and reads its outputs', () => {
    const plan = wf(
      `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: comp
        uses: ./.github/actions/comp
        with:
          who: world
      - if: steps.comp.outputs.greeting == 'hello world'
        run: echo
`,
      { event: 'push' },
      {
        '.github/actions/comp/action.yml': `
name: comp
inputs:
  who: { default: nobody }
outputs:
  greeting:
    value: \${{ steps.say.outputs.text }}
runs:
  using: composite
  steps:
    - id: say
      run: echo "text=hello \${{ inputs.who }}" >> "$GITHUB_OUTPUT"
      shell: bash
    - if: inputs.who == 'world'
      run: echo world
      shell: bash
`,
      },
    );
    const [comp, gated] = plan.workflows[0]!.jobs[0]!.legs[0]!.steps!;
    expect(comp!.composite).toMatchObject({ path: '.github/actions/comp' });
    expect(comp!.composite!.steps.map((s) => s.runs.verdict)).toEqual(['yes', 'yes']);
    expect(comp!.outputs.greeting).toEqual({ known: true, value: 'hello world' });
    expect(gated!.runs.verdict).toBe('yes');
  });

  it('reports a dynamic matrix as one placeholder leg and the unknown behind it', () => {
    const plan = wf(
      `
on: push
jobs:
  prep:
    runs-on: ubuntu-latest
    outputs:
      m: \${{ steps.m.outputs.json }}
    steps:
      - id: m
        run: echo "json=[1]" >> "$GITHUB_OUTPUT"
  test:
    needs: prep
    runs-on: ubuntu-latest
    strategy:
      matrix: \${{ fromJSON(needs.prep.outputs.m) }}
    steps: [{ run: echo }]
`,
      { event: 'push' },
    );
    const test = plan.workflows[0]!.jobs[1]!;
    expect(test.matrix).toMatchObject({ dynamic: true });
    expect(test.legs.map((l) => [l.legKey, l.runs.verdict])).toEqual([['*', 'maybe']]);
    expect(test.legs[0]!.runs.chain.at(-1)).toEqual({ kind: 'matrix', unknown: `${test.id}.matrix` });
  });
});
