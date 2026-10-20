import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { graphModel } from '../src/graph/model';
import { shapeHash } from '../src/graph/shape';
import type { GraphModel, GraphUi, JobModel } from '../src/graph/types';
import { sampleByName } from '../src/input/samples';
import { handle, initialState } from '../src/worker/handle';

const workflows = join(import.meta.dirname, '../../../fixtures/routes-lab/repo/.github');
const lab: Record<string, string> = {
  '.github/actions/comp/action.yml': readFileSync(join(workflows, 'actions/comp/action.yml'), 'utf8'),
};
for (const name of readdirSync(join(workflows, 'workflows')))
  lab[`.github/workflows/${name}`] = readFileSync(join(workflows, 'workflows', name), 'utf8');
const starter = sampleByName('starter')!.files;
const monorepo = sampleByName('monorepo')!.files;

const UI: GraphUi = { expanded: [], representative: {}, opened: [], hideUntriggered: false };

/** The model of one repository's plan, as the canvas would get it from the worker's answer. */
function modelOf(
  files: Record<string, string>,
  scenario: ScenarioInput,
  ui: Partial<GraphUi> = {},
  assume: AssumeEntry[] = [],
): GraphModel {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  const r = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume,
    detail: 'steps',
  });
  if (r.response.type !== 'plan') throw new Error(JSON.stringify(r.response));
  return graphModel(r.response.plan, r.response.derived, { ...UI, ...ui });
}

const ci = '.github/workflows/ci.yml';
const release = '.github/workflows/release.yml';
const push: ScenarioInput = { event: 'push', branch: 'main' };
const pushSrc: ScenarioInput = { ...push, changed: ['src/a.ts'] };
const shapes = (m: GraphModel) => Object.fromEntries(Object.values(m.scopes).map((s) => [s.id, s.shape]));

/** A workflow on push of one-step jobs, each with the extra lines given (`needs:`, `if:`). */
function workflow(jobs: Record<string, string[]>): string {
  const lines = ['on: push', 'jobs:'];
  for (const [id, extra] of Object.entries(jobs)) {
    lines.push(`  ${id}:`);
    for (const line of extra) lines.push(`    ${line}`);
    lines.push('    runs-on: ubuntu-latest', '    steps:', `      - run: ${id}`);
  }
  return `${lines.join('\n')}\n`;
}

