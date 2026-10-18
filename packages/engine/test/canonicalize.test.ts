import {
  canonicalize,
  planFingerprint,
  type RunPlan,
  restrictPlan,
  type ScenarioInput,
  simulate,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const files = {
  '.github/workflows/ci.yml': `
on: push
jobs:
  zeta:
    runs-on: ubuntu-latest
    steps: [{ run: echo z }]
  alpha:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3]
    steps:
      - if: matrix.n == 2
        run: echo two
      - run: echo "x=\${{ matrix.n }}" >> "$GITHUB_OUTPUT"
        id: out
`,
  '.github/workflows/other.yml': `
on: push
jobs:
  o:
    runs-on: ubuntu-latest
    steps: [{ run: echo o }]
`,
};
const run = (scenario: ScenarioInput = { event: 'push' }): RunPlan => simulate({ files, scenario });

describe('canonicalize', () => {
  it('drops the engine, the schema url, positions and reads, and sorts jobs and keys', () => {
    const c = canonicalize(run(), 'hash') as Record<string, unknown>;
    const text = JSON.stringify(c);
    expect(Object.keys(c)).toEqual([
      'detail',
      'diagnostics',
      'mocks',
      'models',
      'scenario',
      'schemaVersion',
      'unknowns',
      'workflows',
    ]);
    expect(text).not.toContain('"loc"');
    expect(text).not.toContain('"reads"');
    expect(text).not.toContain('"engine"');
    const wf = (c.workflows as { jobs: { jobId: string }[] }[])[0]!;
    expect(wf.jobs.map((j) => j.jobId)).toEqual(['alpha', 'zeta']);
  });

  it('folds the legs a matrix leaves identical, keeping their key, values and check', () => {
    const c = canonicalize(run(), 'snapshot') as {
      workflows: { jobs: { legs: Record<string, unknown>[] }[] }[];
    };
    const legs = c.workflows[0]!.jobs[0]!.legs;
    // n=1 and n=3 skip the same step and write different outputs: nothing folds apart from the key itself.
    expect(legs.map((l) => l.legKey)).toEqual(['n=1', 'n=2', 'n=3']);
    expect(legs.map((l) => l.sameAs)).toEqual([undefined, undefined, undefined]);
    const same = simulate({
      files: {
        '.github/workflows/ci.yml': `
on: push
jobs:
  m:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3]
    steps: [{ run: echo same }]
`,
      },
      scenario: { event: 'push' },
    });
    const folded = (canonicalize(same, 'snapshot') as typeof c).workflows[0]!.jobs[0]!.legs;
    expect(folded[0]!.sameAs).toBeUndefined();
    expect(folded[1]).toEqual({
      legKey: 'n=2',
      sameAs: 'n=1',
      values: { n: { known: true, value: 2 } },
      check: { name: 'm (2)', certain: true },
    });
    expect(folded[2]!.sameAs).toBe('n=1');
    expect((canonicalize(same, 'hash') as typeof c).workflows[0]!.jobs[0]!.legs[1]!.sameAs).toBeUndefined();
  });

  it('restricts a plan to one workflow and fingerprints behaviour', () => {
    const p = run();
    const one = restrictPlan(p, p.workflows[0]!.id);
    expect(one.workflows.map((w) => w.path)).toEqual(['.github/workflows/ci.yml']);
    expect(one.unknowns).toEqual([]);
    expect(planFingerprint(p)).toBe(planFingerprint(run()));
    expect(planFingerprint(p)).toMatch(/^[0-9a-f]{8}$/);
    expect(planFingerprint(p)).not.toBe(planFingerprint(run({ event: 'push', branch: 'topic' })));
  });
});
