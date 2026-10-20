import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import { pinSentence, verdictChanges } from '../src/plan/changes';
import { planIndex } from '../src/plan/index';
import { handle, initialState } from '../src/worker/handle';

/**
 * What a pin changed, over the starter's real plans as the worker simulates them: the verdicts that differ, each
 * under no changed parent and never a leg, and the status line's sentence that says them.
 */

const starter = sampleByName('starter')!.files;
const CI = '.github/workflows/ci.yml';
const BUILD_STEP = `${CI}#build/~npm-run-build`;

const push: ScenarioInput = { event: 'push', branch: 'main' };
const docs: ScenarioInput = { ...push, changed: ['docs/**'] };
const source: ScenarioInput = { ...push, changed: ['src/index.ts'] };
const labeled: ScenarioInput = {
  event: 'pull_request',
  base: 'main',
  head: 'topic',
  number: 1,
  action: 'labeled',
};
const tag: ScenarioInput = { event: 'push', tag: 'v1' };
const dispatch = (deploy: boolean): ScenarioInput => ({
  event: 'workflow_dispatch',
  branch: 'main',
  inputs: { deploy },
});
/** The starter's `build.detect` writes `changed=true` or `changed=false`; the step after it runs on `'true'`. */
const detect = (changed: 'true' | 'false'): AssumeEntry => ({ step: 'build.detect', outputs: { changed } });

function simulated(files: Record<string, string>, scenario: ScenarioInput, assume: AssumeEntry[] = []) {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  const r = handle(loaded.state, { id: 2, type: 'simulate', project: 1, scenario, assume, detail: 'steps' });
  if (r.response.type !== 'plan') throw new Error(JSON.stringify(r.response));
  return { plan: r.response.plan, derived: r.response.derived };
}

const planned = (scenario: ScenarioInput, assume: AssumeEntry[] = []) => simulated(starter, scenario, assume);

const A = '.github/workflows/a.yml';
const B = '.github/workflows/b.yml';

/**
 * Two workflows on a push to main, each with a `deploy` job its own variable lets run (`SHIP_A`, `SHIP_B`): the same
 * unit path in two workflows, which the starter has none of. A name left undefined leaves the workflow unnamed.
 */
function twoDeploys(a: string | undefined, b: string | undefined): Record<string, string> {
  const workflow = (name: string | undefined, gate: string) =>
    `${name === undefined ? '' : `name: ${name}\n`}on:
  push:
    branches: [main]
jobs:
  deploy:
    if: vars.${gate} == 'yes'
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`;
  return { [A]: workflow(a, 'SHIP_A'), [B]: workflow(b, 'SHIP_B') };
}

const main: ScenarioInput = { event: 'push', branch: 'main' };
const shipA: ScenarioInput = { ...main, vars: { SHIP_A: 'yes' } };
const shipBoth: ScenarioInput = { ...main, vars: { SHIP_A: 'yes', SHIP_B: 'yes' } };
const topic: ScenarioInput = { event: 'push', branch: 'topic' };

/** The labels and the sentence of what a pin from one scenario to the next changed in `files`. */
function said(files: Record<string, string>, from: ScenarioInput, to: ScenarioInput) {
  const changes = verdictChanges(simulated(files, from), simulated(files, to));
  return { labels: changes.map((c) => c.label), sentence: pinSentence(changes) };
}

const verdictOf = (p: ReturnType<typeof planned>, id: string) => planIndex(p).nodes.get(id)?.verdict;