describe('the graph model', () => {
  it('stacks the depth-0 workflows in plan order, untriggered ones collapsed in place or left out', () => {
    const m = modelOf(starter, push);
    expect(m.roots).toEqual([ci, release]);
    expect(m.scopes[release]).toMatchObject({
      collapsed: true,
      verdict: 'no',
      depth: 0,
      jobs: [],
      edges: [],
    });
    expect(m.scopes[release]!.clause).toBe('tags [v*] ← main: false');
    expect(m.scopes[ci]).toMatchObject({ collapsed: false, verdict: 'maybe', name: 'CI', path: ci });
    expect(m.scopes[ci]!.caller).toBeUndefined();
    const hidden = modelOf(starter, push, { hideUntriggered: true });
    expect(hidden.roots).toEqual([ci]);
    expect(hidden.scopes[release]).toBeUndefined();
    const all = modelOf(lab, push);
    const untriggered = all.roots.filter((id) => all.scopes[id]!.collapsed);
    expect(untriggered).toContain('.github/workflows/callee-echo.yml');
    expect(modelOf(lab, push, { hideUntriggered: true }).roots).toEqual(
      all.roots.filter((id) => !untriggered.includes(id)),
    );
  });

  it('counts a scope’s own jobs by verdict', () => {
    expect(modelOf(starter, push).scopes[ci]!.counts).toEqual({ yes: 0, no: 1, maybe: 3 });
    expect(modelOf(starter, pushSrc).scopes[ci]!.counts).toEqual({ yes: 3, no: 1, maybe: 0 });
    expect(modelOf(starter, pushSrc).scopes[release]!.counts).toEqual({ yes: 0, no: 0, maybe: 0 });
  });

  it('words a card: the clause unless the job plainly runs, the result where it adds to the verdict', () => {
    const runs = modelOf(starter, pushSrc).jobs;
    expect(runs[`${ci}#test`]).toMatchObject({
      label: 'test',
      jobId: 'test',
      verdict: 'yes',
      check: 'test (…)',
      count: 2,
    });
    expect(runs[`${ci}#test`]!.clause).toBeUndefined();
    expect(runs[`${ci}#test`]!.result).toBeUndefined();
    expect(runs[`${ci}#deploy`]!.needs).toEqual([`${ci}#test`, `${ci}#build`]);
    // Skipped, or skipped and success for a job that might run: the verdict word already says as much.
    expect(runs[`${ci}#preview`]).toMatchObject({ verdict: 'no', scope: ci });
    expect(runs[`${ci}#preview`]!.result).toBeUndefined();
    expect(runs[`${ci}#preview`]!.clause).toMatch(/^if: github.event_name == 'pull_request' .* → false/);
    const might = modelOf(starter, push).jobs;
    expect(might[`${ci}#build`]).toMatchObject({ verdict: 'maybe', clause: 'parent maybe' });
    expect(might[`${ci}#build`]!.result).toBeUndefined();
    expect(might[`${ci}#build`]!.count).toBeUndefined();
    // A call that runs, all of whose jobs are skipped, is itself skipped: news the verdict does not carry.
    const call = '.github/workflows/case-reusable-all-skipped.yml#call';
    expect(modelOf(lab, push).jobs[call]).toMatchObject({ verdict: 'yes', result: 'skipped' });
    expect(modelOf(monorepo, push).jobs[`${ci}#web`]!.uses).toBe('./.github/workflows/package.yml');
  });

  it('puts a matrix’s legs in a grid and leaves a single unnamed leg out', () => {
    const m = modelOf(starter, pushSrc);
    expect(m.jobs[`${ci}#test`]!.legs).toEqual([
      { id: `${ci}#test[node=22]`, legKey: 'node=22', label: 'node=22', verdict: 'yes' },
      { id: `${ci}#test[node=24]`, legKey: 'node=24', label: 'node=24', verdict: 'yes' },
    ]);
    expect(m.jobs[`${ci}#build`]!.legs).toBeUndefined();
    const two = {
      ...starter,
      [ci]: starter[ci]!.replace('node: [22, 24]', 'node: [22, 24]\n        os: [linux]'),
    };
    expect(modelOf(two, pushSrc).jobs[`${ci}#test`]!.legs!.map((l) => l.label)).toEqual([
      '22 · linux',
      '24 · linux',
    ]);
    const skipped = { ...starter, [ci]: starter[ci]!.replace('  test:\n', '  test:\n    if: false\n') };
    const job = modelOf(skipped, pushSrc).jobs[`${ci}#test`]!;
    expect(job).toMatchObject({ verdict: 'no', steps: [], count: 2 });
    expect(job.legs).toBeUndefined();
  });

  it('draws a matrix only the run knows as one ∗ cell with the matrix reason, and its size as ?', () => {
    const dynamic = {
      [ci]: [
        'on: push',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    strategy:',
        '      matrix: ${{ fromJSON(vars.M) }}',
        '    steps:',
        '      - run: make',
        '  lint:',
        '    if: false',
        '    runs-on: ubuntu-latest',
        '    strategy:',
        '      matrix: ${{ fromJSON(vars.M) }}',
        '    steps:',
        '      - run: lint',
        '',
      ].join('\n'),
    };
    const m = modelOf(dynamic, push);
    expect(m.jobs[`${ci}#build`]).toMatchObject({ verdict: 'yes', count: '?' });
    expect(m.jobs[`${ci}#build`]!.legs).toEqual([
      {
        id: `${ci}#build[*]`,
        legKey: '*',
        label: '∗',
        verdict: 'maybe',
        reason: `matrix only the run knows (${ci}#build.matrix)`,
      },
    ]);
    // Skipped, it has no leg at all, and still its size.
    expect(m.jobs[`${ci}#lint`]).toMatchObject({ verdict: 'no', count: '?' });
    expect(m.jobs[`${ci}#lint`]!.legs).toBeUndefined();
  });

  it('shows the representative leg’s steps: the author’s pick when it is a leg, else the first', () => {
    const first = modelOf(starter, pushSrc).jobs[`${ci}#test`]!;
    expect(first.representative).toBe(`${ci}#test[node=22]`);
    expect(first.steps.map((s) => s.label)).toEqual([
      'actions/checkout@v4',
      'actions/setup-node@v4',
      '~npm-ci',
      '~npm-test',
    ]);
    expect(first.steps[0]).toEqual({
      id: `${ci}#test[node=22]/~actions-checkout`,
      label: 'actions/checkout@v4',
      verdict: 'yes',
      inner: [],
    });
    const leg = `${ci}#test[node=24]`;
    const picked = modelOf(starter, pushSrc, { representative: { [`${ci}#test`]: leg } }).jobs[`${ci}#test`]!;
    expect(picked.representative).toBe(leg);
    expect(picked.steps.every((s) => s.id.startsWith(`${leg}/`))).toBe(true);
    const stale = modelOf(starter, pushSrc, { representative: { [`${ci}#test`]: `${ci}#test[node=20]` } });
    expect(stale.jobs[`${ci}#test`]!.representative).toBe(`${ci}#test[node=22]`);
  });

  it('lists a composite action’s inner steps under its step and summarises outputs', () => {
    const publish = modelOf(starter, { event: 'push', tag: 'v1.0.0' }).jobs[`${release}#publish`]!;
    expect(publish.steps.map((s) => s.label)).toEqual([
      'actions/checkout@v4',
      './.github/actions/setup',
      '~npm-publish-provenance',
    ]);
    expect(publish.steps[1]!.inner.map((s) => s.label)).toEqual([
      'actions/setup-node@v4',
      'actions/cache@v4',
      '~npm-ci',
    ]);
    expect(modelOf(starter, push).jobs[`${ci}#build`]!.steps[1]).toMatchObject({
      label: 'detect',
      outputs: 'changed=?',
    });
    const filter = modelOf(monorepo, { event: 'pull_request', base: 'main', changed: ['apps/web/a.ts'] })
      .jobs[`${ci}#changes`]!.steps[1]!;
    expect(filter.outputs).toBe('changes=["web"] web=true api=false');
  });

  it('opens the step lists the author expanded', () => {
    const m = modelOf(starter, push, { expanded: [`${ci}#build`] });
    expect(m.jobs[`${ci}#build`]!.expanded).toBe(true);
    expect(m.jobs[`${ci}#test`]!.expanded).toBe(false);
  });

  it('nests the workflow a job’s representative leg calls as a scope of its own', () => {
    const m = modelOf(monorepo, push);
    const callee = `${ci}#web>.github/workflows/package.yml`;
    expect(m.roots).toEqual([ci, '.github/workflows/package.yml']);
    expect(m.jobs[`${ci}#web`]!.callee).toBe(callee);
    expect(m.jobs[`${ci}#web`]!.steps).toEqual([]);
    expect(m.scopes[callee]).toMatchObject({
      caller: `${ci}#web`,
      depth: 1,
      verdict: 'maybe',
      clause: 'parent maybe',
      collapsed: false,
      jobs: [`${callee}#test`, `${callee}#lint`],
      counts: { yes: 0, no: 0, maybe: 2 },
    });
    expect(m.jobs[`${callee}#lint`]).toMatchObject({ scope: callee, label: 'lint' });
    // Parents first, in plan order: a scope before its jobs, a job before the workflow it calls.
    const api = `${ci}#api>.github/workflows/package.yml`;
    expect(Object.keys(m.scopes)).toEqual([ci, callee, api, '.github/workflows/package.yml']);
    expect(Object.keys(m.jobs)).toEqual([
      `${ci}#changes`,
      `${ci}#web`,
      `${callee}#test`,
      `${callee}#lint`,
      `${ci}#api`,
      `${api}#test`,
      `${api}#lint`,
      `${ci}#gate`,
    ]);
    const pr = modelOf(monorepo, { event: 'pull_request', base: 'main', changed: ['apps/web/a.ts'] });
    expect(pr.jobs[`${ci}#api`]!.callee).toBeUndefined();
    expect(pr.scopes[`${ci}#api>.github/workflows/package.yml`]).toBeUndefined();
  });

  it('collapses a callee past depth 2 until the author opens it', () => {
    const call = (next: string) =>
      `on: [push, workflow_call]\njobs:\n  go:\n    uses: ./.github/workflows/${next}.yml\n`;
    const files = {
      '.github/workflows/a.yml': call('b').replace(', workflow_call', ''),
      '.github/workflows/b.yml': call('c').replace('push, ', ''),
      '.github/workflows/c.yml': call('d').replace('push, ', ''),
      '.github/workflows/d.yml':
        'on: workflow_call\njobs:\n  leaf:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo leaf\n',
    };
    const closed = modelOf(files, push);
    const deep = Object.values(closed.scopes).find((s) => s.depth === 3)!;
    expect(deep.path).toBe('.github/workflows/d.yml');
    expect(deep).toMatchObject({ collapsed: true, jobs: [], edges: [], counts: { yes: 1, no: 0, maybe: 0 } });
    expect(Object.values(closed.scopes).filter((s) => s.depth > 0 && s.depth < 3 && s.collapsed)).toEqual([]);
    const open = modelOf(files, push, { opened: [deep.id] });
    expect(open.scopes[deep.id]).toMatchObject({ collapsed: false, jobs: [`${deep.id}#leaf`] });
    expect(open.scopes[deep.id]!.shape).not.toBe(deep.shape);
    expect(open.scopes['.github/workflows/a.yml']!.shape).not.toBe(
      closed.scopes['.github/workflows/a.yml']!.shape,
    );
  });

  it('draws an edge per need, the deciding one labelled with the result that decided it', () => {
    const need = '.github/workflows/case-skipped-need.yml';
    const m = modelOf(lab, push);
    // b's implicit success() and f's written one both turn on a's skip; always(), failure() and !cancelled() do not.
    const edge = (j: string, deciding: boolean) => ({
      id: `${need}#a->${need}#${j}`,
      source: `${need}#a`,
      target: `${need}#${j}`,
      from: 'no',
      deciding,
      ...(deciding ? { label: 'result: skipped' } : {}),
    });
    expect(m.scopes[need]!.edges).toEqual([
      edge('b', true),
      edge('c', false),
      edge('d', false),
      edge('e', false),
      edge('f', true),
    ]);
    const call = '.github/workflows/case-reusable-all-skipped.yml';
    expect(m.scopes[call]!.edges.map((e) => [e.id, e.deciding, e.label])).toEqual([
      [`${call}#call->${call}#b`, false, undefined],
      [`${call}#call->${call}#c`, true, 'result: skipped'],
    ]);
    expect(modelOf(starter, pushSrc).scopes[ci]!.edges.filter((e) => e.deciding)).toEqual([]);
  });

  it('draws no deciding edge where no result of the needs could have changed the answer', () => {
    // A push: preview's `if:` is false whatever build's result, unknown as it is.
    const preview = modelOf(starter, push).scopes[ci]!.edges.find((e) => e.target === `${ci}#preview`)!;
    expect(preview).toMatchObject({ from: 'maybe', deciding: false });
    expect(preview.label).toBeUndefined();
    // A pull request: deploy's `if:` is false for the event, and assuming its needs succeed would not change it.
    const scenario: ScenarioInput = { event: 'pull_request', base: 'main', changed: ['src/a.ts'] };
    const pr = modelOf(starter, scenario);
    expect(pr.jobs[`${ci}#deploy`]).toMatchObject({ verdict: 'no' });
    expect(pr.scopes[ci]!.edges.filter((e) => e.deciding)).toEqual([]);
    // Nor once a test leg of an opened pull request is known to fail: deploy stays false for the event whatever
    // test and build did, while build, and preview after it, would have run had their needs succeeded.
    const failed = modelOf(starter, { ...scenario, action: 'opened' }, {}, [
      { step: 'test[node=22].#4', outcome: 'failure' },
    ]);
    expect(failed.jobs[`${ci}#deploy`]).toMatchObject({ verdict: 'no' });
    expect(failed.scopes[ci]!.edges.filter((e) => e.deciding).map((e) => [e.id, e.label])).toEqual([
      [`${ci}#test->${ci}#build`, 'result: failure'],
      [`${ci}#build->${ci}#preview`, 'result: skipped'],
    ]);
  });

  it('draws no deciding edge from a skipped need to a job whose `if:` is false for the event anyway', () => {
    const m = modelOf(
      {
        [ci]: workflow({
          a: ['if: false'],
          b: ['needs: a', "if: github.event_name == 'pull_request'"],
          c: ['needs: a', "if: github.event_name == 'push'"],
        }),
      },
      push,
    );
    expect(m.jobs[`${ci}#b`]).toMatchObject({ verdict: 'no' });
    expect(m.scopes[ci]!.edges.map((e) => [e.target, e.deciding, e.label])).toEqual([
      [`${ci}#b`, false, undefined],
      [`${ci}#c`, true, 'result: skipped'],
    ]);
  });

  it('reads the status functions as GitHub does, in any case and with a space before the parentheses', () => {
    const m = modelOf(
      {
        [ci]: workflow({
          a: ['if: false'],
          b: ['needs: a', 'if: Success()'],
          c: ['needs: a', "if: success () && github.event_name == 'push'"],
        }),
      },
      push,
    );
    expect(m.jobs[`${ci}#b`]).toMatchObject({ verdict: 'no' });
    expect(m.jobs[`${ci}#c`]).toMatchObject({ verdict: 'no' });
    expect(m.scopes[ci]!.edges.map((e) => [e.target, e.deciding, e.label])).toEqual([
      [`${ci}#b`, true, 'result: skipped'],
      [`${ci}#c`, true, 'result: skipped'],
    ]);
  });

  it('draws a need only the run knows as deciding only while no other need is known not to succeed', () => {
    const files = {
      [ci]: workflow({
        a: [],
        u: ["if: github.actor == 'me'"],
        b: ['needs: [a, u]'],
      }),
    };
    const open = modelOf(files, push);
    expect(open.jobs[`${ci}#b`]).toMatchObject({ verdict: 'maybe' });
    expect(open.scopes[ci]!.edges.map((e) => [e.source, e.deciding, e.label])).toEqual([
      [`${ci}#a`, false, undefined],
      [`${ci}#u`, true, 'result: ?'],
    ]);
    // a's failure keeps success() false whatever u does: u's result can no longer change b's answer.
    const failed = modelOf(files, push, {}, [{ job: 'a', outcome: 'failure' }]);
    expect(failed.jobs[`${ci}#b`]).toMatchObject({ verdict: 'no' });
    expect(failed.scopes[ci]!.edges.map((e) => [e.source, e.deciding, e.label])).toEqual([
      [`${ci}#a`, true, 'result: failure'],
      [`${ci}#u`, false, undefined],
    ]);
  });

  it('reads a need’s result where the condition names it, as the status functions read it', () => {
    const m = modelOf(
      {
        [ci]: workflow({
          a: ['if: false'],
          b: ['needs: a', "if: always() && needs.a.result == 'success'"],
          c: ['needs: a', 'if: always() && github.ref_name'],
        }),
      },
      push,
    );
    expect(m.scopes[ci]!.edges.map((e) => [e.target, e.deciding, e.label])).toEqual([
      [`${ci}#b`, true, 'result: skipped'],
      [`${ci}#c`, false, undefined],
    ]);
  });

  it('labels a deciding need `result: ?` while the answer waits on a result only the run knows', () => {
    const files = {
      [ci]: [
        'on: push',
        'jobs:',
        '  a:',
        "    if: github.actor == 'me'",
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: a',
        '  b:',
        '    needs: a',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: b',
        '  c:',
        '    needs: a',
        "    if: success() || github.event_name == 'push'",
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: c',
        '',
      ].join('\n'),
    };
    const m = modelOf(files, push);
    expect(m.jobs[`${ci}#b`]).toMatchObject({ verdict: 'maybe' });
    // c runs whatever a does: a true answer needed nothing from the needs.
    expect(m.jobs[`${ci}#c`]).toMatchObject({ verdict: 'yes' });
    expect(m.scopes[ci]!.edges.map((e) => [e.target, e.deciding, e.label])).toEqual([
      [`${ci}#b`, true, 'result: ?'],
      [`${ci}#c`, false, undefined],
    ]);
  });
});

