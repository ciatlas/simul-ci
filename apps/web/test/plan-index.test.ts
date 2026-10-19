import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { NodeId, ScenarioInput } from '@simulci/engine';
import { checksOf } from '@simulci/engine/plan';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import { indexPlan, type PlanIndex, planIndex, resolveSelection, selectionOf } from '../src/plan/index';
import { handle, initialState } from '../src/worker/handle';
import type { PlanResponse } from '../src/worker/protocol';

const labRepo = join(import.meta.dirname, '../../../fixtures/routes-lab/repo');
const lab: Record<string, string> = {};
for (const entry of readdirSync(labRepo, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  lab[relative(labRepo, path)] = readFileSync(path, 'utf8');
}
const starter = sampleByName('starter')!.files;
const monorepo = sampleByName('monorepo')!.files;

/** The worker's answers for one repository under each scenario: the plan and its tables. */
function simulated(files: Record<string, string>, ...scenarios: ScenarioInput[]): PlanResponse[] {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  return scenarios.map((scenario, i) => {
    const step = handle(loaded.state, {
      id: i + 2,
      type: 'simulate',
      project: 1,
      scenario,
      assume: [],
      detail: 'steps',
    });
    if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
    return step.response;
  });
}

const pr: ScenarioInput = { event: 'pull_request', base: 'main', head: 'topic', number: 1 };
const everyPlan = [
  ...simulated(
    starter,
    { event: 'push', branch: 'main' },
    { event: 'push', branch: 'main', changed: ['src/a.ts'] },
    { ...pr, action: 'labeled' },
    { event: 'push', tag: 'v1.0.0' },
    { event: 'schedule', cron: '0 6 * * 1' },
  ),
  ...simulated(monorepo, { event: 'push', branch: 'main' }, { ...pr, changed: ['apps/web/a.ts'] }),
  ...simulated(
    lab,
    { event: 'push', branch: 'main' },
    { event: 'push', branch: 'main', changed: ['src/a.ts'] },
    { event: 'push', tag: 'v1' },
    { ...pr, action: 'labeled' },
    { event: 'workflow_dispatch', branch: 'main' },
  ),
];

const ci = '.github/workflows/ci.yml';
const indexOf = (r: PlanResponse): PlanIndex => indexPlan(r.plan, r.derived);
const starterPush = everyPlan[0]!;
const starterTag = everyPlan[3]!;
const monorepoPush = everyPlan[5]!;
const labPush = everyPlan[7]!;

describe('the plan index', () => {
  it('holds every node of the plan once, with the kind the worker gave it', () => {
    for (const r of everyPlan) {
      const index = indexOf(r);
      expect(new Set(index.nodes.keys())).toEqual(new Set(Object.keys(r.derived.kinds)));
      for (const node of index.nodes.values()) expect(node.kind, node.id).toBe(r.derived.kinds[node.id]);
    }
  });

  it('lists the nodes in pre-order: each one under an ancestor still open, depth-0 workflows at the top', () => {
    for (const r of everyPlan) {
      const open: NodeId[] = [];
      for (const node of indexOf(r).nodes.values()) {
        if (node.parent === undefined) open.length = 0;
        else {
          while (open.length && open.at(-1) !== node.parent) open.pop();
          expect(open.at(-1), node.id).toBe(node.parent);
        }
        open.push(node.id);
      }
    }
  });

  it('walks a job, its steps, a composite action and its inner steps in order', () => {
    const wf = '.github/workflows/case-composite-action-status.yml';
    const index = indexOf(labPush);
    const ids = [...index.nodes.keys()].filter((id) => id.startsWith(wf));
    const u = `${wf}#a/steps.u`;
    const action = `${u}>.github/actions/comp`;
    expect(ids).toEqual([
      wf,
      `${wf}#a`,
      `${wf}#a/~checkout`,
      u,
      action,
      `${action}/~inner-fail`,
      `${action}/~inner-on-failure`,
      `${action}/~inner-on-success`,
      `${action}/~inner-always`,
      `${wf}#a/~probe`,
      `${wf}#a/~on-failure`,
      `${wf}#a/~on-success`,
    ]);
    expect(index.nodes.get(action)).toMatchObject({ kind: 'composite', parent: u, unitPath: 'a.u' });
    expect(index.nodes.get(`${action}/~inner-fail`)).toMatchObject({ parent: action, unitPath: 'a.u/#1' });
    expect(index.nodes.get(`${wf}#a/~checkout`)).toMatchObject({ parent: `${wf}#a`, workflow: wf });
  });

  it('puts each leg under its job and a called workflow under the leg that calls it', () => {
    const index = indexOf(monorepoPush);
    const test = `${ci}#test`;
    const callee = `${ci}#web>.github/workflows/package.yml`;
    expect(index.nodes.get(callee)).toEqual({
      id: callee,
      kind: 'workflow',
      parent: `${ci}#web`,
      verdict: 'maybe',
      workflow: ci,
    });
    expect(index.nodes.get(`${callee}#test`)).toMatchObject({
      parent: callee,
      workflow: ci,
      unitPath: 'web/test',
    });
    expect(index.nodes.get(ci)).toEqual({ id: ci, kind: 'workflow', verdict: 'yes', workflow: ci });
    const legs = indexOf(starterPush);
    expect(legs.nodes.get(`${test}[node=22]`)).toMatchObject({
      kind: 'leg',
      parent: test,
      unitPath: 'test[node=22]',
    });
    expect(legs.nodes.get(`${test}[node=22]/~npm-ci`)).toMatchObject({ parent: `${test}[node=22]` });
    // A job without a matrix stands for its one leg: its steps hang off the job.
    expect(legs.nodes.get(`${ci}#build/steps.detect`)).toMatchObject({
      parent: `${ci}#build`,
      unitPath: 'build.detect',
    });
  });

  it('knows which unknowns make each node maybe, in the plan’s rank', () => {
    for (const r of everyPlan) {
      const index = indexOf(r);
      for (const u of r.plan.unknowns)
        for (const id of u.affects) expect(index.affectedBy.get(id)).toContain(u.id);
      for (const [id, ids] of index.affectedBy) {
        const ranked = r.plan.unknowns.filter((u) => u.affects.includes(id)).map((u) => u.id);
        expect(ids).toEqual(ranked);
      }
    }
    const index = indexOf(starterPush);
    expect(index.affectedBy.get(ci)).toEqual(['scenario.changed']);
    // deploy is maybe only through its workflow: what the run reads in it is decided.
    expect(index.affectedBy.get(`${ci}#deploy`)).toBeUndefined();
    expect(index.affectedBy.get(`${ci}#build/~npm-run-build`)).toEqual([
      `${ci}#build/steps.detect.outputs.changed`,
    ]);
    expect(index.affectedBy.get(`${ci}#preview`)).toBeUndefined();
  });

  it('carries the predicted checks', () => {
    for (const r of everyPlan) expect(indexOf(r).checks).toEqual(checksOf(r.plan));
  });

  it('names every node by a unit path within its depth-0 workflow', () => {
    const index = indexOf(starterTag);
    const release = '.github/workflows/release.yml';
    const paths = index.byPath.get(release)!;
    expect([...paths.keys()]).toEqual([
      'publish',
      'publish.#1',
      'publish.#2',
      'publish.#2/#1',
      'publish.#2/cache',
      'publish.#2/#3',
      'publish.#3',
      'audit',
    ]);
    // The composite instance shares its step's path; the path names the step.
    expect(paths.get('publish.#2')).toBe(`${release}#publish/~github-actions-setup`);
    expect(index.byPath.get(ci)).toEqual(new Map());
  });

  it('is built once per plan, whichever panel asks for it first', () => {
    const first = planIndex(starterPush);
    expect(planIndex({ plan: starterPush.plan, derived: starterPush.derived })).toBe(first);
    expect(planIndex(starterTag)).not.toBe(first);
    expect(first.nodes).toEqual(indexOf(starterPush).nodes);
  });
});

describe('a selection', () => {
  it('round-trips every node through its focus and unit path', () => {
    for (const r of everyPlan) {
      const index = indexOf(r);
      for (const node of index.nodes.values()) {
        const { focus, sel } = selectionOf(index, node.id);
        expect(focus).toBe(node.workflow);
        // A composite is named by its step's path, a called workflow by its caller's: both select that node instead.
        const byParent = node.kind === 'composite' || (node.kind === 'workflow' && node.parent !== undefined);
        expect(resolveSelection(index, focus, sel), node.id).toBe(byParent ? node.parent : node.id);
      }
    }
  });

  it('names the focused workflow when there is no unit path', () => {
    const index = indexOf(starterPush);
    expect(selectionOf(index, ci)).toEqual({ focus: ci });
    expect(resolveSelection(index, ci, undefined)).toBe(ci);
    expect(resolveSelection(index, ci, '')).toBe(ci);
    expect(resolveSelection(index, undefined, 'build')).toBeUndefined();
    expect(resolveSelection(index, '.github/workflows/gone.yml', 'build')).toBeUndefined();
  });

  it('falls back to the nearest ancestor the plan still has, then the workflow', () => {
    const index = indexOf(starterPush);
    const test = `${ci}#test`;
    expect(resolveSelection(index, ci, 'test[node=22].#9')).toBe(`${test}[node=22]`);
    expect(resolveSelection(index, ci, 'test[node=20].#2')).toBe(test);
    expect(resolveSelection(index, ci, 'test[node=20]')).toBe(test);
    expect(resolveSelection(index, ci, 'build.gone')).toBe(`${ci}#build`);
    expect(resolveSelection(index, ci, 'gone.#1')).toBe(ci);
    // `test` begins `testing` but is not its ancestor: a part ends at `.`, `/` or `[`.
    expect(resolveSelection(index, ci, 'testing')).toBe(ci);
    const calls = indexOf(monorepoPush);
    expect(resolveSelection(calls, ci, 'web/test.#7')).toBe(`${ci}#web>.github/workflows/package.yml#test`);
    expect(resolveSelection(calls, ci, 'web/gone')).toBe(`${ci}#web`);
    const composite = indexOf(labPush);
    const wf = '.github/workflows/case-composite-action-status.yml';
    expect(resolveSelection(composite, wf, 'a.u/#9')).toBe(`${wf}#a/steps.u`);
  });

  it('survives a plan in which its workflow is no longer triggered', () => {
    const release = '.github/workflows/release.yml';
    const tag = indexOf(starterTag);
    const id = resolveSelection(tag, release, 'publish.#2/cache')!;
    expect(selectionOf(tag, id)).toEqual({ focus: release, sel: 'publish.#2/cache' });
    expect(resolveSelection(indexOf(starterPush), release, 'publish.#2/cache')).toBe(release);
  });

  it('survives a matrix that lost the selected leg', () => {
    const [before, after] = [starter, { ...starter, [ci]: starter[ci]!.replace('[22, 24]', '[20, 24]') }].map(
      (files) => indexOf(simulated(files, { event: 'push', branch: 'main' })[0]!),
    );
    expect(resolveSelection(before!, ci, 'test[node=22].#2')).toBe(`${ci}#test[node=22]/~actions-setup-node`);
    expect(resolveSelection(after!, ci, 'test[node=22].#2')).toBe(`${ci}#test`);
    expect(resolveSelection(after!, ci, 'test[node=24].#2')).toBe(`${ci}#test[node=24]/~actions-setup-node`);
  });

  it('selects a called workflow through the leg that calls it, and an unknown id by its workflow', () => {
    const index = indexOf(monorepoPush);
    expect(selectionOf(index, `${ci}#web>.github/workflows/package.yml`)).toEqual({ focus: ci, sel: 'web' });
    expect(selectionOf(index, `${ci}#web>.github/workflows/package.yml#lint`)).toEqual({
      focus: ci,
      sel: 'web/lint',
    });
    expect(selectionOf(index, `${ci}#gone`)).toEqual({ focus: ci });
  });
});
