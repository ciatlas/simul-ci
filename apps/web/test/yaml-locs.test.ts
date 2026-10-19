import type { ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import { handle, initialState } from '../src/worker/handle';
import type { Outline, PlanResponse } from '../src/worker/protocol';
import {
  decidingLines,
  fileTabs,
  gutterMarks,
  lineNodes,
  problemLines,
  representativeLeg,
  shownFile,
} from '../src/yaml/locs';

/** The worker's answers for one repository under one scenario: the outline, the plan and its tables. */
function simulated(
  files: Record<string, string>,
  scenario: ScenarioInput,
): PlanResponse & { outline: Outline } {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  return { ...step.response, outline: loaded.response.outline };
}

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const SETUP = '.github/actions/setup/action.yml';
const PACKAGE = '.github/workflows/package.yml';
const starter = sampleByName('starter')!.files;
const monorepo = sampleByName('monorepo')!.files;

// A push to main that touches the sources triggers CI (not Release); without changed files the paths filter decides.
const main = simulated(starter, { event: 'push', branch: 'main', changed: ['src/a.ts'] });
const mainUnknownPaths = simulated(starter, { event: 'push', branch: 'main' });
const labeled = simulated(starter, {
  event: 'pull_request',
  base: 'main',
  head: 'topic',
  number: 1,
  action: 'labeled',
  changed: ['src/a.ts'],
});
const tag = simulated(starter, { event: 'push', tag: 'v1.0.0' });

const rows = (marks: ReturnType<typeof gutterMarks>) =>
  marks.map((m) => [m.line, m.node.slice(m.node.indexOf('#') + 1) || m.node, m.verdict, m.kind]);

describe('the verdict gutter', () => {
  it('marks the on: line, every job and the steps of the first leg of a workflow, with their verdicts', () => {
    expect(rows(gutterMarks(main.plan, main.outline, CI, {}))).toEqual([
      [2, CI, 'yes', 'workflow'],
      [16, 'test', 'yes', 'job'],
      [23, 'test[node=22]/~actions-checkout', 'yes', 'step'],
      [24, 'test[node=22]/~actions-setup-node', 'yes', 'step'],
      [27, 'test[node=22]/~npm-ci', 'yes', 'step'],
      [28, 'test[node=22]/~npm-test', 'yes', 'step'],
      [30, 'build', 'yes', 'job'],
      [34, 'build/~actions-checkout', 'yes', 'step'],
      [35, 'build/steps.detect', 'yes', 'step'],
      [38, 'build/~npm-run-build', 'maybe', 'step'],
      [41, 'deploy', 'yes', 'job'],
      [47, 'deploy/~deploy-sh', 'yes', 'step'],
      // A skipped job has no steps to mark.
      [51, 'preview', 'no', 'job'],
    ]);
  });

  it('marks an untriggered workflow on its on: line alone', () => {
    expect(rows(gutterMarks(main.plan, main.outline, RELEASE, {}))).toEqual([[2, RELEASE, 'no', 'workflow']]);
  });

  it('takes a matrix job’s steps from the leg the author picked, while the plan still has it', () => {
    const test = `${CI}#test`;
    const marks = gutterMarks(main.plan, main.outline, CI, { [test]: `${test}[node=24]` });
    expect(lineNodes(marks).get(23)).toBe(`${test}[node=24]/~actions-checkout`);
    expect(lineNodes(marks).get(16)).toBe(test);
    const gone = gutterMarks(main.plan, main.outline, CI, { [test]: `${test}[node=20]` });
    expect(lineNodes(gone).get(23)).toBe(`${test}[node=22]/~actions-checkout`);
    const job = main.plan.workflows[0]!.jobs[0]!;
    expect(representativeLeg(job, {})?.id).toBe(`${test}[node=22]`);
    expect(representativeLeg({ ...job, legs: [] }, {})).toBeUndefined();
  });

  it('marks a composite action’s steps in its action.yml from the first step that uses it', () => {
    const action = `${RELEASE}#publish/~github-actions-setup>.github/actions/setup`;
    expect(gutterMarks(tag.plan, tag.outline, SETUP, {})).toEqual([
      { line: 6, node: `${action}/~actions-setup-node`, verdict: 'yes', kind: 'step' },
      { line: 9, node: `${action}/steps.cache`, verdict: 'yes', kind: 'step' },
      { line: 14, node: `${action}/~npm-ci`, verdict: 'maybe', kind: 'step' },
    ]);
    // The step that uses it is marked in the workflow.
    expect(lineNodes(gutterMarks(tag.plan, tag.outline, RELEASE, {})).get(14)).toBe(
      `${RELEASE}#publish/~github-actions-setup`,
    );
    // Nothing uses it when Release is not triggered.
    expect(gutterMarks(main.plan, main.outline, SETUP, {})).toEqual([]);
  });

  it('marks a called workflow’s jobs from the first leg that calls it, its on: line by its own trigger', () => {
    const push = simulated(monorepo, { event: 'push', branch: 'main' });
    const web = `${CI}#web>${PACKAGE}`;
    expect(gutterMarks(push.plan, push.outline, PACKAGE, {})).toEqual([
      { line: 2, node: PACKAGE, verdict: 'no', kind: 'workflow' },
      { line: 10, node: `${web}#test`, verdict: 'maybe', kind: 'job' },
      { line: 13, node: `${web}#test/~actions-checkout`, verdict: 'maybe', kind: 'step' },
      { line: 14, node: `${web}#test/~npm-test-workspace-apps-inputs-name`, verdict: 'maybe', kind: 'step' },
      { line: 15, node: `${web}#lint`, verdict: 'maybe', kind: 'job' },
      {
        line: 19,
        node: `${web}#lint/~npm-run-lint-workspace-apps-inputs-name`,
        verdict: 'maybe',
        kind: 'step',
      },
    ]);
  });

  it('marks nothing in a file the plan does not reach, and only the on: lines the outline knows', () => {
    expect(gutterMarks(main.plan, main.outline, 'README.md', {})).toEqual([]);
    expect(gutterMarks(main.plan, undefined, CI, {})[0]).toMatchObject({ line: 16, kind: 'job' });
  });
});

describe('the deciding line', () => {
  it('is a job’s if:, with its own line beside it', () => {
    expect(decidingLines(main.plan, main.derived, `${CI}#deploy`, CI)).toEqual({
      line: 43,
      tone: 'yes',
      own: 41,
    });
    expect(decidingLines(main.plan, main.derived, `${CI}#preview`, CI)).toEqual({
      line: 53,
      tone: 'no',
      own: 51,
    });
    expect(decidingLines(main.plan, main.derived, `${CI}#build/~npm-run-build`, CI)).toEqual({
      line: 39,
      tone: 'maybe',
      own: 38,
    });
  });

  it('is the job’s if: for a step its job decides, and the on: filter for a step its workflow decides', () => {
    const step = `${CI}#preview/~preview-sh`;
    expect(labeled.plan.workflows[0]!.jobs.find((j) => j.jobId === 'preview')!.runs.verdict).toBe('maybe');
    expect(decidingLines(labeled.plan, labeled.derived, step, CI)).toEqual({
      line: 53,
      tone: 'maybe',
      own: 56,
    });
    const test = `${CI}#test[node=22]/~npm-test`;
    expect(decidingLines(mainUnknownPaths.plan, mainUnknownPaths.derived, test, CI)).toEqual({
      line: 5,
      tone: 'maybe',
      own: 28,
    });
  });

  it('is the on: filter that left a workflow untriggered, with no own line', () => {
    expect(decidingLines(main.plan, main.derived, RELEASE, RELEASE)).toEqual({ line: 4, tone: 'no' });
    expect(decidingLines(main.plan, main.derived, CI, CI)).toEqual({ line: 5, tone: 'yes' });
  });

  it('keeps a node’s own line in a file that did not decide it, and is nothing in a file that holds neither', () => {
    const inner = `${RELEASE}#publish/~github-actions-setup>.github/actions/setup/~npm-ci`;
    expect(decidingLines(tag.plan, tag.derived, inner, SETUP)).toEqual({ line: 15, tone: 'maybe', own: 14 });
    const step = `${RELEASE}#publish/~actions-checkout`;
    expect(decidingLines(tag.plan, tag.derived, step, RELEASE)).toEqual({ line: 13, tone: 'yes' });
    const job = `${RELEASE}#publish`;
    expect(decidingLines(tag.plan, tag.derived, `${job}/~npm-publish-provenance`, SETUP)).toBeUndefined();
    expect(
      decidingLines(labeled.plan, labeled.derived, `${CI}#preview/~preview-sh`, RELEASE),
    ).toBeUndefined();
    const ownOnly = {
      ...tag.derived,
      decidingLoc: { ...tag.derived.decidingLoc, [job]: { file: CI, line: 1, column: 1 } },
    };
    expect(decidingLines(tag.plan, ownOnly, job, RELEASE)).toEqual({ tone: 'yes', own: 9 });
    expect(decidingLines(tag.plan, tag.derived, undefined, RELEASE)).toBeUndefined();
    expect(decidingLines(tag.plan, tag.derived, `${RELEASE}#gone`, RELEASE)).toBeUndefined();
  });
});

describe('problem lines', () => {
  const broken = simulated(
    {
      '.github/workflows/a.yml': 'on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: echo }]\n',
      '.github/workflows/b.yml': 'on: push\njobs:\n  b: [\n',
    },
    { event: 'push' },
  );

  it('are the lines the parser refused, with its message', () => {
    expect(problemLines(broken.outline, '.github/workflows/b.yml')).toEqual([
      { line: 4, message: expect.stringContaining('Flow sequence') },
    ]);
    expect(problemLines(broken.outline, '.github/workflows/a.yml')).toEqual([]);
    expect(problemLines(undefined, '.github/workflows/b.yml')).toEqual([]);
  });

  it('join the messages about one line, in line order', () => {
    const outline: Outline = {
      files: [
        {
          path: 'x.yml',
          kind: 'other',
          errors: [
            { line: 7, column: 1, message: 'second' },
            { line: 3, column: 2, message: 'one' },
            { line: 7, column: 4, message: 'two' },
          ],
        },
      ],
      workflows: [],
      events: {},
    };
    expect(problemLines(outline, 'x.yml')).toEqual([
      { line: 3, message: 'one' },
      { line: 7, message: 'second\ntwo' },
    ]);
  });
});

describe('the tabs', () => {
  it('list every loaded file, workflows then actions then the rest, each by path, with its problems', () => {
    const files = { ...starter, 'notes.yml': 'a: [', '.github/workflows/b.yml': 'on: push\njobs:\n  b: [\n' };
    const { outline } = simulated(files, { event: 'push' });
    expect(fileTabs(outline, files)).toEqual([
      { path: '.github/workflows/b.yml', kind: 'workflow', label: 'b.yml', problems: 1 },
      { path: CI, kind: 'workflow', label: 'ci.yml', problems: 0 },
      { path: RELEASE, kind: 'workflow', label: 'release.yml', problems: 0 },
      { path: SETUP, kind: 'action', label: 'action.yml', problems: 0 },
      { path: 'notes.yml', kind: 'other', label: 'notes.yml', problems: 0 },
    ]);
  });

  it('name each file by as much of its path as tells it apart, and sort by the path until the outline comes', () => {
    const files = {
      '.github/actions/b/action.yml': '',
      '.github/actions/a/action.yml': '',
      '.github/actions/c/action.yaml': '',
      'deploy/ci.yml': '',
      '.github/workflows/ci.yml': '',
      'ci.yml': '',
    };
    expect(fileTabs(undefined, files).map((t) => [t.label, t.kind])).toEqual([
      ['workflows/ci.yml', 'workflow'],
      ['a/action.yml', 'action'],
      ['b/action.yml', 'action'],
      ['action.yaml', 'action'],
      ['ci.yml', 'other'],
      ['deploy/ci.yml', 'other'],
    ]);
  });
});

describe('the file the pane shows', () => {
  const tabs = fileTabs(tag.outline, starter);
  const inner = `${RELEASE}#publish/~github-actions-setup>.github/actions/setup/~npm-ci`;

  it('is the author’s pick while it is loaded', () => {
    expect(shownFile({ tabs, picked: SETUP, plan: main, node: `${CI}#deploy`, focus: CI })).toBe(SETUP);
    expect(shownFile({ tabs, picked: 'gone.yml', plan: main, node: `${CI}#deploy`, focus: CI })).toBe(CI);
  });

  it('is else the file that decided the selection, then the file it is declared in', () => {
    expect(shownFile({ tabs, plan: tag, node: inner, focus: RELEASE })).toBe(SETUP);
    const elsewhere = {
      ...tag.derived,
      decidingLoc: { ...tag.derived.decidingLoc, [inner]: { file: 'x', line: 1, column: 1 } },
    };
    expect(shownFile({ tabs, plan: { plan: tag.plan, derived: elsewhere }, node: inner, focus: CI })).toBe(
      SETUP,
    );
  });

  it('is else the focused workflow, else the first tab', () => {
    expect(shownFile({ tabs, plan: tag, node: `${RELEASE}#gone`, focus: RELEASE })).toBe(RELEASE);
    expect(shownFile({ tabs, focus: RELEASE })).toBe(RELEASE);
    expect(shownFile({ tabs })).toBe(CI);
    expect(shownFile({ tabs: [] })).toBeUndefined();
  });
});
