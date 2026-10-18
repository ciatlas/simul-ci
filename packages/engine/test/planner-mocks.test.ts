import { MocksError, type RunPlan, type ScenarioInput, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const run = (
  yaml: string,
  scenario: ScenarioInput,
  assume: unknown[],
  extra: Record<string, string> = {},
): RunPlan =>
  simulate({ files: { '.github/workflows/ci.yml': yaml, ...extra }, scenario, assume: assume as never });

const jobs = (plan: RunPlan) =>
  Object.fromEntries(
    plan.workflows.flatMap((w) =>
      w.jobs.map((j) => [
        j.jobId,
        { runs: j.runs.verdict, result: j.result.known ? j.result.value : j.result },
      ]),
    ),
  );
const codes = (plan: RunPlan) => plan.diagnostics.map((d) => d.code);

const pipeline = `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: unit
        run: npm test
      - id: coverage
        if: always()
        run: echo "pct=90" >> "$GITHUB_OUTPUT"
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps: [{ run: echo deploy }]
  notify:
    needs: test
    if: always()
    runs-on: ubuntu-latest
    steps: [{ run: echo notify }]
`;

describe('assume: step outcomes', () => {
  it('a failing step fails the job, skips dependents and is recorded as applied (lab 1, 4)', () => {
    const plan = run(pipeline, { event: 'push' }, [{ step: 'test.unit', outcome: 'failure' }]);
    expect(jobs(plan)).toEqual({
      test: { runs: 'yes', result: 'failure' },
      deploy: { runs: 'no', result: 'skipped' },
      notify: { runs: 'yes', result: 'success' },
    });
    const steps = plan.workflows[0]!.jobs[0]!.legs[0]!.steps!;
    expect(steps[0]!.outcome).toEqual({ known: true, value: 'failure' });
    expect(steps[1]!.runs.verdict).toBe('yes');
    expect(plan.mocks).toEqual([
      { ref: 'assume[0]', layer: 'case', at: steps[0]!.id, provides: ['outcome'] },
    ]);
    expect(codes(plan)).toEqual([]);
  });

  it('keeps outcome and conclusion apart under continue-on-error (lab 5)', () => {
    const plan = run(
      `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: f
        continue-on-error: true
        run: exit 1
      - if: failure()
        run: echo failed
      - if: success()
        run: echo ok
`,
      { event: 'push' },
      [{ step: 'a.f', outcome: 'failure' }],
    );
    const steps = plan.workflows[0]!.jobs[0]!.legs[0]!.steps!;
    expect(steps[0]!.outcome).toEqual({ known: true, value: 'failure' });
    expect(steps[0]!.conclusion).toEqual({ known: true, value: 'success' });
    expect(steps.map((s) => s.runs.verdict)).toEqual(['yes', 'no', 'yes']);
    expect(jobs(plan).a).toEqual({ runs: 'yes', result: 'success' });
  });

  it('addresses id-less steps by position, matrix legs by value, and cancels fail-fast siblings as a race (lab 6, 14)', () => {
    const plan = run(
      `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3]
    steps:
      - name: leg
        run: ./leg.sh
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  c:
    needs: a
    if: cancelled()
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`,
      { event: 'push' },
      [{ step: 'a[n=2].#1', outcome: 'failure' }],
    );
    const a = plan.workflows[0]!.jobs[0]!;
    expect(a.legs.map((l) => (l.result.known ? l.result.value : l.result.oneOf))).toEqual([
      ['success', 'cancelled'],
      'failure',
      ['success', 'cancelled'],
    ]);
    expect(jobs(plan)).toMatchObject({ a: { result: 'failure' }, b: { runs: 'no' }, c: { runs: 'no' } });
    const race = plan.unknowns.find((u) => u.id.startsWith('race:fail-fast:'))!;
    expect(race.pin).toEqual({
      layer: 'assume',
      fragment: { job: 'a', matrix: { n: '1' }, outcome: 'cancelled' },
      at: ['assume'],
    });
  });

  it('applies a job-level outcome at the job boundary and says so (SC108)', () => {
    const plan = run(pipeline, { event: 'push' }, [{ job: 'test', outcome: 'failure' }]);
    expect(jobs(plan)).toMatchObject({
      test: { result: 'failure' },
      deploy: { runs: 'no' },
      notify: { runs: 'yes' },
    });
    expect(plan.workflows[0]!.jobs[0]!.legs[0]!.steps!.map((s) => s.outcome)).toEqual([
      { known: true, value: 'success' },
      { known: true, value: 'success' },
    ]);
    expect(plan.diagnostics).toEqual([expect.objectContaining({ code: 'SC108', severity: 'info' })]);
  });
});

describe('assume: outputs and env', () => {
  const gated = `
on: push
jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      changed: \${{ steps.d.outputs.changed }}
    steps:
      - id: d
        run: ./detect.sh
      - id: w
        run: echo "x=1" >> "$GITHUB_OUTPUT"
      - run: echo "$MODE"
        if: env.MODE == 'ci'
  build:
    needs: detect
    if: needs.detect.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;

  it('pins a script output, which decides the dependent job', () => {
    expect(jobs(run(gated, { event: 'push' }, [])).build!.runs).toBe('maybe');
    const plan = run(gated, { event: 'push' }, [{ step: 'detect.d', outputs: { changed: 'true' } }]);
    expect(jobs(plan).build).toEqual({ runs: 'yes', result: 'success' });
    expect(plan.workflows[0]!.jobs[0]!.outputs.changed).toEqual({ known: true, value: 'true' });
    expect(
      run(gated, { event: 'push' }, [{ step: 'detect.d', outputs: { changed: 'false' } }]).workflows[0]!
        .jobs[1]!.runs.verdict,
    ).toBe('no');
  });

  it('accepts any name on an open script, refuses one a closed interface lacks (SC101), and un-pins with unknown', () => {
    const open = run(gated, { event: 'push' }, [{ step: 'detect.d', outputs: { other: 'x' } }]);
    expect(codes(open)).toEqual([]);
    const closed = run(gated, { event: 'push' }, [{ step: 'detect.w', outputs: { y: '2' } }]);
    expect(closed.diagnostics[0]).toMatchObject({ code: 'SC101', severity: 'error' });
    expect(closed.diagnostics[0]!.message).toContain(
      "sets output 'y', which the script does not declare (it declares x)",
    );
    const unpinned = run(gated, { event: 'push' }, [{ step: 'detect.w', outputs: { x: { unknown: true } } }]);
    expect(unpinned.workflows[0]!.jobs[0]!.legs[0]!.steps![1]!.outputs.x).toEqual({
      known: false,
      unknowns: [`${unpinned.workflows[0]!.jobs[0]!.legs[0]!.steps![1]!.id}.outputs.x`],
    });
  });

  it('writes env for the steps after the mocked one', () => {
    const plan = run(gated, { event: 'push' }, [{ step: 'detect.d', env: { MODE: 'ci' } }]);
    const steps = plan.workflows[0]!.jobs[0]!.legs[0]!.steps!;
    expect(steps[2]!.runs.verdict).toBe('yes');
    expect(run(gated, { event: 'push' }, []).workflows[0]!.jobs[0]!.legs[0]!.steps![2]!.runs.verdict).toBe(
      'no',
    );
  });

  it('matches every step a uses: pattern names, within a job scope when given', () => {
    const plan = run(
      `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache@v4
        with: { path: ~/.npm, key: x }
      - if: steps.cache.outputs.cache-hit != 'true'
        run: npm ci
  other:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache/restore@v4
        with: { path: ~/.npm, key: x }
      - if: steps.cache.outputs.cache-hit != 'true'
        run: npm ci
`,
      { event: 'push' },
      [
        { uses: 'actions/cache', outputs: { 'cache-hit': 'true' } },
        { uses: 'actions/cache', job: 'other', outputs: { 'cache-hit': '' } },
      ],
    );
    const [build, other] = plan.workflows[0]!.jobs;
    expect(build!.legs[0]!.steps![1]!.runs.verdict).toBe('no');
    expect(other!.legs[0]!.steps![1]!.runs.verdict).toBe('yes');
    expect(plan.mocks.map((m) => [m.ref, m.provides])).toEqual([
      ['assume[0]', ['outputs.cache-hit']],
      ['assume[1]', ['outputs.cache-hit']],
    ]);
  });
});

describe('assume: validation', () => {
  it('reports entries that match nothing (SC102) and conflicts (SC103), and rejects malformed entries', () => {
    const plan = run(pipeline, { event: 'push' }, [
      { step: 'test.nope', outcome: 'failure' },
      { step: 'test.unit', outcome: 'failure' },
      { step: 'test.unit', outcome: 'success' },
    ]);
    expect(codes(plan).sort()).toEqual(['SC102', 'SC103']);
    expect(plan.workflows[0]!.jobs[0]!.legs[0]!.steps![0]!.outcome).toEqual({
      known: false,
      unknowns: [expect.stringMatching(/^conflict:.*\.outcome$/)],
    });
    expect(() => run(pipeline, { event: 'push' }, [{ step: 'test.unit', conclusion: 'failure' }])).toThrow(
      MocksError,
    );
    expect(() => run(pipeline, { event: 'push' }, [{ step: 'test.unit' }])).toThrow(MocksError);
  });

  it('reaches steps of reusable workflows and composite actions through nested paths', () => {
    const plan = run(
      `
on: push
jobs:
  call:
    uses: ./.github/workflows/callee.yml
  comp:
    runs-on: ubuntu-latest
    steps:
      - id: c
        uses: ./.github/actions/comp
      - if: steps.c.outcome == 'failure'
        run: echo inner failed
`,
      { event: 'push' },
      [
        { step: 'call/x.t', outcome: 'failure' },
        { step: 'comp.c/#1', outcome: 'failure' },
      ],
      {
        '.github/workflows/callee.yml':
          'on: workflow_call\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - id: t\n        run: npm test\n',
        '.github/actions/comp/action.yml':
          'name: c\nruns:\n  using: composite\n  steps:\n    - run: exit 1\n      shell: bash\n    - if: failure()\n      run: echo\n      shell: bash\n',
      },
    );
    const [call, comp] = plan.workflows.find((w) => w.path === '.github/workflows/ci.yml')!.jobs;
    expect(call!.result).toEqual({ known: true, value: 'failure' });
    expect(call!.legs[0]!.call!.jobs[0]!.result).toEqual({ known: true, value: 'failure' });
    const c = comp!.legs[0]!.steps![0]!;
    expect(c.composite!.steps.map((s) => [s.runs.verdict, s.outcome])).toEqual([
      ['yes', { known: true, value: 'failure' }],
      ['yes', { known: true, value: 'success' }],
    ]);
    expect(c.outcome).toEqual({ known: true, value: 'failure' });
    expect(comp!.legs[0]!.steps![1]!.runs.verdict).toBe('no');
    expect(codes(plan)).toEqual([]);
  });
});

describe('folded script writes', () => {
  it('knows literal outputs and env, last write winning, and a conditional one as candidates (lab 8, 11)', () => {
    const plan = run(
      `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    outputs:
      k: \${{ steps.w.outputs.k }}
      m: \${{ steps.w.outputs.m }}
    steps:
      - id: w
        run: |
          echo "k=first" >> "$GITHUB_OUTPUT"
          echo "k=second" >> "$GITHUB_OUTPUT"
          {
            echo "m<<EOF"
            echo "line one"
            echo "line two"
            echo "EOF"
          } >> "$GITHUB_OUTPUT"
          echo "MODE=ci" >> "$GITHUB_ENV"
      - if: env.MODE == 'ci' && steps.w.outputs.k == 'second'
        run: echo gated
  b:
    needs: a
    if: needs.a.outputs.k == 'second' && contains(needs.a.outputs.m, 'two')
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - id: v
        run: |
          if [ "\${{ matrix.n }}" = "2" ]; then
            echo "v=" >> "$GITHUB_OUTPUT"
          else
            echo "v=\${{ matrix.n }}" >> "$GITHUB_OUTPUT"
          fi
          echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - if: steps.v.outputs.v == ''
        run: echo empty
`,
      { event: 'push' },
      [],
    );
    const [a, b] = plan.workflows[0]!.jobs;
    expect(a!.outputs).toEqual({
      k: { known: true, value: 'second' },
      m: { known: true, value: 'line one\nline two' },
    });
    expect(a!.legs[0]!.steps![1]!.runs.verdict).toBe('yes');
    expect(b!.runs.verdict).toBe('yes');
    const [leg1, leg2] = b!.legs;
    expect(leg1!.steps![0]!.outputs.v).toEqual({
      known: false,
      unknowns: [`${leg1!.steps![0]!.id}.outputs.v`],
      oneOf: ['', '1'],
    });
    expect(leg2!.steps![0]!.outputs.v).toEqual({
      known: false,
      unknowns: [`${leg2!.steps![0]!.id}.outputs.v`],
      oneOf: ['', '2'],
    });
    expect(leg1!.steps![0]!.outputs.sha).toEqual({
      known: false,
      unknowns: [`${leg1!.steps![0]!.id}.outputs.sha`],
    });
    expect(leg1!.steps![1]!.runs.verdict).toBe('maybe');
    expect(
      run(
        `
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: v
        run: echo "v=\${{ github.event_name }}" >> "$GITHUB_OUTPUT"
      - if: steps.v.outputs.v == 'push'
        run: echo
`,
        { event: 'push' },
        [],
      ).workflows[0]!.jobs[0]!.legs[0]!.steps![1]!.runs.verdict,
    ).toBe('yes');
  });
});
