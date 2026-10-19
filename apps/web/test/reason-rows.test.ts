import type { NodeId, Reason, ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import { indexPlan, type PlanIndex, resolveSelection } from '../src/plan/index';
import { decisionOf, planNodes } from '../src/plan/nodes';
import {
  type FilterBody,
  type IfBody,
  type ReasonsModel,
  reasonsModel,
  requestField,
  type RowBody,
  selectNode,
} from '../src/panels/reason-rows';
import { DEFAULT_PREFS } from '../src/state/prefs';
import { createSessionStore, initialSessionState, type PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const starter = sampleByName('starter')!.files;
const monorepo = sampleByName('monorepo')!.files;
const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const pr: ScenarioInput = { event: 'pull_request', base: 'main', head: 'topic', number: 1 };

/** The worker's answer for one repository and scenario, as the store holds it. */
function simulated(files: Record<string, string>, scenario: ScenarioInput): PlanState {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  const { plan, derived, text, ms } = step.response;
  return { plan, derived, text, ms, for: { files: 1, project: 1 } };
}

const indexOf = (state: PlanState): PlanIndex => indexPlan(state.plan, state.derived);

/** The model of a node; the focused workflow when `sel` is absent, as the panel resolves it. */
function modelOf(state: PlanState, focus: string, sel?: string): ReasonsModel {
  const index = indexOf(state);
  const model = reasonsModel(state, index, resolveSelection(index, focus, sel));
  if (!model) throw new Error(`no model for ${focus} ${sel ?? ''}`);
  return model;
}

/** A copy of the plan whose node decides by the chain given, to show the kinds no sample produces. */
function withChain(state: PlanState, id: NodeId, chain: Reason[], deciding = -1): PlanState {
  const plan = structuredClone(state.plan);
  const derived = structuredClone(state.derived);
  decisionOf(planNodes(plan).get(id)!).chain = chain;
  derived.decidingIndex[id] = deciding;
  return { ...state, plan, derived };
}

const bodies = (model: ReasonsModel): RowBody[] => model.rows.map((r) => r.body);
const filterOf = (model: ReasonsModel, i: number): FilterBody => model.rows[i]!.body as FilterBody;
const ifOf = (model: ReasonsModel): IfBody => model.rows.find((r) => r.body.kind === 'if')!.body as IfBody;

describe('the reasons of a push to main in the starter', () => {
  const push = simulated(starter, { event: 'push', branch: 'main' });

  it("shows the focused workflow when nothing inside it is selected, with CI's paths-ignore filter undecided", () => {
    const model = modelOf(push, CI);
    expect(model.header).toEqual({
      id: CI,
      kind: 'workflow',
      label: 'CI',
      verdict: 'maybe',
      path: CI,
      clause: push.derived.clauses[CI],
      loc: { file: CI, line: 1, column: 1 },
    });
    expect(bodies(model)).toEqual([
      { kind: 'event', text: 'Listens to push', on: ['push', 'pull_request', 'workflow_dispatch'] },
      {
        kind: 'filter',
        filter: 'branches',
        text: 'matched',
        patterns: ['main'],
        subject: { label: 'ref', text: 'main' },
      },
      {
        kind: 'filter',
        filter: 'paths-ignore',
        text: 'undecided',
        patterns: ['docs/**'],
        subject: { label: 'changed files', text: 'no changed files given' },
        set: { label: 'Set changed files', path: 'changed' },
      },
    ]);
    expect(model.rows.map((r) => [r.gate.known, r.deciding])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    // The deciding row carries the line of the filter's key under `on.push`.
    expect(model.rows[2]!.loc).toEqual({ file: CI, line: 5, column: 1 });
    expect(model.rows[0]!.loc).toBeUndefined();
  });

  it("words deploy's if: as written and as evaluated, with the status, the value and every read", () => {
    const model = modelOf(push, CI, 'deploy');
    expect(model.header).toMatchObject({ label: 'deploy', path: 'deploy', verdict: 'maybe' });
    // A result of skipped or success adds nothing to "might run".
    expect(model.header.result).toBeUndefined();
    expect(model.rows[0]!.body).toEqual({
      kind: 'parent',
      text: 'Its workflow might not be triggered',
      parent: CI,
      label: 'CI',
    });
    expect(model.rows[0]!.deciding).toBe(true);
    expect(ifOf(model)).toEqual({
      kind: 'if',
      expr: "github.event_name == 'push' || inputs.deploy",
      evaluated: "success() && (github.event_name == 'push' || inputs.deploy)",
      implicitSuccess: true,
      status: 'one of skipped, success',
      value: 'unknown',
      reads: [
        { ref: 'github.event_name', value: 'push', unknowns: [] },
        { ref: 'inputs.deploy', value: "''", unknowns: [] },
      ],
    });
  });

  it('leaves out an evaluated form equal to the one written, and says a known value', () => {
    const gate = modelOf(simulated(monorepo, { event: 'push', branch: 'main' }), CI, 'gate');
    expect(ifOf(gate)).toMatchObject({ expr: 'always()', implicitSuccess: false, value: 'true' });
    expect(ifOf(gate).evaluated).toBeUndefined();
  });

  it('offers no Unknowns row for a value the engine decided the condition without', () => {
    // On a push, `github.event_name == 'pull_request'` decides preview's if: before the labels are read.
    const labels = 'github.event.pull_request.labels.*.name';
    const body = ifOf(modelOf(push, CI, 'preview'));
    expect(Object.hasOwn(push.derived.unknownPaths, labels)).toBe(false);
    expect(body.reads.find((r) => r.ref === labels)).toEqual({ ref: labels, value: '?', unknowns: [] });
  });

  it('gives the residual of an if: that stays unknown', () => {
    const body = ifOf(modelOf(push, CI, 'build.#3'));
    expect(body.value).toBe('unknown');
    expect(body.reads).toEqual([
      {
        ref: 'steps.detect.outputs.changed',
        value: '?',
        unknowns: [{ id: `${CI}#build/steps.detect.outputs.changed`, label: 'build.detect.outputs.changed' }],
      },
    ]);
  });
});

describe('the reasons of a labeled pull request', () => {
  const labeled = simulated(starter, { ...pr, action: 'labeled' });

  it('lists the allowed types and says the action is one of them', () => {
    expect(modelOf(labeled, CI).rows[1]!.body).toEqual({
      kind: 'types',
      text: 'labeled is one of its types',
      allowed: ['opened', 'synchronize', 'reopened', 'labeled'],
      action: 'labeled',
    });
  });

  it('decides preview on its contains(), whose label list only the run knows', () => {
    const model = modelOf(labeled, CI, 'preview');
    const body = ifOf(model);
    expect(body.expr).toContain("contains(github.event.pull_request.labels.*.name, 'preview')");
    expect(body.status).toBe('success');
    expect(body.reads).toEqual([
      { ref: 'github.event_name', value: 'pull_request', unknowns: [] },
      {
        ref: 'github.event.pull_request.labels.*.name',
        value: '?',
        unknowns: [
          {
            id: 'github.event.pull_request.labels.*.name',
            label: 'github.event.pull_request.labels.*.name',
          },
        ],
      },
    ]);
    expect(model.rows[1]).toMatchObject({ deciding: true, loc: { file: CI, line: 53 } });
  });

  it('gives a step the parent row of its job, which might not run', () => {
    const model = modelOf(labeled, CI, 'preview.#1');
    expect(model.rows[0]!.body).toEqual({
      kind: 'parent',
      text: 'Its job might not run',
      parent: `${CI}#preview`,
      label: 'preview',
    });
  });

  it('asks for the activity type when none is given and types: is narrowed', () => {
    const model = modelOf(simulated(starter, pr), CI);
    expect(model.rows[1]!.body).toEqual({
      kind: 'types',
      text: 'No activity type given and types: is narrowed',
      allowed: ['opened', 'synchronize', 'reopened', 'labeled'],
      set: { label: 'Set the activity type', path: 'action' },
    });
    expect(model.rows[1]!.deciding).toBe(true);
  });
});

describe('the reasons of a release', () => {
  it('fails the tags filter on a branch push and says why the job is skipped on a tag push', () => {
    const branch = modelOf(simulated(starter, { event: 'push', branch: 'main' }), RELEASE);
    expect(branch.header.verdict).toBe('no');
    expect(filterOf(branch, 1)).toEqual({
      kind: 'filter',
      filter: 'tags',
      text: 'without a branch filter: a branch push does not run it',
      patterns: ['v*'],
      subject: { label: 'ref', text: 'main' },
    });
    expect(branch.rows[1]).toMatchObject({ gate: { known: true, value: false }, deciding: true });
    expect(branch.rows[1]!.loc).toMatchObject({ file: RELEASE, line: 4 });
  });

  it('decides a composite action with its step', () => {
    const tag = simulated(starter, { event: 'push', tag: 'v1.0.0' });
    const id = `${RELEASE}#publish/~github-actions-setup>.github/actions/setup`;
    const model = reasonsModel(tag, indexOf(tag), id)!;
    expect(model.header).toMatchObject({
      id,
      kind: 'composite',
      label: '.github/actions/setup',
      path: 'publish.#2',
    });
    expect(model.header.clause).toBe(tag.derived.clauses[`${RELEASE}#publish/~github-actions-setup`]);
    expect(model.rows.filter((r) => r.deciding)).toHaveLength(1);
  });

  it('says a cron that is not one of the schedules', () => {
    const model = modelOf(simulated(starter, { event: 'schedule', cron: '0 7 * * 1' }), RELEASE);
    expect(model.rows[1]!.body).toEqual({
      kind: 'text',
      text: '0 7 * * 1 is not one of its schedules (0 6 * * 1)',
    });
  });

  it('says a skip marker in the commit message', () => {
    const model = modelOf(
      simulated(starter, { event: 'push', branch: 'main', message: 'x [skip ci]' }),
      RELEASE,
    );
    expect(model.rows.at(-1)!.body).toEqual({
      kind: 'text',
      text: 'The commit message carries [skip ci], which skips the run',
    });
  });
});

describe('a workflow_run without the triggering run', () => {
  const files = {
    '.github/workflows/wr.yml':
      'on:\n  workflow_run:\n    workflows: [Build]\n    branches: [main]\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: echo }]\n',
  };

  it('asks for the triggering workflow and the branch it ran on', () => {
    const model = modelOf(simulated(files, { event: 'workflow_run' }), '.github/workflows/wr.yml');
    const filters = model.rows.filter((r) => r.body.kind === 'filter').map((r) => r.body as FilterBody);
    expect(filters.map((f) => [f.filter, f.subject.text, f.set])).toEqual([
      [
        'workflows',
        'no triggering workflow given',
        { label: 'Set the triggering workflow', path: 'workflow_run' },
      ],
      [
        'branches',
        'no branch given for the triggering run',
        { label: "Set the triggering run's branch", path: 'workflow_run.branch' },
      ],
    ]);
  });
});

describe('a called workflow', () => {
  it('names the calling job as its parent', () => {
    const push = simulated(monorepo, { event: 'push', branch: 'main' });
    const id = `${CI}#web>.github/workflows/package.yml`;
    const model = reasonsModel(push, indexOf(push), id)!;
    expect(model.rows[0]!.body).toEqual({
      kind: 'parent',
      text: 'The calling job might not run',
      parent: `${CI}#web`,
      label: 'web',
    });
  });
});

describe('the kinds no sample shows', () => {
  const push = simulated(starter, { event: 'push', branch: 'main' });
  const job = `${CI}#deploy`;
  const chain: Reason[] = [
    { kind: 'parent', node: CI, verdict: 'no' },
    { kind: 'parent', node: `${CI}#build`, verdict: 'no' },
    { kind: 'parent', node: `${CI}#build`, verdict: 'yes' },
    { kind: 'event', event: 'schedule', listens: false },
    { kind: 'schedule', crons: ['0 6 * * 1'], matched: true },
    { kind: 'schedule', crons: ['0 6 * * 1'], cron: '0 6 * * 1', matched: true },
    { kind: 'default-branch', matched: true },
    { kind: 'default-branch', matched: false },
    { kind: 'limit', limit: 'nesting' },
    { kind: 'matrix', unknown: `${job}.strategy.matrix` },
    { kind: 'types', allowed: ['opened'], matched: { known: true, value: true } },
    { kind: 'types', action: 'closed', allowed: ['opened'], matched: { known: true, value: false } },
    { kind: 'mystery' } as unknown as Reason,
  ];
  const model = reasonsModel(withChain(push, job, chain, 3), indexOf(push), job)!;

  it('words each in one sentence, a kind this version does not know by its name', () => {
    expect(bodies(model).map((b) => ('text' in b ? b.text : b.kind))).toEqual([
      'Its workflow is not triggered',
      'Its job is skipped',
      'Its job runs',
      'Does not listen to schedule',
      'No cron given: any of its schedules triggers it (0 6 * * 1)',
      '0 6 * * 1 is one of its schedules',
      'The ref is the default branch',
      'The ref is not the default branch',
      "GitHub's nesting limit stops it here",
      'The matrix is only known at run time',
      'No activity type given: any of the default types triggers it',
      'closed is not one of its types',
      'mystery',
    ]);
    expect(model.rows.at(-1)!.gate).toEqual({ known: false, unknowns: [] });
  });

  it('marks the row at the deciding index, and only that one', () => {
    expect(model.rows.map((r) => r.deciding).indexOf(true)).toBe(3);
    expect(model.rows.filter((r) => r.deciding)).toHaveLength(1);
  });

  it('words the ignore filters the other way, and lists a long change set as files', () => {
    const files = ['a.md', 'b.md', 'c.md', 'd.ts'];
    const filters: Reason[] = [
      {
        kind: 'filter',
        filter: 'paths-ignore',
        patterns: ['*.md'],
        subject: { known: true, value: files },
        matched: { known: true, value: true },
      },
      {
        kind: 'filter',
        filter: 'branches-ignore',
        patterns: ['wip/*'],
        subject: { known: true, value: 'wip/a' },
        matched: { known: true, value: false },
      },
      {
        kind: 'filter',
        filter: 'paths',
        patterns: ['src/**'],
        subject: { known: true, value: [] },
        matched: { known: true, value: false },
      },
      {
        kind: 'filter',
        filter: 'tags',
        patterns: ['v*'],
        subject: { known: false, unknowns: ['scenario.ref'] },
        matched: { known: false, unknowns: ['scenario.ref'] },
      },
    ];
    const m = reasonsModel(withChain(push, CI, filters), indexOf(push), CI)!;
    expect([0, 1, 2, 3].map((i) => [filterOf(m, i).text, filterOf(m, i).subject])).toEqual([
      ['not ignored', { label: 'changed files', files }],
      ['ignored', { label: 'ref', text: 'wip/a' }],
      ['not matched', { label: 'changed files', files: [] }],
      ['undecided', { label: 'ref', text: '? (scenario.ref)' }],
    ]);
    // A ref filter the scenario leaves open names no field of its own.
    expect(filterOf(m, 3).set).toBeUndefined();
  });

  it('gives the result a verdict does not say, and a status with no candidates as unknown', () => {
    const state = withChain(push, job, [
      {
        kind: 'if',
        expr: 'failure()',
        evaluated: 'failure()',
        implicitSuccess: false,
        status: { known: false, unknowns: ['x'] },
        value: { known: false, unknowns: ['x'] },
        residual: 'x',
        reads: [
          { ref: 'needs.a.outputs.n', value: { known: true, value: 3 }, from: `${CI}#build` },
          { ref: 'needs.a.outputs.m', value: { known: false, unknowns: ['y'], oneOf: ['a', 'b'] } },
        ],
      },
    ]);
    const jobPlan = state.plan.workflows[0]!.jobs.find((j) => j.id === job)!;
    jobPlan.result = { known: false, unknowns: ['x'], oneOf: ['skipped', 'success', 'failure'] };
    const m = reasonsModel(state, indexOf(state), job)!;
    expect(m.header.result).toBe('one of success, failure');
    expect(ifOf(m)).toMatchObject({ status: 'unknown', residual: 'x' });
    // `y` is no unknown of the plan: the value says `?` with no Unknowns row to show.
    expect(ifOf(m).reads).toEqual([
      { ref: 'needs.a.outputs.n', value: '3', unknowns: [], from: 'build' },
      { ref: 'needs.a.outputs.m', value: '? one of "a", "b"', unknowns: [] },
    ]);
    jobPlan.result = { known: true, value: 'failure' };
    expect(reasonsModel(state, indexOf(state), job)!.header.result).toBe('failure');
  });

  it('lists the diagnostics about the node, and only those', () => {
    const state = withChain(push, job, []);
    state.plan.diagnostics.push(
      { severity: 'warning', code: 'X1', message: 'about deploy', node: job },
      { severity: 'error', code: 'X2', message: 'about build', node: `${CI}#build` },
    );
    expect(reasonsModel(state, indexOf(state), job)!.diagnostics).toEqual([
      { severity: 'warning', code: 'X1', message: 'about deploy', node: job },
    ]);
  });

  it('has nothing to say without a node, or about one the plan does not have', () => {
    expect(reasonsModel(push, indexOf(push), undefined)).toBeUndefined();
    expect(reasonsModel(push, indexOf(push), `${CI}#gone`)).toBeUndefined();
  });
});

describe('conditions as GitHub evaluates them', () => {
  const W = '.github/workflows/z.yml';
  const files = {
    [W]: [
      'on: push',
      'jobs:',
      '  a:',
      '    runs-on: x',
      '    outputs: { x: "${{ steps.s.outputs.x }}" }',
      '    steps: [{ id: s, run: echo }]',
      '  b:',
      '    needs: a',
      "    if: needs.a.outputs.x == 'a' || needs.a.outputs.x == 'b'",
      '    runs-on: x',
      '    steps:',
      '      - run: echo',
      '        if: 0',
      '      - run: echo',
      "        if: ${{ github.ref == 'refs/heads/main' }}",
      '  c:',
      '    if: ${{ always() }}',
      '    runs-on: x',
      '    steps: [{ run: echo }]',
      '',
    ].join('\n'),
  };
  const push = simulated(files, { event: 'push', branch: 'main' });
  const ifAt = (id: string): IfBody => ifOf(reasonsModel(push, indexOf(push), `${W}#${id}`)!);

  it('adds no success() to an if: in ${{ }} that calls a status function', () => {
    expect(ifAt('c')).toMatchObject({ expr: '${{ always() }}', implicitSuccess: false });
    expect(ifAt('c').evaluated).toBeUndefined();
  });

  it('adds it to an if: in ${{ }} that calls none', () => {
    expect(ifAt('b/~echo~2')).toMatchObject({
      expr: "${{ github.ref == 'refs/heads/main' }}",
      evaluated: "success() && (github.ref == 'refs/heads/main')",
      implicitSuccess: true,
    });
  });

  it('gives a number the engine keeps no text of as the condition evaluated', () => {
    const body = ifAt('b/~echo');
    expect(body.expr).toBe('success() && (0)');
    expect(body.evaluated).toBeUndefined();
    expect(body.value).toBe('false');
  });

  it('lists a value the condition reads twice once', () => {
    expect(ifAt('b').reads.map((r) => r.ref)).toEqual(['needs.a.outputs.x']);
  });
});

describe('ref filters against the scenario', () => {
  const W = '.github/workflows/z.yml';
  const workflow = (on: string): Record<string, string> => ({
    [W]: `on:\n${on}\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: echo }]\n`,
  });
  const filterIn = (on: string, scenario: ScenarioInput): FilterBody => {
    const model = modelOf(simulated(workflow(on), scenario), W);
    return model.rows.map((r) => r.body).findLast((b): b is FilterBody => b.kind === 'filter')!;
  };
  const main: ScenarioInput = { event: 'push', branch: 'main' };
  const tag: ScenarioInput = { event: 'push', tag: 'v1' };

  it('says a push filtered only by the other kind of ref does not run, whatever the patterns', () => {
    expect(filterIn("  push:\n    tags-ignore: ['v*']", main)).toMatchObject({
      text: 'without a branch filter: a branch push does not run it',
      subject: { label: 'ref', text: 'main' },
    });
    expect(filterIn("  push:\n    branches-ignore: ['wip/*']", tag)).toMatchObject({
      text: 'without a tag filter: a tag push does not run it',
      subject: { label: 'ref', text: 'v1' },
    });
    expect(filterIn('  push:\n    branches: [main]', tag).text).toBe(
      'without a tag filter: a tag push does not run it',
    );
  });

  it('keeps the words of a filter of the ref kind pushed', () => {
    expect(filterIn("  push:\n    branches-ignore: ['wip/*']", { event: 'push', branch: 'wip/a' }).text).toBe(
      'ignored',
    );
    expect(filterIn("  push:\n    tags-ignore: ['v*']", tag).text).toBe('ignored');
    expect(filterIn("  push:\n    tags: ['v*']", tag).text).toBe('matched');
  });

  it("names the branch a pull request or a workflow_run filter matches: the base, the triggering run's", () => {
    expect(
      filterIn('  pull_request:\n    branches: [main]', { ...pr, base: 'dev', head: 'x' }),
    ).toMatchObject({
      text: 'not matched',
      subject: { label: 'base branch', text: 'dev' },
    });
    const run: ScenarioInput = {
      event: 'workflow_run',
      workflow_run: { name: 'B', branch: 'main', conclusion: 'success' },
    };
    expect(filterIn('  workflow_run:\n    workflows: [B]\n    branches-ignore: [main]', run)).toMatchObject({
      text: 'ignored',
      subject: { label: "triggering run's branch", text: 'main' },
    });
  });
});

describe("the reasons' actions on the store", () => {
  it('asks the form for a field, opening the scenario column first when it is closed', () => {
    const initial = initialSessionState({
      ...DEFAULT_PREFS,
      collapsed: { ...DEFAULT_PREFS.collapsed, left: true },
    });
    const store = createSessionStore(initial);
    requestField(store, 'changed');
    expect(store.getState().ui.prefs.collapsed.left).toBe(false);
    expect(store.getState().fieldFocus).toMatchObject({ path: 'changed' });
    requestField(store, 'action');
    expect(store.getState().ui.prefs.collapsed.left).toBe(false);
    expect(store.getState().fieldFocus).toMatchObject({ path: 'action' });
  });

  it('selects a node through the focus and unit path that name it', () => {
    const push = simulated(starter, { event: 'push', branch: 'main' });
    const store = createSessionStore();
    selectNode(store, indexOf(push), `${CI}#deploy`);
    expect([store.getState().focus, store.getState().sel]).toEqual([CI, 'deploy']);
    selectNode(store, indexOf(push), CI);
    expect([store.getState().focus, store.getState().sel]).toEqual([CI, undefined]);
  });
});
