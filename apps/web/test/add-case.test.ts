import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CaseJson, planOp, WorkflowDocument } from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import { loadFiles, runTests, type ScenarioInput } from '@simulci/engine';
import { discoverTests, readWorkflowFiles } from '@simulci/node';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { handle, initialState, type WorkerState } from '../src/worker/handle';

/**
 * `addCase` over this repository's own route tests: for each test file, the worker writes a case as it writes one for
 * the case dialog (its `case` request over the repository's workflows, for the scenario of the file's first case, under
 * the file's `given`), the op appends it, and a golden keeps what it inserted, read by eye once. The file reads back
 * with its cases as they were and the new one last, and `simulci test` passes every case of it, the new one included.
 * And why the case is planned under the file's `given`: without it, a case can fail in its own file.
 */

const ROOT = join(import.meta.dirname, '../../..');
const files = readWorkflowFiles(ROOT);
const tests = discoverTests(ROOT);

interface TestFileJs {
  workflow: string;
  given?: unknown;
  cases: { name: string; when: ScenarioInput & { assume?: unknown[] } }[];
}

function loaded(texts: Record<string, string>): WorkerState {
  const r = handle(initialState(), { id: 1, type: 'load', files: texts });
  if (r.response.type !== 'loaded') throw new Error(JSON.stringify(r.response));
  return r.state;
}

/** The case the worker writes for the dialog: the workflow's, for a scenario and its mocks, under a `given`. */
function generated(
  state: WorkerState,
  workflow: string,
  when: TestFileJs['cases'][number]['when'],
  given?: unknown,
): CaseJson {
  const { assume = [], ...scenario } = when;
  const r = handle(state, {
    id: 2,
    type: 'case',
    project: state.project!.version,
    workflow: `.github/workflows/${workflow}`,
    scenario,
    assume: assume as never,
    detail: 'jobs',
    format: 'test',
    name: 'added from the page',
    ...(given === undefined ? {} : { given }),
  });
  if (r.response.type !== 'case' || !r.response.case) throw new Error(JSON.stringify(r.response));
  return r.response.case;
}

/** The text after `addCase` of the case, and what the op inserted. */
function added(path: string, text: string, workflow: string, testCase: CaseJson) {
  const doc = WorkflowDocument.open(text, { path, kind: 'test' });
  const result = planOp(
    { op: 'addCase', file: path, workflow: `.github/workflows/${workflow}`, testCase },
    { doc: (p) => (p === path ? doc : undefined) },
  );
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  const edits = result.value[path]!;
  return { text: applyEdits(text, edits).text, inserted: edits.map((e) => e.insert).join('') };
}

/** Each case of a test file run as `simulci test --ci` runs it: its name, status and failures. */
function run(texts: Record<string, string>, path: string, text: string) {
  const result = runTests(loadFiles(texts), [{ path, text }], { ci: true });
  expect(result.files[0]!.failures).toEqual([]);
  return result.files[0]!.cases.map((c) => [c.name, c.status, c.failures.map((f) => f.headline)]);
}

describe('addCase on this repository’s own route tests', () => {
  const state = loaded(files);

  it('finds them', () => {
    expect(tests.length).toBeGreaterThan(3);
  });

  it.each(tests)('%s', async (path) => {
    const text = readFileSync(join(ROOT, path), 'utf8');
    const spec = parse(text) as TestFileJs;
    const testCase = generated(state, spec.workflow, spec.cases[0]!.when, spec.given);
    const out = added(path, text, spec.workflow, testCase);
    const name = path.replace(/^.*\//, '').replace(/\.test\.ya?ml$/, '');
    await expect(out.inserted).toMatchFileSnapshot(`golden/add-case/${name}.yml`);
    // Every byte before the new case is the file's, and the cases read back as they were, the new one last.
    expect(out.text.startsWith(text.replace(/\n$/, ''))).toBe(true);
    const after = parse(out.text) as TestFileJs;
    expect(after.cases.slice(0, -1)).toEqual(spec.cases);
    expect(after.cases.at(-1)!.name).toBe('added from the page');
    expect(run(files, path, out.text)).toContainEqual(['added from the page', 'passed', []]);
  });
});

describe('a case for a test file with a given', () => {
  const CI = '.github/workflows/ci.yml';
  const TEST = '.github/simulci/tests/ci.test.yml';
  const texts = {
    [CI]: 'on:\n  push:\n    paths: [src/**]\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: a }]\n',
  };
  const file =
    'workflow: ci.yml\ngiven: { changed: [docs/a.md] }\ncases:\n  - { name: docs, when: { event: push }, then: { because: paths } }\n';
  const state = loaded(texts);
  const push = { event: 'push', branch: 'main' } as const;

  it('is planned under it, so it passes where simulci test runs it, its when still the scenario on screen', () => {
    const testCase = generated(state, 'ci.yml', push, { changed: ['docs/a.md'] });
    expect(testCase.when).toEqual(push);
    expect(testCase.then).toEqual({ triggered: false, because: 'paths' });
    const out = added(TEST, file, 'ci.yml', testCase);
    expect(run(texts, TEST, out.text)).toEqual([
      ['docs', 'passed', []],
      ['added from the page', 'passed', []],
    ]);
  });

  it('would fail there, planned without it', () => {
    const out = added(TEST, file, 'ci.yml', generated(state, 'ci.yml', push));
    expect(run(texts, TEST, out.text).at(-1)!.slice(0, 2)).toEqual(['added from the page', 'failed']);
  });

  it('plans with its mocks beneath the case’s, and plans without a given the schema refuses', () => {
    const mocked = loaded({
      [CI]: [
        'on: push',
        'jobs:',
        '  build:',
        '    runs-on: x',
        '    outputs:',
        '      v: ${{ steps.v.outputs.v }}',
        '    steps: [{ id: v, run: a }]',
        '  ship:',
        '    needs: build',
        "    if: needs.build.outputs.v == '1'",
        '    runs-on: x',
        '    steps: [{ run: b }]',
        '',
      ].join('\n'),
    });
    const given = { assume: [{ step: 'build.v', outputs: { v: '1' } }] };
    expect(generated(mocked, 'ci.yml', { event: 'push' }, given).then).toMatchObject({
      run: ['build', 'ship'],
    });
    expect(generated(mocked, 'ci.yml', { event: 'push' }, { nope: true }).then).toMatchObject({
      run: ['build'],
      maybe: ['ship'],
    });
  });
});
