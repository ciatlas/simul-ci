import {
  type AssumeEntry,
  type Json,
  mergeScenario,
  type ScenarioInput,
  type Unknown,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import type { PinContext } from '../src/panels/pin-draft';
import { applyScenarioPin, pinControl, pinFocus, withEntry, withoutEntry } from '../src/scenario/apply-pin';
import { handle, initialState } from '../src/worker/handle';
import type { PlanResponse } from '../src/worker/protocol';

/** The worker's answer for the files under a scenario and a case layer. */
function simulated(
  files: Record<string, string>,
  scenario: ScenarioInput,
  assume: AssumeEntry[] = [],
): PlanResponse {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume,
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  return step.response;
}

const contextOf = (r: PlanResponse): PinContext => ({ plan: r.plan, derived: r.derived, models: [] });
const unknownOf = (r: PlanResponse, id: string): Unknown => {
  const u = r.plan.unknowns.find((x) => x.id === id);
  if (!u) throw new Error(`no unknown ${id} in ${r.plan.unknowns.map((x) => x.id).join(', ')}`);
  return u;
};
const synthetic = (id: string, more: Partial<Unknown> = {}): Unknown => ({
  id,
  kind: 'unsupported',
  reads: [],
  affects: [],
  ...more,
});

const starter = sampleByName('starter')!.files;
const CI = '.github/workflows/ci.yml';

const gated = {
  [CI]: `on: push
jobs:
  repo:
    if: github.repository == 'acme/app'
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
  actor:
    if: github.actor == 'me'
    runs-on: ubuntu-latest
    steps:
      - run: ./mine.sh
`,
};

const jobVerdict = (r: PlanResponse, jobId: string) =>
  r.plan.workflows[0]?.jobs.find((j) => j.jobId === jobId)?.runs.verdict;

const failFast = {
  [CI]: `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps:
      - run: npm test
`,
};

describe('pinControl', () => {
  it('sets the changed files a push leaves unknown, and the paths filter decides', () => {
    const scenario: ScenarioInput = { event: 'push', branch: 'main' };
    const before = simulated(starter, scenario);
    const control = pinControl(unknownOf(before, 'scenario.changed'), contextOf(before));
    expect(control).toEqual({
      kind: 'scenario',
      label: 'Set changed files',
      fragment: { changed: ['docs/**'] },
      focus: { path: 'changed' },
    });
    if (control.kind !== 'scenario') return;
    const pinned = applyScenarioPin(scenario, control.fragment);
    expect(pinned).toEqual({ scenario: { ...scenario, changed: ['docs/**'] }, keys: ['changed'] });
    const after = simulated(starter, pinned.scenario);
    expect(after.plan.unknowns.map((u) => u.id)).not.toContain('scenario.changed');
    // docs/** is what paths-ignore ignores: CI is decided, and decided not to run.
    expect(after.plan.workflows.find((w) => w.path === CI)?.triggered.verdict).toBe('no');
  });

  it('sets the repository a job reads, and the job is decided', () => {
    const scenario: ScenarioInput = { event: 'push', branch: 'main' };
    const before = simulated(gated, scenario);
    expect(jobVerdict(before, 'repo')).toBe('maybe');
    const control = pinControl(unknownOf(before, 'github.repository'), contextOf(before));
    expect(control).toEqual({
      kind: 'scenario',
      label: 'Set the repository',
      fragment: { repository: 'owner/name' },
      focus: { path: 'repository' },
    });
    if (control.kind !== 'scenario') return;
    const pinned = applyScenarioPin(scenario, control.fragment);
    expect(pinned).toEqual({ scenario: { ...scenario, repository: 'owner/name' }, keys: ['repository'] });
    const after = simulated(gated, pinned.scenario);
    expect(after.plan.unknowns.map((u) => u.id)).not.toContain('github.repository');
    expect(jobVerdict(after, 'repo')).toBe('no');
  });

  it('sets the actor with an example the author types over', () => {
    const scenario: ScenarioInput = { event: 'push', branch: 'main', actor: { bot: false } };
    const before = simulated(gated, scenario);
    const control = pinControl(unknownOf(before, 'github.actor'), contextOf(before));
    expect(control).toMatchObject({
      kind: 'scenario',
      label: 'Set the actor',
      focus: { path: 'actor.login' },
    });
    if (control.kind !== 'scenario') return;
    const pinned = applyScenarioPin(scenario, control.fragment);
    // The actor merges key by key; the empty login is the example the focused field selects.
    expect(pinned.scenario.actor).toEqual({ bot: false, login: '' });
    const typed = applyScenarioPin(pinned.scenario, { actor: { login: 'me' } });
    expect(jobVerdict(simulated(gated, typed.scenario), 'actor')).toBe('yes');
  });

  it('opens the editor for a step output the engine has no pin for', () => {
    const r = simulated(starter, { event: 'push', branch: 'main', changed: ['src/a.ts'] });
    const control = pinControl(unknownOf(r, `${CI}#build/steps.detect.outputs.changed`), contextOf(r));
    expect(control).toMatchObject({
      kind: 'editor',
      label: 'Pin…',
      draft: { entry: { step: 'build.detect', outputs: { changed: '' } } },
    });
  });

  it('says what nothing the author writes can pin', () => {
    const r = simulated(starter, { event: 'push', branch: 'main' });
    const ctx = contextOf(r);
    expect(pinControl(unknownOf(r, 'expression:success()'), ctx)).toEqual({
      kind: 'none',
      text: 'only the run decides it',
    });
    expect(pinControl(synthetic('runner.os', { gap: 'the runner decides it' }), ctx)).toEqual({
      kind: 'none',
      text: 'the runner decides it',
    });
    const config = { layer: 'config' as const, fragment: { models: [] } };
    expect(pinControl(synthetic('x', { pin: config }), ctx)).toEqual({
      kind: 'none',
      text: 'set in the config layer, which the web app does not read',
    });
    expect(pinControl(synthetic('x', { pin: config, gap: 'a model' }), ctx)).toEqual({
      kind: 'none',
      text: 'a model',
    });
  });

  it('sets an input whose default only the run evaluates', () => {
    const r = simulated(starter, { event: 'push', branch: 'main' });
    expect(pinControl(synthetic('inputs.target.default', { kind: 'input' }), contextOf(r))).toEqual({
      kind: 'scenario',
      label: 'Set input target',
      fragment: { inputs: { target: '' } },
      focus: { path: 'inputs.target' },
    });
  });

  it('applies a scenario fragment that is no record to nothing', () => {
    const r = simulated(starter, { event: 'push', branch: 'main' });
    const pin = { layer: 'scenario' as const, fragment: ['changed'] };
    expect(pinControl(synthetic('scenario.odd', { pin }), contextOf(r)).kind).toBe('none');
  });

  it('names each scenario field a fragment writes', () => {
    const r = simulated(starter, { event: 'push', branch: 'main' });
    const cases: [Record<string, Json>, string, { path: string; entry?: string }][] = [
      [{ action: 'opened' }, 'Set the activity type', { path: 'action' }],
      [{ workflow_run: { name: 'CI' } }, 'Set the triggering workflow', { path: 'workflow_run.name' }],
      [{ workflow_run: { branch: 'main' } }, 'Set its branch', { path: 'workflow_run.branch' }],
      [{ inputs: { deploy: '' } }, 'Set input deploy', { path: 'inputs.deploy' }],
      [{ vars: { DEPLOY: '' } }, 'Set vars.DEPLOY', { path: 'vars', entry: 'DEPLOY' }],
      [{ workflow_run: {} }, 'Set the triggering run', { path: 'workflow_run' }],
      [{ sha: '' }, 'Set the commit SHA', { path: 'sha' }],
      [{ actor: { login: '' } }, 'Set the actor', { path: 'actor.login' }],
      [{ repository: 'owner/name' }, 'Set the repository', { path: 'repository' }],
      [{ tag: '' }, 'Set the tag', { path: 'tag' }],
      [{ cron: '' }, 'Set cron', { path: 'cron' }],
    ];
    for (const [fragment, label, focus] of cases) {
      const pin = { layer: 'scenario' as const, fragment };
      expect(pinControl(synthetic('x', { pin }), contextOf(r)), label).toEqual({
        kind: 'scenario',
        label,
        fragment,
        focus,
      });
    }
  });

  it('assumes the cancelled leg the fail-fast race leaves open', () => {
    const r = simulated(failFast, { event: 'push', branch: 'main' }, [
      { step: 'test[node=22].#1', outcome: 'failure' },
    ]);
    const race = unknownOf(r, `race:fail-fast:${CI}#test[node=24]`);
    const control = pinControl(race, contextOf(r));
    expect(control).toEqual({
      kind: 'assume',
      label: 'Assume cancelled',
      entry: { job: 'test', matrix: { node: '24' }, outcome: 'cancelled' },
    });
    // The entry is the one the unknown carries, as it carries it.
    expect(control.kind === 'assume' && control.entry).toBe(race.pin?.fragment);
  });

  // The engine applies a job entry's outcome at the job boundary, whose chain has no leg, so the race's own pin
  // (`job` with `matrix`) matches nothing (SC102) and the race stays. Flip to `it` when the engine applies it per leg.
  it.fails('decides the race once its pin is applied', () => {
    const assume: AssumeEntry[] = [{ step: 'test[node=22].#1', outcome: 'failure' }];
    const r = simulated(failFast, { event: 'push', branch: 'main' }, assume);
    const control = pinControl(unknownOf(r, `race:fail-fast:${CI}#test[node=24]`), contextOf(r));
    if (control.kind !== 'assume') throw new Error(control.kind);
    const after = simulated(failFast, { event: 'push', branch: 'main' }, withEntry(assume, control.entry));
    expect(after.plan.diagnostics).toEqual([]);
    expect(after.plan.unknowns.map((u) => u.id)).not.toContain(`race:fail-fast:${CI}#test[node=24]`);
  });

  it('words an assume pin by its outcome, and passes over one that names no unit', () => {
    const r = simulated(starter, { event: 'push', branch: 'main' });
    const ctx = contextOf(r);
    const pin = (fragment: Json) => ({ pin: { layer: 'assume' as const, fragment } });
    expect(pinControl(synthetic('x', pin({ step: 'a.b', outcome: 'failure' })), ctx)).toMatchObject({
      kind: 'assume',
      label: 'Assume failure',
    });
    expect(pinControl(synthetic('x', pin({ job: 'a', outputs: { v: '1' } })), ctx)).toMatchObject({
      kind: 'assume',
      label: 'Add the assumption',
    });
    expect(pinControl(synthetic('race:x', pin({ uses: 'a/b', outcome: 'failure' })), ctx).kind).toBe('none');
  });
});

describe('applyScenarioPin', () => {
  const cases: [string, ScenarioInput, Record<string, Json>][] = [
    [
      'a tag replaces the branch and the ref',
      { event: 'push', branch: 'main', ref: 'refs/heads/main' },
      { tag: '' },
    ],
    ['what is not the ref group keeps the ref', { event: 'push', tag: 'v1' }, { sha: '' }],
    [
      'inputs merge key by key',
      { event: 'workflow_dispatch', inputs: { a: 'x', b: true } },
      { inputs: { b: '' } },
    ],
    ['vars merge key by key', { event: 'push', vars: { A: '1' } }, { vars: { B: '' } }],
    [
      'the actor merges key by key',
      { event: 'push', actor: { login: 'me', bot: true } },
      { actor: { login: '' } },
    ],
    ['the changed files are replaced', { event: 'push', changed: ['a.ts'] }, { changed: ['docs/**'] }],
    [
      'the triggering run is replaced',
      { event: 'workflow_run', workflow_run: { name: 'CI', branch: 'x' } },
      { workflow_run: { branch: 'main' } },
    ],
    ['a record over no record is written', { event: 'push' }, { vars: { A: '' } }],
  ];

  for (const [name, scenario, fragment] of cases) {
    it(`merges as the test runner merges when over given: ${name}`, () => {
      const { scenario: out, keys } = applyScenarioPin(scenario, fragment);
      expect(out).toEqual(mergeScenario(scenario as never, fragment as never));
      expect(keys).toEqual(Object.keys(fragment));
    });
  }

  it('replaces the ref group whole', () => {
    const { scenario } = applyScenarioPin(
      { event: 'push', branch: 'main', ref: 'refs/heads/main' },
      { tag: 'v2' },
    );
    expect(scenario).toEqual({ event: 'push', tag: 'v2' });
  });

  it('keeps a key named __proto__ as data', () => {
    const fragment = JSON.parse('{"vars":{"__proto__":"x"},"__proto__":{"polluted":"yes"}}') as Record<
      string,
      Json
    >;
    const { scenario, keys } = applyScenarioPin({ event: 'push', vars: { A: '1' } }, fragment);
    expect(Object.hasOwn(scenario, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(scenario)).toBe(Object.prototype);
    expect(Object.hasOwn(scenario.vars!, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(scenario.vars)).toBe(Object.prototype);
    expect(Object.entries(scenario.vars!)).toEqual([
      ['A', '1'],
      ['__proto__', 'x'],
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(keys).toEqual(['vars', '__proto__']);
  });

  it('changes neither the scenario nor the fragment', () => {
    const scenario = Object.freeze({ event: 'push', vars: Object.freeze({ A: '1' }) });
    const fragment = Object.freeze({ vars: Object.freeze({ B: '' }) });
    const { scenario: out } = applyScenarioPin(scenario, fragment);
    expect(out.vars).toEqual({ A: '1', B: '' });
    expect(scenario.vars).toEqual({ A: '1' });
  });
});

describe('pinFocus', () => {
  it('names the field the first key writes', () => {
    expect(pinFocus({ vars: { DEPLOY: '' } })).toEqual({ path: 'vars', entry: 'DEPLOY' });
    expect(pinFocus({ vars: {} })).toEqual({ path: 'vars' });
    expect(pinFocus({ inputs: { deploy: '' } })).toEqual({ path: 'inputs.deploy' });
    expect(pinFocus({ inputs: {} })).toEqual({ path: 'inputs' });
    expect(pinFocus({ actor: { login: '' } })).toEqual({ path: 'actor.login' });
    expect(pinFocus({ workflow_run: { name: 'CI' } })).toEqual({ path: 'workflow_run.name' });
    expect(pinFocus({ workflow_run: 'odd' })).toEqual({ path: 'workflow_run' });
    expect(pinFocus({ changed: ['a'], action: 'x' })).toEqual({ path: 'changed' });
    expect(pinFocus({})).toEqual({ path: '' });
  });
});

describe('the case layer', () => {
  const a: AssumeEntry = { step: 'a.b', outcome: 'failure' };
  const b: AssumeEntry = { job: 'c', outcome: 'success' };
  const c: AssumeEntry = { job: 'd', outcome: 'cancelled' };
  const layer = Object.freeze([a, b]);

  it('adds an entry at the end, or in place of the one at an index', () => {
    expect(withEntry(layer, c)).toEqual([a, b, c]);
    expect(withEntry(layer, c, 0)).toEqual([c, b]);
    expect(withEntry(layer, c, 1)).toEqual([a, c]);
    expect(withEntry(layer, c, 5)).toEqual([a, b, c]);
    expect(withEntry(layer, c, -1)).toEqual([a, b, c]);
    expect(layer).toEqual([a, b]);
  });

  it('removes the entry at an index', () => {
    expect(withoutEntry(layer, 0)).toEqual([b]);
    expect(withoutEntry(layer, 1)).toEqual([a]);
    expect(withoutEntry(layer, 2)).toEqual([a, b]);
    expect(withoutEntry(layer, 0)).not.toBe(layer);
  });
});
