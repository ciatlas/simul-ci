import {
  type ContextState,
  evaluateCondition,
  jobStatusFunctions,
  known,
  lookupContext,
  parseScenario,
  stepStatusFunctions,
  unknown,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const state = (extra: Partial<ContextState> = {}): ContextState => ({
  scenario: parseScenario({
    event: 'pull_request',
    action: 'opened',
    head: 'feature',
    number: 7,
    sha: 'abc1234',
    repository: 'ciatlas/simulci',
    message: 'wip',
    vars: { DEPLOY: 'true' },
    secrets: ['NPM_TOKEN'],
    inputs: { dry: true },
    actor: { login: 'octocat', fork: true },
  }),
  workflow: 'CI',
  job: 'build',
  ...extra,
});

const read = (s: ContextState, context: string, ...path: string[]) => lookupContext(s, { context, path });

describe('lookupContext', () => {
  it('answers github.* from the scenario and names what it cannot', () => {
    const s = state();
    expect(read(s, 'github', 'event_name')).toEqual(known('pull_request'));
    expect(read(s, 'github', 'ref')).toEqual(known('refs/pull/7/merge'));
    expect(read(s, 'github', 'ref_name')).toEqual(known('7/merge'));
    expect(read(s, 'github', 'ref_type')).toEqual(known('branch'));
    expect(read(s, 'github', 'base_ref')).toEqual(known('main'));
    expect(read(s, 'github', 'head_ref')).toEqual(known('feature'));
    expect(read(s, 'github', 'sha')).toEqual(known('abc1234'));
    expect(read(s, 'github', 'repository_owner')).toEqual(known('ciatlas'));
    expect(read(s, 'github', 'actor')).toEqual(known('octocat'));
    expect(read(s, 'github', 'workflow')).toEqual(known('CI'));
    expect(read(s, 'github', 'job')).toEqual(known('build'));
    expect(read(s, 'github', 'event', 'pull_request', 'head', 'repo', 'fork')).toEqual(known(true));
    expect(read(s, 'github', 'event', 'pull_request', 'number')).toEqual(known(7));
    expect(read(s, 'github', 'event', 'head_commit', 'message')).toEqual(known('wip'));
    expect(read(s, 'github', 'event', 'repository', 'default_branch')).toEqual(known('main'));
    expect(read(s, 'github', 'run_id')).toEqual(unknown(['github.run_id']));
    expect(read(s, 'github', 'event', 'pull_request', 'draft')).toEqual(
      unknown(['github.event.pull_request.draft']),
    );
  });

  it('reads github.event.inputs as strings and inputs as typed values', () => {
    const s = state({ inputs: { dry: known(true), name: known('x') } });
    expect(read(s, 'github', 'event', 'inputs', 'dry')).toEqual(known('true'));
    expect(read(s, 'github', 'event', 'inputs', 'missing')).toEqual(known(''));
    expect(read(s, 'inputs', 'dry')).toEqual(known(true));
    expect(read(s, 'inputs', 'missing')).toEqual(known(''));
  });

  it('reads vars and secrets as the scenario declares them', () => {
    const s = state();
    expect(read(s, 'vars', 'DEPLOY')).toEqual(known('true'));
    expect(read(s, 'vars', 'deploy')).toEqual(known('true'));
    expect(read(s, 'vars', 'OTHER')).toEqual(unknown(['vars.OTHER']));
    expect(read(s, 'secrets', 'NPM_TOKEN')).toEqual(unknown(['secrets.NPM_TOKEN']));
    expect(read(s, 'secrets', 'GITHUB_TOKEN')).toEqual(unknown(['secrets.GITHUB_TOKEN']));
    expect(read(s, 'secrets', 'MISSING')).toEqual(known(''));
  });

  it('reads needs and steps with empty values for what is absent (lab 2, 3)', () => {
    const s = state({
      needs: {
        a: { result: known('skipped'), outputs: {} },
        b: { result: known('success'), outputs: { v: known('1') } },
      },
      steps: { s: { outcome: known('skipped'), conclusion: known('skipped'), outputs: {} } },
    });
    expect(read(s, 'needs', 'a', 'result')).toEqual(known('skipped'));
    expect(read(s, 'needs', 'a', 'outputs', 'v')).toEqual(known(''));
    expect(read(s, 'needs', 'b', 'outputs', 'v')).toEqual(known('1'));
    expect(read(s, 'needs', 'zz', 'outputs', 'v')).toEqual(known(''));
    expect(read(s, 'needs', 'zz')).toEqual(known(null));
    expect(read(s, 'steps', 's', 'outcome')).toEqual(known('skipped'));
    expect(read(s, 'steps', 's', 'outputs', 'x')).toEqual(known(''));
    expect(read(s, 'steps', 'none', 'conclusion')).toEqual(known(''));
  });

  it('reads matrix, job, runner and strategy', () => {
    const s = state({
      matrix: {
        values: { os: { known: true, value: 'ubuntu-latest' }, n: { known: false } },
        origin: 'product',
        includes: [],
      },
      status: known('success'),
      runsOn: ['ubuntu-latest'],
      strategy: { failFast: known(false), jobIndex: 1, jobTotal: 3 },
    });
    expect(read(s, 'matrix', 'os')).toEqual(known('ubuntu-latest'));
    expect(read(s, 'matrix', 'n')).toEqual(unknown(['matrix.n']));
    expect(read(s, 'matrix', 'missing')).toEqual(known(null));
    expect(read(s, 'job', 'status')).toEqual(known('success'));
    expect(read(s, 'runner', 'os')).toEqual(known('Linux'));
    expect(read(s, 'runner', 'arch')).toEqual(known('X64'));
    expect(read(s, 'runner', 'temp')).toEqual(unknown(['runner.temp']));
    expect(read(s, 'strategy', 'fail-fast')).toEqual(known(false));
    expect(read(s, 'strategy', 'job-index')).toEqual(known(1));
    expect(read(state(), 'runner', 'os')).toEqual(unknown(['runner.os']));
    expect(read(state(), 'matrix', 'os')).toEqual(known(null));
  });
});

describe('evaluateCondition', () => {
  const okNeeds = jobStatusFunctions([known('success')]);

  it('decides conditions on the scenario with the status functions answered', () => {
    const s = state();
    expect(evaluateCondition("success() && (github.event_name == 'pull_request')", s, okNeeds)).toEqual({
      value: known(true),
      reads: [{ ref: 'github.event_name', value: known('pull_request') }],
    });
    expect(evaluateCondition("success() && (github.ref == 'refs/heads/main')", s, okNeeds).value).toEqual(
      known(false),
    );
    expect(evaluateCondition('failure()', s, okNeeds).value).toEqual(known(false));
    expect(evaluateCondition('always()', s, okNeeds).value).toEqual(known(true));
    expect(evaluateCondition('success() && (false)', s, okNeeds).value).toEqual(known(false));
  });

  it('is unknown because of the reads it names, and decides what the reads cannot change (lab unknown-or-true)', () => {
    const s = state();
    const c = evaluateCondition("success() && (vars.OTHER == 'x')", s, okNeeds);
    expect(c.value).toEqual(unknown(['vars.OTHER'], [true, false]));
    expect(c.reads).toEqual([{ ref: 'vars.OTHER', value: unknown(['vars.OTHER']) }]);
    expect(evaluateCondition('success() && (vars.OTHER || true)', s, okNeeds).value).toEqual(known(true));
    expect(evaluateCondition('success() && (vars.OTHER && false)', s, okNeeds).value).toEqual(known(false));
  });

  it('is unknown when a status answer is, and false at a skipped need under success()', () => {
    const s = state();
    const skipped = jobStatusFunctions([known('skipped')]);
    expect(evaluateCondition('success()', s, skipped).value).toEqual(known(false));
    expect(evaluateCondition('always()', s, skipped).value).toEqual(known(true));
    const maybe = jobStatusFunctions([unknown(['u'], ['success', 'failure'])]);
    expect(evaluateCondition('success()', s, maybe).value).toEqual(unknown(['u'], [true, false]));
    expect(evaluateCondition('failure()', s, stepStatusFunctions(known('failure'))).value).toEqual(
      known(true),
    );
  });

  it('is unknown for an expression it cannot parse', () => {
    expect(evaluateCondition('success() && (github.ref ==', state(), okNeeds).value).toEqual(
      unknown(['expression:success() && (github.ref =='], [true, false]),
    );
  });
});
