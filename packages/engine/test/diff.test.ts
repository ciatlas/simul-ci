import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffPlans, type PlanDiff, type RunPlan, type ScenarioInput, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const CI = '.github/workflows/ci.yml';
const OTHER = '.github/workflows/other.yml';

const ci = `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: compile
        run: make
      - name: Upload
        run: echo up
  deploy:
    name: Deploy
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;

const other = `
on: push
jobs:
  o:
    runs-on: ubuntu-latest
    steps: [{ run: echo o }]
`;

const run = (files: Record<string, string>, scenario: ScenarioInput = { event: 'push' }): RunPlan =>
  simulate({ files, scenario });

/** The plan of `ci.yml` (and `other.yml`), with `ci.yml` edited by `edit`. */
const planOf = (edit: (text: string) => string = (t) => t, extra: Record<string, string> = {}): RunPlan =>
  run({ [CI]: edit(ci), [OTHER]: other, ...extra });

const EMPTY: PlanDiff = {
  added: [],
  removed: [],
  changed: [],
  checks: { added: [], removed: [], changed: [] },
};

describe('diffPlans', () => {
  it('finds nothing between two plans of the same files', () => {
    expect(diffPlans(planOf(), planOf())).toEqual(EMPTY);
    const plan = planOf();
    expect(diffPlans(plan, plan)).toEqual(EMPTY);
  });

  it('lists an added job, not its legs or its steps, and its check', () => {
    const after = planOf(
      (t) =>
        `${t}  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n      - run: npm run types\n`,
    );
    expect(diffPlans(planOf(), after)).toEqual({
      ...EMPTY,
      added: [{ id: `${CI}#lint`, kind: 'job', verdict: 'yes' }],
      checks: { added: ['lint'], removed: [], changed: [] },
    });
  });

  it('lists a removed job by its id in before, and a removed workflow alone', () => {
    const before = planOf();
    const after = run({ [CI]: ci.slice(0, ci.indexOf('  deploy:')) });
    expect(diffPlans(before, after)).toEqual({
      ...EMPTY,
      removed: [
        { id: `${CI}#deploy`, kind: 'job', verdict: 'yes' },
        { id: OTHER, kind: 'workflow', verdict: 'yes' },
      ],
      checks: { added: [], removed: ['Deploy', 'o'], changed: [] },
    });
  });

  it('lists a verdict flip at the outermost node that changed, with its check', () => {
    const after = planOf((t) => t.replace('    needs: build\n', '    needs: build\n    if: false\n'));
    expect(diffPlans(planOf(), after)).toEqual({
      ...EMPTY,
      changed: [{ id: `${CI}#deploy`, kind: 'job', from: 'yes', to: 'no' }],
      checks: { added: [], removed: [], changed: [{ name: 'Deploy', from: 'yes', to: 'no' }] },
    });
  });

  it('lists a step whose verdict flips under a job that did not', () => {
    const after = planOf((t) =>
      t.replace('      - name: Upload\n', '      - name: Upload\n        if: false\n'),
    );
    expect(diffPlans(planOf(), after)).toEqual({
      ...EMPTY,
      changed: [{ id: `${CI}#build/~upload`, kind: 'step', from: 'yes', to: 'no' }],
    });
  });

  it('lists a workflow that is no longer triggered, not its jobs, though its plan has none', () => {
    const after = planOf((t) => t.replace('on: push', 'on: pull_request'));
    expect(after.workflows[0]!.jobs).toEqual([]);
    expect(diffPlans(planOf(), after)).toEqual({
      ...EMPTY,
      changed: [{ id: CI, kind: 'workflow', from: 'yes', to: 'no' }],
      checks: { added: [], removed: ['build', 'Deploy'], changed: [] },
    });
  });

  it('says a check name changed when only the name did', () => {
    const after = planOf((t) => t.replace('name: Deploy', 'name: Ship'));
    expect(diffPlans(planOf(), after)).toEqual({
      ...EMPTY,
      checks: { added: ['Ship'], removed: ['Deploy'], changed: [] },
    });
  });

  it('matches the k-th check of a name with the k-th, so a second check of a name is added', () => {
    const before = planOf((t) => t.replace('name: Deploy', 'name: o'));
    const after = planOf((t) =>
      t.replace('name: Deploy', 'name: o').replace('needs: build', 'needs: build\n    if: false'),
    );
    expect(diffPlans(before, after).checks).toEqual({
      added: [],
      removed: [],
      changed: [{ name: 'o', from: 'yes', to: 'no' }],
    });
    expect(diffPlans(planOf(), before).checks).toEqual({ added: ['o'], removed: ['Deploy'], changed: [] });
  });
});

