import { type AssumeEntry, type ScenarioInput, simulate } from '@simulci/engine';
import { diffPlans } from '@simulci/engine/plan';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import { type ChangeRow, changeRows, changeSentence, clauseOf } from '../src/plan/change-rows';
import { diffOf, pinSentence, verdictChanges } from '../src/plan/changes';
import { planIndex } from '../src/plan/index';
import { deriveTables } from '../src/worker/derived';
import { handle, initialState } from '../src/worker/handle';

/**
 * What a pin or an edit changed, over the starter's real plans as the worker simulates them (synthesis § 7.4): the
 * engine's `diffPlans` and the views over it. A pin's verdict changes, each under no changed parent and never a leg,
 * and its sentence; an edit's rows (the nodes and check names added, removed or turned, the checks a job's row
 * implies, a step renamed in place as one step) and its sentence, which names workflows, jobs and check names and only
 * counts steps; and the comparison of a plan made with `planUntriggered` with one made without.
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

/** The plan as edit mode asks for it once C2 lands: the listed workflows' jobs planned although untriggered. */
function untriggeredPlanned(
  files: Record<string, string>,
  scenario: ScenarioInput,
  planUntriggered: string[],
) {
  const { project } = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' }).state;
  const plan = simulate({ project: project!.loaded, scenario, assume: [], detail: 'steps', planUntriggered });
  return { plan, derived: deriveTables(plan, project!.outline) };
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

describe('verdictChanges over diffPlans', () => {
  it.each([
    ['changed files that stop a workflow', push, [], docs, []],
    ['a pinned output', source, [], source, [detect('true')]],
    ['a pull request that runs the matrix', push, [], labeled, []],
    ['a tag', source, [detect('true')], tag, []],
  ] satisfies [string, ScenarioInput, AssumeEntry[], ScenarioInput, AssumeEntry[]][])(
    'is the diff’s verdict changes for %s, in its order',
    (_, scenario, assume, nextScenario, nextAssume) => {
      const before = planned(scenario, assume);
      const after = planned(nextScenario, nextAssume);
      const changed = diffPlans(before.plan, after.plan).changed;
      expect(verdictChanges(before, after).map((c) => [c.id, c.from, c.to])).toEqual(
        changed.map((c) => [c.id, c.from, c.to]),
      );
    },
  );
});

/** The starter's CI with `edit` applied to its text. */
const edited = (edit: (text: string) => string): Record<string, string> => ({
  ...starter,
  [CI]: edit(starter[CI]!),
});

/** What an edit of the starter's CI changed, on a push to main: its rows and the sentence an op labelled `label` says. */
function editSaid(edit: (text: string) => string, label = 'Edited ci.yml', scenario: ScenarioInput = push) {
  const before = simulated(starter, scenario);
  const after = simulated(edited(edit), scenario);
  const rows = changeRows(diffOf(before.plan, after.plan), before, after);
  return { rows, sentence: changeSentence(rows, label), before, after };
}

/** The starter's deploy condition, which runs it on a push. */
const DEPLOY_IF = "github.event_name == 'push' || inputs.deploy";

const brief = (rows: readonly ChangeRow[]) =>
  rows.map((r) => [r.change, r.kind, r.label, r.implied ?? false]);

const LINT = `  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint

`;

describe('what an edit changed', () => {
  it('says a branch filter that untriggers CI as one change, its checks implied', () => {
    const { rows, sentence } = editSaid((t) => t.replace('branches: [main]', 'branches: [release]'));
    expect(rows[0]).toMatchObject({ change: 'changed', kind: 'workflow', label: 'CI', to: 'no' });
    expect(rows[0]!.select).toEqual({ focus: CI });
    // Every check CI reported goes with it, and the workflow's row says so.
    expect(rows.slice(1).every((r) => r.kind === 'check' && r.change === 'removed' && r.implied)).toBe(true);
    expect(rows.slice(1).map((r) => r.label)).toEqual([
      'test (22)',
      'test (24)',
      'build',
      'deploy',
      'preview',
    ]);
    expect(sentence).toBe('Edited ci.yml: CI is no longer triggered');
  });

  it('names an added job with its verdict, selects it, and leaves its check to Details', () => {
    // A push of a source change: CI runs, so the new job does.
    const { rows, sentence } = editSaid(
      (t) => t.replace('  build:\n', `${LINT}  build:\n`),
      'Added job lint',
      source,
    );
    expect(brief(rows)).toEqual([
      ['added', 'job', 'lint', false],
      ['added', 'check', 'lint', true],
    ]);
    expect(rows[0]).toMatchObject({
      to: 'yes',
      id: `${CI}#lint`,
      card: `${CI}#lint`,
      select: { focus: CI, sel: 'lint' },
    });
    expect(sentence).toBe('Added job lint: new job lint runs');
  });

  it('names a removed job by the plan before, and selects nothing the plan after has not', () => {
    const { rows, sentence } = editSaid((t) => t.slice(0, t.indexOf('  preview:')), 'Removed job preview');
    expect(brief(rows)).toEqual([
      ['removed', 'job', 'preview', false],
      ['removed', 'check', 'preview', true],
    ]);
    expect(rows[0]).toMatchObject({ from: 'no', card: CI });
    expect(rows[0]!.select).toBeUndefined();
    expect(sentence).toBe('Removed job preview: job preview removed');
  });

  it('says a renamed check, the required-check footgun, though no verdict and no id changed', () => {
    const { rows, sentence } = editSaid((t) => t.replace('  build:\n', '  build:\n    name: Build it\n'));
    expect(brief(rows)).toEqual([
      ['removed', 'check', 'build', false],
      ['added', 'check', 'Build it', false],
    ]);
    // The job that reports it is still there: both rows select it.
    expect(rows.map((r) => r.select)).toEqual([
      { focus: CI, sel: 'build' },
      { focus: CI, sel: 'build' },
    ]);
    expect(sentence).toBe("Edited ci.yml: check 'build' removed and check 'Build it' added");
  });

  it('turns a job and its checks, the checks implied', () => {
    const { rows, sentence } = editSaid((t) => t.replace(DEPLOY_IF, 'false'), 'Edited if of deploy');
    expect(brief(rows)).toEqual([
      ['changed', 'job', 'deploy', false],
      ['changed', 'check', 'deploy', true],
    ]);
    expect(sentence).toBe('Edited if of deploy: deploy is now skipped');
  });

  it('counts steps without naming them, and Details names them', () => {
    const { rows, sentence } = editSaid(
      (t) => t.replace('      - run: npm test\n', '      - run: npm test\n      - run: npm run e2e\n'),
      'Edited ci.yml',
      source,
    );
    expect(brief(rows)).toEqual([
      ['added', 'step', 'test[node=22].#5', false],
      ['added', 'step', 'test[node=24].#5', false],
    ]);
    expect(rows.map(clauseOf)).toEqual(['new step test[node=22].#5 runs', 'new step test[node=24].#5 runs']);
    expect(sentence).toBe('Edited ci.yml: 2 changes in Details');
  });

  it('takes a step renamed in place for the step it was, so retyping its command says nothing', () => {
    const { rows, sentence } = editSaid((t) =>
      t.replace('- run: npm run build\n', '- run: npm run build:prod\n'),
    );
    expect(rows).toEqual([]);
    expect(sentence).toBe('Edited ci.yml: no verdict changed');
  });

  it('names the check names a matrix value changes, and counts the legs', () => {
    const { rows, sentence } = editSaid((t) => t.replace('node: [22, 24]', 'node: [22, 26]'));
    expect(brief(rows)).toEqual([
      ['added', 'leg', 'test[node=26]', false],
      ['removed', 'leg', 'test[node=24]', false],
      ['removed', 'check', 'test (24)', false],
      ['added', 'check', 'test (26)', false],
    ]);
    expect(sentence).toBe(
      "Edited ci.yml: check 'test (24)' removed and check 'test (26)' added; 2 more in Details",
    );
  });

  it('names three, then counts the rest', () => {
    const rows: ChangeRow[] = ['a', 'b', 'c', 'd'].map((label) => ({
      change: 'added',
      kind: 'job',
      to: 'yes',
      label,
      id: label,
    }));
    expect(changeSentence(rows, 'Pasted')).toBe(
      'Pasted: new job a runs, new job b runs and new job c runs; 1 more in Details',
    );
  });

  it.each([
    [{ change: 'added', kind: 'workflow', to: 'maybe' }, 'new workflow X might be triggered'],
    [{ change: 'added', kind: 'workflow', to: 'no' }, 'new workflow X is not triggered'],
    [{ change: 'added', kind: 'job', to: 'no' }, 'new job X is skipped'],
    [{ change: 'removed', kind: 'workflow', from: 'yes' }, 'workflow X removed'],
    [{ change: 'changed', kind: 'workflow', from: 'no', to: 'yes' }, 'X is now triggered'],
    [{ change: 'changed', kind: 'step', from: 'yes', to: 'maybe' }, 'X now might run'],
    [{ change: 'changed', kind: 'check', from: 'yes', to: 'no' }, "check 'X' is now skipped"],
  ] satisfies [Pick<ChangeRow, 'change' | 'kind'> & Partial<Record<'from' | 'to', string>>, string][])(
    'words %o',
    (row, clause) => {
      expect(clauseOf({ ...row, label: 'X', id: 'x' } as ChangeRow)).toBe(clause);
    },
  );
});

describe('plans made with and without planUntriggered', () => {
  const release = edited((t) => t.replace('branches: [main]', 'branches: [release]'));

  it('compares a workflow untriggered in both as a shell, whichever plan planned its jobs', () => {
    const shell = simulated(release, push);
    const kept = untriggeredPlanned(release, push, [CI]);
    expect(kept.plan.workflows.find((w) => w.id === CI)!.jobs.length).toBeGreaterThan(0);
    // diffPlans alone would call every job added, then every job removed.
    expect(diffPlans(shell.plan, kept.plan).added.length).toBeGreaterThan(0);
    expect(diffOf(shell.plan, kept.plan)).toEqual({
      added: [],
      removed: [],
      changed: [],
      checks: { added: [], removed: [], changed: [] },
    });
    expect(changeRows(diffOf(kept.plan, shell.plan), kept, shell)).toEqual([]);
  });

  it('still says what an edit did to the jobs of a workflow both plans planned untriggered', () => {
    const before = untriggeredPlanned(release, push, [CI]);
    const after = untriggeredPlanned(
      edited((t) =>
        t.replace('branches: [main]', 'branches: [release]').replace('  build:\n', `${LINT}  build:\n`),
      ),
      push,
      [CI],
    );
    const rows = changeRows(diffOf(before.plan, after.plan), before, after);
    expect(brief(rows)).toEqual([['added', 'job', 'lint', false]]);
  });
});
