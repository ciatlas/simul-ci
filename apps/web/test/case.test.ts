import { type AssumeEntry, loadFiles, runTests, type ScenarioInput, TestFileSchema } from '@simulci/engine';
import { TESTS_DIR as NODE_TESTS_DIR } from '@simulci/node';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { sampleByName } from '../src/input/samples';
import { defaultScenario } from '../src/scenario/defaults';
import type { PlanState, SessionState } from '../src/state/store';
import {
  CASE_FORMATS,
  type CaseFormat,
  caseAvailability,
  caseBody,
  destinationOf,
  downloadName,
  formatInfo,
  isTestFormat,
  outcomeOf,
  requestCase,
  TESTS_DIR,
  testFilePath,
} from '../src/testcase/case';
import type { CaseResult, EngineClient } from '../src/worker/client';
import { handle, initialState } from '../src/worker/handle';
import type { CaseRequest } from '../src/worker/protocol';

type Inputs = Pick<SessionState, 'plan' | 'focus' | 'project' | 'scenario' | 'assume'>;

const CI = '.github/workflows/ci.yml';
const CALLEE = '.github/workflows/callee.yml';

/** A plan holding these workflows at these depths; the availability reads nothing else of it. */
const planOf = (workflows: { path: string; depth: number }[]): PlanState =>
  ({ plan: { workflows } }) as unknown as PlanState;

const scenario: ScenarioInput = { event: 'push', branch: 'main' };
const assume: AssumeEntry[] = [{ step: 'build.detect', outputs: { changed: 'true' } }];

/** What the store holds once the files are loaded as project 3 and simulated, with `ci.yml` focused. */
const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  plan: planOf([
    { path: CI, depth: 0 },
    { path: CALLEE, depth: 1 },
  ]),
  focus: CI,
  project: { status: 'ready', version: 3 },
  scenario,
  assume,
  ...over,
});

describe('whether a case can be asked for', () => {
  it('needs a plan for a ready project', () => {
    const none = { ok: false, reason: 'no plan yet' };
    expect(caseAvailability(inputs({ project: { status: 'idle' } }))).toEqual(none);
    expect(caseAvailability(inputs({ project: { status: 'loading', version: 3 } }))).toEqual(none);
    expect(caseAvailability(inputs({ project: { status: 'ready' } }))).toEqual(none);
    expect(caseAvailability(inputs({ plan: undefined }))).toEqual(none);
  });

  it('needs a focused workflow', () => {
    expect(caseAvailability(inputs({ focus: undefined }))).toEqual({
      ok: false,
      reason: 'no workflow picked',
    });
  });

  it('refuses a workflow the plan holds only as a callee, or not at all', () => {
    expect(caseAvailability(inputs({ focus: CALLEE }))).toEqual({
      ok: false,
      reason: `no workflow ${CALLEE} in the plan`,
    });
    expect(caseAvailability(inputs({ focus: '.github/workflows/gone.yml' }))).toEqual({
      ok: false,
      reason: 'no workflow .github/workflows/gone.yml in the plan',
    });
  });

  it('takes the focused workflow an event starts, also when another workflow calls it too', () => {
    expect(caseAvailability(inputs())).toEqual({ ok: true, workflow: CI, project: 3 });
    const both = planOf([
      { path: CALLEE, depth: 1 },
      { path: CALLEE, depth: 0 },
    ]);
    expect(caseAvailability(inputs({ plan: both, focus: CALLEE }))).toEqual({
      ok: true,
      workflow: CALLEE,
      project: 3,
    });
  });
});

describe('the formats', () => {
  it('offers the jobs case first, then the steps case and the plan as text and as Mermaid', () => {
    expect(CASE_FORMATS.map((f) => [f.format, f.label])).toEqual([
      ['jobs', 'Test case (jobs)'],
      ['steps', 'Test case (steps)'],
      ['text', 'Plan as text'],
      ['mermaid', 'Plan as Mermaid'],
    ]);
    expect(formatInfo('steps').type).toBe('application/yaml');
    expect(formatInfo('mermaid').type).toBe('text/plain');
    expect(formatInfo('nope' as CaseFormat).format).toBe('jobs');
    expect(CASE_FORMATS.map((f) => isTestFormat(f.format))).toEqual([true, true, false, false]);
  });
});