describe('diffPlans with renames', () => {
  const renamed = (text: string) =>
    text.replace('  build:', '  compile:').replace('needs: build', 'needs: compile');

  it('without renames, a renamed job is one removed and one added', () => {
    expect(diffPlans(planOf(), planOf(renamed))).toEqual({
      ...EMPTY,
      added: [{ id: `${CI}#compile`, kind: 'job', verdict: 'yes' }],
      removed: [{ id: `${CI}#build`, kind: 'job', verdict: 'yes' }],
      checks: { added: ['compile'], removed: ['build'], changed: [] },
    });
  });

  it('with the rename, the job, its steps and its verdicts match, and the check name still changes', () => {
    const renames = { [`${CI}#build`]: `${CI}#compile` };
    expect(diffPlans(planOf(), planOf(renamed), { renames })).toEqual({
      ...EMPTY,
      checks: { added: ['compile'], removed: ['build'], changed: [] },
    });
    const skipped = (t: string) =>
      renamed(t).replace('      - name: Upload\n', '      - name: Upload\n        if: false\n');
    expect(diffPlans(planOf(), planOf(skipped), { renames }).changed).toEqual([
      { id: `${CI}#compile/~upload`, kind: 'step', from: 'yes', to: 'no' },
    ]);
  });

  it('renames an id only where a part of it ends, and by the longest prefix', () => {
    const docs = '  build-docs:\n    runs-on: ubuntu-latest\n    steps: [{ run: make docs }]\n';
    const before = planOf((t) => `${t}${docs}`);
    const after = planOf((t) => `${renamed(t).replace('id: compile', 'id: make')}${docs}`);
    const renames = {
      [`${CI}#build`]: `${CI}#compile`,
      [`${CI}#build/steps.compile`]: `${CI}#compile/steps.make`,
    };
    expect(diffPlans(before, after, { renames })).toEqual({
      ...EMPTY,
      checks: { added: ['compile'], removed: ['build'], changed: [] },
    });
  });

  it('does not depend on the order of the renames', () => {
    const before = planOf();
    const after = planOf((t) => t.replace('  build:', '  b:').replace('  deploy:', '  d:'));
    const one = { [`${CI}#build`]: `${CI}#b`, [`${CI}#deploy`]: `${CI}#d` };
    const two = { [`${CI}#deploy`]: `${CI}#d`, [`${CI}#build`]: `${CI}#b` };
    expect(diffPlans(before, after, { renames: one })).toEqual(diffPlans(before, after, { renames: two }));
  });
});

describe('diffPlans and legs', () => {
  const matrix = (values: string) => (t: string) =>
    t.replace(
      '  build:\n    runs-on: ubuntu-latest\n',
      `  build:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        n: [${values}]\n`,
    );

  it('lists a leg a matrix gains, with its check', () => {
    expect(diffPlans(planOf(matrix('1, 2')), planOf(matrix('1, 2, 3')))).toEqual({
      ...EMPTY,
      added: [{ id: `${CI}#build[n=3]`, kind: 'leg', verdict: 'yes' }],
      checks: { added: ['build (3)'], removed: [], changed: [] },
    });
  });

  it('a job that gains a matrix loses its one bare leg and gains the new legs, not every step', () => {
    expect(diffPlans(planOf(), planOf(matrix('1, 2')))).toEqual({
      ...EMPTY,
      added: [
        { id: `${CI}#build[n=1]`, kind: 'leg', verdict: 'yes' },
        { id: `${CI}#build[n=2]`, kind: 'leg', verdict: 'yes' },
      ],
      removed: [{ id: `${CI}#build`, kind: 'leg', verdict: 'yes' }],
      checks: { added: ['build (1)', 'build (2)'], removed: ['build'], changed: [] },
    });
  });

  it('a matrix job now skipped is the job: no leg changed, removed or added', () => {
    const skipped = (t: string) => matrix('1, 2')(t).replace('  build:\n', '  build:\n    if: false\n');
    expect(diffPlans(planOf(matrix('1, 2')), planOf(skipped))).toEqual({
      ...EMPTY,
      changed: [
        { id: `${CI}#build`, kind: 'job', from: 'yes', to: 'no' },
        { id: `${CI}#deploy`, kind: 'job', from: 'yes', to: 'no' },
      ],
      // GitHub reports a skipped matrix job as one check named by its stem.
      checks: {
        added: ['build'],
        removed: ['build (1)', 'build (2)'],
        changed: [{ name: 'Deploy', from: 'yes', to: 'no' }],
      },
    });
  });
});

