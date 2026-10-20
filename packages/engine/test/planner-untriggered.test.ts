import { checksOf, loadFiles, type RunPlan, type ScenarioInput, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const CALLEE = '.github/workflows/callee.yml';
const push: ScenarioInput = { event: 'push', branch: 'main' };

/** CI runs on the push and calls the callee; Release, untriggered by it, shares the job id `build` with CI. */
const files = {
  [CI]: `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: d
        run: echo "v=$(date)" >> "$GITHUB_OUTPUT"
      - if: steps.d.outputs.v
        run: echo
  call:
    uses: ./.github/workflows/callee.yml
`,
  [RELEASE]: `
name: Release
on:
  push:
    branches: ['release/**']
env:
  ACTOR: \${{ github.actor }}
jobs:
  build:
    runs-on: ubuntu-latest
    continue-on-error: \${{ github.actor == 'bot' }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - run: echo build
  publish:
    needs: build
    uses: ./.github/workflows/callee.yml
    with:
      tag: \${{ github.ref_name }}
`,
  [CALLEE]: `
on: workflow_call
jobs:
  x:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`,
};

const run = (planUntriggered?: string[]): RunPlan =>
  simulate({ files, scenario: push, ...(planUntriggered ? { planUntriggered } : {}) });

const depth0 = (plan: RunPlan, path: string) => plan.workflows.find((w) => w.path === path && w.depth === 0)!;

/** The plan with the depth-0 jobs of `paths` taken out, as a plan without the option has them. */
function withoutJobsOf(plan: RunPlan, paths: string[]): RunPlan {
  const copy = structuredClone(plan);
  for (const path of paths) depth0(copy, path).jobs = [];
  return copy;
}

describe('simulate: planUntriggered', () => {
  it('leaves an untriggered workflow without jobs when not asked', () => {
    const release = depth0(run(), RELEASE);
    expect(release.triggered.verdict).toBe('no');
    expect(release.jobs).toEqual([]);
  });

  it('plans a listed untriggered workflow’s jobs, each skipped under the workflow', () => {
    const release = depth0(run([RELEASE]), RELEASE);
    expect(release.triggered.verdict).toBe('no');
    expect(release.conclusion).toEqual({ known: true, value: 'skipped' });
    expect(release.jobs.map((j) => j.jobId)).toEqual(['build', 'publish']);
    for (const job of release.jobs) {
      expect(job.runs).toEqual({ verdict: 'no', chain: [{ kind: 'parent', node: RELEASE, verdict: 'no' }] });
      expect(job.result).toEqual({ known: true, value: 'skipped' });
      expect(job.legs.map((l) => [l.runs.verdict, l.result])).toEqual([
        ['no', { known: true, value: 'skipped' }],
      ]);
    }
    const [build, publish] = release.jobs;
    expect(build!.matrix?.count).toBe(2);
    expect(build!.continueOnError).toEqual({
      known: false,
      unknowns: [`${RELEASE}#build.continue-on-error`],
    });
    expect(publish!.needs).toEqual([`${RELEASE}#build`]);
    expect(publish!.uses).toBe('./.github/workflows/callee.yml');
    expect(publish!.legs[0]!.call).toBeUndefined();
  });

  it('changes nothing else: the workflow’s own fields, the unknowns and their pins, the checks', () => {
    const plain = run();
    const asked = run([RELEASE]);
    expect(withoutJobsOf(asked, [RELEASE])).toEqual(plain);
    expect(asked.unknowns.map((u) => u.id)).not.toContain(`${RELEASE}#build.continue-on-error`);
    // Release's `build` is no planned unit, so CI's pin needs no `workflow:`.
    expect(asked.unknowns.find((u) => u.id === `${CI}#build/steps.d.outputs.v`)?.pin?.fragment).toEqual({
      step: 'build.d',
      outputs: { v: '' },
    });
    expect(checksOf(asked)).toEqual(checksOf(plain));
    expect(checksOf(asked).map((c) => c.name)).toEqual(['build', 'call / x']);
  });

  it('plans only listed depth-0 workflows the scenario leaves untriggered', () => {
    const plain = run();
    // A triggered workflow is planned as always.
    expect(run([CI])).toEqual(plain);
    // The callee's depth-0 instance gets its job; the instance CI calls stays as it was.
    const asked = run([CALLEE, '.github/workflows/missing.yml']);
    expect(depth0(asked, CALLEE).jobs.map((j) => [j.jobId, j.runs.verdict])).toEqual([['x', 'no']]);
    expect(withoutJobsOf(asked, [CALLEE])).toEqual(plain);
    expect(depth0(asked, RELEASE).jobs).toEqual([]);
  });

  it('takes the option with a loaded project, the way the web worker simulates', () => {
    const plan = simulate({
      project: loadFiles(files),
      scenario: push,
      assume: [],
      detail: 'steps',
      planUntriggered: [RELEASE],
    });
    expect(plan).toEqual(run([RELEASE]));
  });
});