describe('the case request', () => {
  it('asks for a test of the focused workflow, with the steps only for the steps case', () => {
    const shared = { project: 3, workflow: CI, scenario, assume };
    expect(caseBody(inputs(), 'jobs')).toEqual({ ...shared, detail: 'jobs', format: 'test' });
    expect(caseBody(inputs(), 'steps')).toEqual({ ...shared, detail: 'steps', format: 'test' });
    expect(caseBody(inputs(), 'text')).toEqual({ ...shared, detail: 'jobs', format: 'text' });
    expect(caseBody(inputs(), 'mermaid')).toEqual({ ...shared, detail: 'jobs', format: 'mermaid' });
  });

  it('carries the given of the test file a test case is for, and none with a plan', () => {
    const given = { changed: ['src/a.ts'] };
    expect(caseBody(inputs(), 'jobs', given)).toMatchObject({ format: 'test', given });
    expect(caseBody(inputs(), 'steps', given)).toMatchObject({ format: 'test', given });
    expect(caseBody(inputs(), 'text', given)).not.toHaveProperty('given');
    expect(caseBody(inputs(), 'jobs')).not.toHaveProperty('given');
  });

  it('carries the scenario and the assumptions the store holds now, as they are', () => {
    const now = inputs({ scenario: { event: 'pull_request', base: 'dev' }, assume: [] });
    const body = caseBody(now, 'jobs');
    expect(body?.scenario).toBe(now.scenario);
    expect(body?.assume).toBe(now.assume);
  });

  it('is nothing while a case cannot be asked for', () => {
    expect(caseBody(inputs({ plan: undefined }), 'jobs')).toBeUndefined();
    expect(caseBody(inputs({ focus: undefined }), 'text')).toBeUndefined();
    expect(caseBody(inputs({ focus: CALLEE }), 'steps')).toBeUndefined();
  });
});

describe('what the dialog shows for an answer', () => {
  it('counts the maybe comments of a case, keeps the case to add, and no errors when the worker sent none', () => {
    const generated = { name: 'push main', when: {}, then: {}, allowMaybe: true, comments: ['a', 'b'] };
    expect(outcomeOf({ id: 1, type: 'case', text: 'workflow: ci.yml\n', case: generated })).toEqual({
      type: 'case',
      text: 'workflow: ci.yml\n',
      maybes: 2,
      errors: [],
      case: generated,
    });
    const settled = { name: 'push main', when: {}, then: {}, comments: [] };
    expect(outcomeOf({ id: 1, type: 'case', text: 'x', case: settled })).toEqual({
      type: 'case',
      text: 'x',
      maybes: 0,
      errors: [],
      case: settled,
    });
    // The plan formats have no case.
    expect(outcomeOf({ id: 1, type: 'case', text: 'the plan' })).toEqual({
      type: 'case',
      text: 'the plan',
      maybes: 0,
      errors: [],
    });
  });

  it('names each error of the plan the case was written from by its code and message', () => {
    const generated = { name: 'push main', when: {}, then: {}, comments: [] };
    const errors = [
      { code: 'SC102', message: 'assume[0] matches nothing in this plan' },
      { code: 'SC103', message: 'assume[1] and assume[2] both set outcome of build.t to different values' },
    ];
    expect(outcomeOf({ id: 1, type: 'case', text: 'x', case: generated, errors })).toEqual({
      type: 'case',
      text: 'x',
      maybes: 0,
      case: generated,
      errors: [
        'SC102 assume[0] matches nothing in this plan',
        'SC103 assume[1] and assume[2] both set outcome of build.t to different values',
      ],
    });
  });

  it('counts no maybes for the plan as text or Mermaid, which come without a case', () => {
    expect(outcomeOf({ id: 1, type: 'case', text: 'flowchart LR' })).toEqual({
      type: 'case',
      text: 'flowchart LR',
      maybes: 0,
      errors: [],
    });
  });

  it('names what the worker rejected, with each issue under its path', () => {
    const issues = [
      { path: ['changed', 0, 'status'], message: 'Invalid option' },
      { path: [], message: 'a push has a branch or a tag' },
    ];
    expect(outcomeOf({ id: 1, type: 'invalid', what: 'scenario', issues })).toEqual({
      type: 'failed',
      message: 'the scenario is not valid: changed.0.status: Invalid option; a push has a branch or a tag',
    });
  });

  it('asks to try again after the files were loaded again, and passes an engine error on', () => {
    expect(outcomeOf({ id: 1, type: 'error', kind: 'stale', message: 'project 3 is not loaded' })).toEqual({
      type: 'failed',
      message: 'the files were loaded again; try again',
    });
    expect(outcomeOf({ id: 1, type: 'error', kind: 'engine', message: 'boom', stack: 'at x' })).toEqual({
      type: 'failed',
      message: 'boom',
    });
  });

  it('passes a superseded request on, so the dialog keeps waiting for the newer one', () => {
    expect(outcomeOf({ type: 'superseded' })).toEqual({ type: 'superseded' });
  });
});