describe('diffPlans on the routes lab', () => {
  const lab = join(import.meta.dirname, '../../../fixtures/routes-lab/repo');
  const files = walk(lab);
  const LITERAL = '.github/workflows/case-if-boolean-literal.yml';
  const CALLER = '.github/workflows/case-reusable-all-skipped.yml';
  const CALLEE = '.github/workflows/callee-skipped.yml';
  const COMPOSITE = '.github/workflows/case-composite-action-status.yml';
  const ACTION = '.github/actions/comp/action.yml';

  it('finds nothing between two plans of the lab, for every event it listens to', () => {
    for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
      expect(diffPlans(run(files, { event }), run(files, { event }))).toEqual(EMPTY);
    }
  });

  it('a job of the lab that now runs, not the steps its skipped plan left out', () => {
    const after = {
      ...files,
      [LITERAL]: files[LITERAL]!.replace('  skipped:\n    if: false', '  skipped:\n    if: true'),
    };
    expect(diffPlans(run(files), run(after))).toEqual({
      ...EMPTY,
      changed: [{ id: `${LITERAL}#skipped`, kind: 'job', from: 'no', to: 'yes' }],
      checks: { added: [], removed: [], changed: [{ name: 'skipped', from: 'no', to: 'yes' }] },
    });
  });

  it('a job added to a called workflow is added under the leg that calls it', () => {
    const job = '  z:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo z }]\n';
    const after = { ...files, [CALLEE]: `${files[CALLEE]}${job}` };
    const diff = diffPlans(run(files), run(after));
    expect(diff.added).toEqual([{ id: `${CALLER}#call>${CALLEE}#z`, kind: 'job', verdict: 'yes' }]);
    expect(diff.removed).toEqual([]);
    expect(diff.checks.added).toEqual(['call / z']);
  });

  it('a step added to a composite action is added under each step that uses it', () => {
    const step = '    - name: inner new\n      shell: bash\n      run: echo new\n';
    const after = { ...files, [ACTION]: `${files[ACTION]}${step}` };
    expect(diffPlans(run(files), run(after))).toEqual({
      ...EMPTY,
      added: [{ id: `${COMPOSITE}#a/steps.u>.github/actions/comp/~inner-new`, kind: 'step', verdict: 'yes' }],
    });
  });

  it('lists in plan order, the same every time', () => {
    const after = {
      ...files,
      [LITERAL]: files[LITERAL]!.replace('  skipped:\n    if: false', '  skipped:\n    if: true'),
      [CALLEE]: `${files[CALLEE]}  z:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo z }]\n`,
      '.github/workflows/zz-new.yml': other,
      '.github/workflows/aa-new.yml': other,
    };
    const diff = diffPlans(run(files), run(after));
    expect(diff).toEqual({
      added: [
        { id: '.github/workflows/aa-new.yml', kind: 'workflow', verdict: 'yes' },
        { id: `${CALLER}#call>${CALLEE}#z`, kind: 'job', verdict: 'yes' },
        { id: '.github/workflows/zz-new.yml', kind: 'workflow', verdict: 'yes' },
      ],
      removed: [],
      changed: [
        { id: `${LITERAL}#skipped`, kind: 'job', from: 'no', to: 'yes' },
        // The callee no longer skips every job, so `c` (needs: call, no `if:`) runs.
        { id: `${CALLER}#c`, kind: 'job', from: 'no', to: 'yes' },
      ],
      checks: {
        added: ['o', 'call / z', 'o'],
        removed: [],
        changed: [
          { name: 'skipped', from: 'no', to: 'yes' },
          { name: 'c', from: 'no', to: 'yes' },
        ],
      },
    });
    expect(diffPlans(run(files), run(after))).toEqual(diff);
  });
});

function walk(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, walk(full, rel));
    else out[rel] = readFileSync(full, 'utf8');
  }
  return out;
}