describe('what a pin changed', () => {
  it('is one change when the changed files stop a workflow, whose jobs are pruned under it', () => {
    const before = planned(push);
    const after = planned(docs);
    const changes = verdictChanges(before, after);
    expect(changes).toEqual([{ id: CI, kind: 'workflow', from: 'maybe', to: 'no', label: 'CI' }]);
    expect(verdictOf(before, `${CI}#deploy`)).toBe('maybe');
    expect(verdictOf(after, `${CI}#deploy`)).toBeUndefined();
    expect(pinSentence(changes)).toBe('pinned; CI is no longer triggered');
  });

  it('names the step a pinned output decides by its unit path', () => {
    const changes = verdictChanges(planned(source), planned(source, [detect('true')]));
    expect(changes).toEqual([{ id: BUILD_STEP, kind: 'step', from: 'maybe', to: 'yes', label: 'build.#3' }]);
    expect(pinSentence(changes)).toBe('pinned; build.#3 now runs');
  });

  it('leaves out every unit under a change, the matrix legs and their steps with them', () => {
    const before = planned(push);
    const after = planned(labeled);
    const leg = `${CI}#test[node=22]`;
    expect([verdictOf(before, leg), verdictOf(after, leg)]).toEqual(['maybe', 'yes']);
    expect([verdictOf(before, `${leg}/~npm-test`), verdictOf(after, `${leg}/~npm-test`)]).toEqual([
      'maybe',
      'yes',
    ]);
    expect(verdictChanges(before, after).map((c) => c.id)).toEqual([CI]);
  });

  it('never lists a leg, even one whose job kept its verdict', () => {
    // A job without `if:` runs its legs as it runs, so no starter plan turns a leg alone: this one is turned by hand.
    const before = planned(source);
    const plan = structuredClone(before.plan);
    const test = plan.workflows.find((w) => w.id === CI)!.jobs.find((j) => j.id === `${CI}#test`)!;
    const leg = test.legs[0]!;
    leg.runs = { ...leg.runs, verdict: 'maybe' };
    const after = { plan, derived: before.derived };
    expect([verdictOf(after, test.id), verdictOf(after, leg.id)]).toEqual(['yes', 'maybe']);
    expect(verdictChanges(before, after)).toEqual([]);
  });

  it('lists a step that changed under a leg whose job kept its verdict, since the leg is not listed for it', () => {
    const before = planned(source);
    const plan = structuredClone(before.plan);
    const test = plan.workflows.find((w) => w.id === CI)!.jobs.find((j) => j.id === `${CI}#test`)!;
    const leg = test.legs[0]!;
    const step = leg.steps![0]!;
    leg.runs = { ...leg.runs, verdict: 'maybe' };
    step.runs = { ...step.runs, verdict: 'maybe' };
    const changes = verdictChanges(before, { plan, derived: before.derived });
    expect(changes.map((c) => [c.id, c.kind, c.to])).toEqual([[step.id, 'step', 'maybe']]);
  });

  it.each([
    ['a workflow now triggered', docs, [], source, [], 'pinned; CI is now triggered'],
    ['a workflow no longer triggered', source, [], docs, [], 'pinned; CI is no longer triggered'],
    ['a workflow that might now be triggered', docs, [], push, [], 'pinned; CI might now be triggered'],
    ['a job that now runs', dispatch(false), [], dispatch(true), [], 'pinned; deploy now runs'],
    ['a job now skipped', dispatch(true), [], dispatch(false), [], 'pinned; deploy is now skipped'],
    ['a step that now runs', source, [], source, [detect('true')], 'pinned; build.#3 now runs'],
    ['a step now skipped', source, [], source, [detect('false')], 'pinned; build.#3 is now skipped'],
    ['a step that now might run', source, [detect('true')], source, [], 'pinned; build.#3 now might run'],
  ] satisfies [string, ScenarioInput, AssumeEntry[], ScenarioInput, AssumeEntry[], string][])(
    'words %s',
    (_, scenario, assume, nextScenario, nextAssume, sentence) => {
      const changes = verdictChanges(planned(scenario, assume), planned(nextScenario, nextAssume));
      expect(changes).toHaveLength(1);
      expect(pinSentence(changes)).toBe(sentence);
    },
  );

  it('names up to three changes in plan order, then counts the rest', () => {
    const pinned = planned(source, [detect('true')]);
    const three = verdictChanges(planned(labeled), pinned);
    expect(three.map((c) => [c.label, c.from, c.to])).toEqual([
      ['build.#3', 'maybe', 'yes'],
      ['deploy', 'no', 'yes'],
      ['preview', 'maybe', 'no'],
    ]);
    expect(pinSentence(three)).toBe('pinned; build.#3 now runs, deploy now runs and preview is now skipped');
    const two = verdictChanges(pinned, planned(tag));
    expect(pinSentence(two)).toBe('pinned; CI is no longer triggered and Release is now triggered');
    expect(pinSentence([...three, ...two])).toBe(
      'pinned; build.#3 now runs, deploy now runs and preview is now skipped; 2 more changed',
    );
  });

  it('names the workflow of a unit path that changed in two workflows, and only then', () => {
    expect(said(twoDeploys('CI', 'CD'), main, shipBoth)).toEqual({
      labels: ['deploy in CI', 'deploy in CD'],
      sentence: 'pinned; deploy in CI now runs and deploy in CD now runs',
    });
    // The other workflow's deploy kept its verdict: the label does not repeat, so it stays as short as it is.
    expect(said(twoDeploys('CI', 'CD'), main, shipA)).toEqual({
      labels: ['deploy'],
      sentence: 'pinned; deploy now runs',
    });
  });

  it('names a workflow by its path when it has no name, or shares its name with another', () => {
    expect(said(twoDeploys(undefined, 'CD'), main, shipBoth).labels).toEqual([
      `deploy in ${A}`,
      'deploy in CD',
    ]);
    expect(said(twoDeploys('CI', 'CI'), main, shipBoth).labels).toEqual([`deploy in ${A}`, `deploy in ${B}`]);
    expect(said(twoDeploys('CI', 'CI'), main, topic)).toEqual({
      labels: [A, B],
      sentence: `pinned; ${A} is no longer triggered and ${B} is no longer triggered`,
    });
    expect(said(twoDeploys('CI', 'CD'), main, topic).labels).toEqual(['CI', 'CD']);
  });

  it('says no verdict changed when the pin decided nothing new', () => {
    const changes = verdictChanges(planned(source), planned(source, [{ job: 'deploy', outcome: 'success' }]));
    expect(changes).toEqual([]);
    expect(pinSentence(changes)).toBe('pinned; no verdict changed');
  });
});