/** A client whose `case` answers `result` and records what it was asked. */
function fakeClient(result: CaseResult) {
  const asked: Omit<CaseRequest, 'id' | 'type'>[] = [];
  const client: Pick<EngineClient, 'case'> = {
    case: (body) => {
      asked.push(body);
      return Promise.resolve(result);
    },
  };
  return { client, asked };
}

describe('asking for a case', () => {
  it('sends the request for the format and answers what the dialog shows', async () => {
    const f = fakeClient({ id: 1, type: 'case', text: 'plan' });
    expect(await requestCase(f.client, inputs(), 'text')).toEqual({
      type: 'case',
      text: 'plan',
      maybes: 0,
      errors: [],
    });
    expect(f.asked).toEqual([caseBody(inputs(), 'text')]);
  });

  it('answers why without asking the worker while a case cannot be asked for', async () => {
    const f = fakeClient({ id: 1, type: 'case', text: 'plan' });
    expect(await requestCase(f.client, inputs({ plan: undefined }), 'jobs')).toEqual({
      type: 'failed',
      message: 'no plan yet',
    });
    expect(await requestCase(f.client, inputs({ focus: undefined }), 'jobs')).toEqual({
      type: 'failed',
      message: 'no workflow picked',
    });
    expect(f.asked).toEqual([]);
  });
});

describe('where a case belongs', () => {
  it('keeps the tests directory `simulci test` reads', () => {
    expect(TESTS_DIR).toBe(NODE_TESTS_DIR);
  });

  it('names the test file after the workflow, whatever its extension or folder', () => {
    expect(testFilePath(CI)).toBe('.github/simulci/tests/ci.test.yml');
    expect(testFilePath('.github/workflows/release.yaml')).toBe('.github/simulci/tests/release.test.yml');
    expect(testFilePath('.github/workflows/deep/er/Deploy.YML')).toBe(
      '.github/simulci/tests/Deploy.test.yml',
    );
  });

  it('downloads a case as the test file and the plan as plan.txt or plan.mmd', () => {
    expect(downloadName(CI, 'jobs')).toBe('ci.test.yml');
    expect(downloadName('.github/workflows/release.yaml', 'steps')).toBe('release.test.yml');
    expect(downloadName('.github/workflows/deep/er/Deploy.YML', 'jobs')).toBe('Deploy.test.yml');
    expect(downloadName(CI, 'text')).toBe('plan.txt');
    expect(downloadName(CI, 'mermaid')).toBe('plan.mmd');
  });

  it('names the file and the command that reads it', () => {
    const test = { path: '.github/simulci/tests/release.test.yml', command: 'simulci test' };
    expect(destinationOf('.github/workflows/release.yaml', 'jobs')).toStrictEqual(test);
    expect(destinationOf('.github/workflows/release.yaml', 'steps')).toStrictEqual(test);
    expect(destinationOf('.github/workflows/deep/er/Deploy.YML', 'jobs').path).toBe(
      '.github/simulci/tests/Deploy.test.yml',
    );
    expect(destinationOf(CI, 'text')).toStrictEqual({ command: 'simulci plan' });
    expect(destinationOf(CI, 'mermaid')).toStrictEqual({ command: 'simulci plan --format mermaid' });
  });
});