describe('the graph model in edit mode', () => {
  it('draws the focused workflow alone, untriggered too, and every workflow for a focus the plan does not hold', () => {
    expect(modelOf(starter, push, { only: ci }).roots).toEqual([ci]);
    // Release does not run on a push to main: hidden as untriggered, but not while it is the one being edited.
    expect(modelOf(starter, push, { hideUntriggered: true }).roots).not.toContain(release);
    expect(modelOf(starter, push, { hideUntriggered: true, only: release }).roots).toEqual([release]);
    expect(modelOf(starter, push, { only: '.github/workflows/nope.yml' }).roots).toEqual(
      modelOf(starter, push).roots,
    );
  });
});

describe('the shape of a scope', () => {
  it('stays when only the scenario changes: same jobs, other verdicts', () => {
    const before = modelOf(starter, push);
    const after = modelOf(starter, pushSrc);
    expect(after.scopes[ci]!.counts).not.toEqual(before.scopes[ci]!.counts);
    expect(shapes(after)).toEqual(shapes(before));
    // Another leg with as many steps shows a strip of the same size.
    expect(
      shapes(modelOf(starter, push, { representative: { [`${ci}#test`]: `${ci}#test[node=24]` } })),
    ).toEqual(shapes(before));
  });

  it('changes with a new job, an open step list or a new edge, and only in that scope', () => {
    const before = shapes(modelOf(starter, push));
    const job = {
      ...starter,
      [ci]: `${starter[ci]}\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: lint\n`,
    };
    const edge = { ...starter, [ci]: starter[ci]!.replace('needs: build\n', 'needs: [build, test]\n') };
    for (const changed of [
      shapes(modelOf(job, push)),
      shapes(modelOf(starter, push, { expanded: [`${ci}#build`] })),
      shapes(modelOf(edge, push)),
    ]) {
      expect(changed[ci]).not.toBe(before[ci]);
      expect(changed[release]).toBe(before[release]);
    }
  });

  it('stays when a job turns skipped or back, its legs and steps gone from the plan', () => {
    const files = {
      [ci]: [
        'on: [push, pull_request]',
        'jobs:',
        '  test:',
        "    if: github.event_name == 'push'",
        '    runs-on: ubuntu-latest',
        '    strategy:',
        '      matrix:',
        '        node: [20, 22, 24]',
        '    steps:',
        '      - run: npm ci',
        '      - run: npm test',
        '  lint:',
        '    needs: test',
        "    if: github.event_name == 'push'",
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm run lint',
        '',
      ].join('\n'),
    };
    const runs = modelOf(files, push);
    const skipped = modelOf(files, { event: 'pull_request', base: 'main' });
    expect([runs, skipped].map((m) => m.jobs[`${ci}#test`]!.verdict)).toEqual(['yes', 'no']);
    expect([runs, skipped].map((m) => m.jobs[`${ci}#lint`]!.verdict)).toEqual(['yes', 'no']);
    expect(shapes(skipped)).toEqual(shapes(runs));
    // The starter's pull request skips deploy and might run preview, where a push did the other way round.
    const push2 = modelOf(starter, pushSrc);
    const pr = modelOf(starter, { event: 'pull_request', base: 'main', changed: ['src/a.ts'] });
    expect([push2, pr].map((m) => m.jobs[`${ci}#deploy`]!.verdict)).toEqual(['yes', 'no']);
    expect(shapes(pr)[ci]).toBe(shapes(push2)[ci]);
  });

  it('changes in a caller when its callee changes', () => {
    const callee = `${ci}#web>.github/workflows/package.yml`;
    const before = shapes(modelOf(monorepo, push));
    const after = shapes(modelOf(monorepo, push, { expanded: [`${callee}#test`] }));
    expect(after[callee]).not.toBe(before[callee]);
    expect(after[ci]).not.toBe(before[ci]);
    expect(after[`${ci}#api>.github/workflows/package.yml`]).toBe(
      before[`${ci}#api>.github/workflows/package.yml`],
    );
  });

  it('never reads verdicts, results, clauses or values', () => {
    const job: JobModel = {
      id: 'ci.yml#a',
      scope: 'ci.yml',
      jobId: 'a',
      label: 'a',
      verdict: 'yes',
      check: 'a',
      needs: [],
      legs: [{ id: 'ci.yml#a[n=1]', legKey: 'n=1', label: 'n=1', verdict: 'yes' }],
      steps: [{ id: 'ci.yml#a[n=1]/~x', label: 'x', verdict: 'yes', inner: [], outputs: 'v=1' }],
      expanded: false,
    };
    const scope = { id: 'ci.yml', collapsed: false, edges: [] };
    const recoloured: JobModel = {
      ...job,
      verdict: 'no',
      clause: 'if: false → false',
      result: 'skipped',
      legs: [{ ...job.legs![0]!, label: 'n=2', verdict: 'maybe', result: 'failure' }],
      steps: [{ ...job.steps[0]!, verdict: 'no', outputs: 'v=?' }],
    };
    expect(shapeHash(scope, [recoloured], {})).toBe(shapeHash(scope, [job], {}));
    // A label decides only its card's width, which the layout cache keys by on its own (graph/layout.ts).
    expect(shapeHash(scope, [{ ...job, label: 'a longer name' }], {})).toBe(shapeHash(scope, [job], {}));
    // Inner steps are rows of the open list only.
    const inner = { ...job.steps[0]!, inner: [{ ...job.steps[0]!, id: 'ci.yml#a[n=1]/~x>y/~z' }] };
    expect(shapeHash(scope, [{ ...job, steps: [inner] }], {})).toBe(shapeHash(scope, [job], {}));
    const open = { ...job, expanded: true };
    expect(shapeHash(scope, [{ ...open, steps: [inner] }], {})).not.toBe(shapeHash(scope, [open], {}));
    const calls = { ...job, callee: 'ci.yml#a>lib.yml' };
    expect(shapeHash(scope, [calls], { 'ci.yml#a>lib.yml': 'one' })).not.toBe(
      shapeHash(scope, [calls], { 'ci.yml#a>lib.yml': 'two' }),
    );
    expect(shapeHash({ ...scope, collapsed: true }, [], {})).not.toBe(shapeHash(scope, [], {}));
  });
});