describe('a case from the starter sample', () => {
  const files = sampleByName('starter')!.files;

  /** The page after the sample loads: its default scenario simulated, as the session does, and a worker to ask. */
  function page() {
    const loaded = handle(initialState(), { id: 1, type: 'load', files });
    if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
    const { project, outline } = loaded.response;
    const d = defaultScenario(outline);
    const simulated = handle(loaded.state, {
      id: 2,
      type: 'simulate',
      project,
      scenario: d.scenario,
      assume: [],
      detail: 'steps',
    });
    if (simulated.response.type !== 'plan') throw new Error(JSON.stringify(simulated.response));
    const { plan, derived, text, ms } = simulated.response;
    const s: Inputs = {
      plan: { plan, derived, text, ms, for: { files: 1, epoch: 1, project, assume: [] } },
      focus: d.focus,
      project: { status: 'ready', version: project },
      scenario: d.scenario,
      assume: [],
    };
    const client: Pick<EngineClient, 'case'> = {
      case: (body) => {
        const { response } = handle(loaded.state, { id: 3, type: 'case', ...body });
        if (response.type === 'case' || response.type === 'invalid' || response.type === 'error')
          return Promise.resolve(response);
        throw new Error(`a ${response.type} answer to a case`);
      },
    };
    return { s, client };
  }

  it.each(['jobs', 'steps'] as const)('writes a %s case that `simulci test` passes', async (format) => {
    const { s, client } = page();
    // The sample's first event with its first literal branch, as the session applies it after the load.
    expect([s.focus, s.scenario]).toEqual([CI, { event: 'push', branch: 'main' }]);
    const outcome = await requestCase(client, s, format);
    if (outcome.type !== 'case') throw new Error(JSON.stringify(outcome));
    const { text } = outcome;
    const file = TestFileSchema.safeParse(parse(text));
    expect(file.error).toBeUndefined();
    expect(file.data?.workflow).toBe('ci.yml');
    // Only the steps case asserts each step's verdict.
    expect(Object.hasOwn(file.data?.cases[0]?.then ?? {}, 'units')).toBe(format === 'steps');
    expect(text).toContain('# ci.yml: maybe — scenario.changed → pin:');
    expect(text).toContain('allowMaybe: true');
    expect(outcome.maybes).toBeGreaterThan(0);
    expect(outcome.errors).toEqual([]);
    // What `simulci test` runs (packages/cli/src/test.ts) over the sample with the case saved where it belongs.
    const result = runTests(loadFiles(files), [{ path: testFilePath(CI), text }], { ci: true });
    expect(result.files.flatMap((f) => [...f.failures, ...f.cases.flatMap((c) => c.failures)])).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it('writes the plan as text, as the page shows it, and as a Mermaid flowchart', async () => {
    const { s, client } = page();
    expect(await requestCase(client, s, 'text')).toEqual({
      type: 'case',
      text: s.plan?.text,
      maybes: 0,
      errors: [],
    });
    expect(await requestCase(client, s, 'mermaid')).toEqual({
      type: 'case',
      text: expect.stringMatching(/^flowchart LR\n/),
      maybes: 0,
      errors: [],
    });
  });

  it('warns of an assumption that matches nothing, which `simulci test` reports invalid', async () => {
    const { s, client } = page();
    const stray: AssumeEntry[] = [{ step: 'build.nope', outputs: { x: '1' } }];
    const outcome = await requestCase(client, { ...s, assume: stray }, 'jobs');
    if (outcome.type !== 'case') throw new Error(JSON.stringify(outcome));
    expect(outcome.errors).toEqual(['SC102 assume[0] matches nothing in this plan']);
    // The case carries the entry as written, and the runner refuses it for the same reason.
    expect(outcome.text).toContain('step: build.nope');
    const result = runTests(loadFiles(files), [{ path: testFilePath(CI), text: outcome.text }], { ci: true });
    expect(result.files.flatMap((f) => f.cases.map((c) => c.status))).toEqual(['invalid']);
    expect(result.files.flatMap((f) => f.cases.flatMap((c) => c.failures.map((x) => x.headline)))).toEqual(
      outcome.errors,
    );
    expect(result.exitCode).toBe(2);
  });
});
