import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFiles, runTests } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { AssumeError, parseAssume } from '../src/assume';
import { planOutput } from '../src/plan';
import { renderAnnotations, renderJUnit, renderTextReport } from '../src/report';
import { runTestCommand, snapshotPath, type TestIo } from '../src/test';

const ci = `
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: t
        run: npm test
  deploy:
    needs: build
    if: vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: ./deploy }]
`;

const tests = `
workflow: ci.yml
given: { event: push, branch: main }
cases:
  - name: main
    when: {}
    then: { run: [build], skip: [deploy] }
  - name: wrong
    when: { vars: { DEPLOY: 'true' } }
    then:
      skip: [deploy]
  - name: snap
    when: {}
    snapshot: true
`;

function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'simulci-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function io(env: Record<string, string> = {}): TestIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => out.push(t), stderr: (t) => err.push(t), env };
}

describe('parseAssume', () => {
  it('reads the shorthands and YAML mappings', () => {
    expect(
      parseAssume([
        'build.t=failure',
        'deploy=failure',
        'build.t.outputs.sha=abc',
        'deploy.#1.env.TARGET=prod',
        'build.c=as:hit',
        '{ uses: actions/cache, as: miss }',
      ]),
    ).toEqual([
      { step: 'build.t', outcome: 'failure' },
      { job: 'deploy', outcome: 'failure' },
      { step: 'build.t', outputs: { sha: 'abc' } },
      { step: 'deploy.#1', env: { TARGET: 'prod' } },
      { step: 'build.c', as: 'hit' },
      { uses: 'actions/cache', as: 'miss' },
    ]);
    expect(parseAssume([], '- { step: a.b, outcome: failure }\n')).toEqual([
      { step: 'a.b', outcome: 'failure' },
    ]);
    expect(() => parseAssume(['nonsense'])).toThrow(AssumeError);
    expect(() => parseAssume(['build.t=maybe'])).toThrow(/invalid assume entries/);
    expect(() => parseAssume([], 'step: x\n')).toThrow(/YAML list/);
  });
});

describe('simulci test', () => {
  it('runs the tests of a checkout, reports, writes a snapshot locally and fails on it under ci', () => {
    const dir = checkout({ '.github/workflows/ci.yml': ci, '.github/simulci/tests/ci.test.yml': tests });
    const local = io();
    expect(runTestCommand({ dir }, local)).toBe(1);
    const text = local.out.join('');
    expect(text).toContain(
      '.github/simulci/tests/ci.test.yml → ci.yml\n  ✓ main\n  ✗ wrong\n      skip[0]: expected deploy to skip; it runs\n',
    );
    expect(text).toContain('        at 11:14\n');
    expect(text).toContain('  ✓ snap\n      · snapshot written\n');
    expect(text).toContain('\n2 passed · 1 failed · 0 invalid · 0 skipped · exit 1\n');
    const snap = JSON.parse(
      readFileSync(join(dir, snapshotPath('.github/simulci/tests/ci.test.yml')), 'utf8'),
    ) as { cases: Record<string, unknown> };
    expect(Object.keys(snap.cases)).toEqual(['snap']);
    expect(snapshotPath('.github/simulci/tests/ci.test.yml')).toBe(
      '.github/simulci/tests/__snapshots__/ci.test.snap.json',
    );

    const again = io({ CI: 'true', GITHUB_ACTIONS: 'true' });
    expect(runTestCommand({ dir, filter: 'snap' }, again)).toBe(0);
    expect(again.out.join('')).toContain('  ✓ snap\n');
    const fresh = checkout({ '.github/workflows/ci.yml': ci, '.github/simulci/tests/ci.test.yml': tests });
    const ciRun = io({ CI: 'true', GITHUB_ACTIONS: 'true' });
    expect(runTestCommand({ dir: fresh, junit: join(fresh, 'out/junit.xml') }, ciRun)).toBe(1);
    const out = ciRun.out.join('');
    expect(out).toContain(
      "snapshot: no snapshot for 'snap' (CI=true never writes one; run simulci test -u and commit it)",
    );
    expect(out).toContain(
      '::error file=.github/simulci/tests/ci.test.yml,line=11,col=14,title=simulci%3A wrong::skip[0]: expected deploy to skip; it runs%0A',
    );
    expect(out).toContain('::notice file=.github/workflows/ci.yml,line=');
    const junit = readFileSync(join(fresh, 'out/junit.xml'), 'utf8');
    expect(junit).toContain('<testsuites name="simulci" tests="3" failures="2" errors="0" skipped="0">');
    expect(junit).toContain('<testcase classname=".github/simulci/tests/ci.test.yml" name="wrong" time="0">');
    expect(junit).toContain('<failure type="assertion" message="skip[0]: expected deploy to skip; it runs">');
  });

  it('refuses test files under .github/workflows, and applies --assume to every case', () => {
    const misplaced = checkout({ '.github/workflows/ci.yml': ci, '.github/workflows/x.test.yml': tests });
    const bad = io();
    expect(
      runTestCommand({ dir: misplaced, files: [join(misplaced, '.github/workflows/x.test.yml')] }, bad),
    ).toBe(2);
    expect(bad.err.join('')).toMatch(/^T000 .*would be run by GitHub/);
    const dir = checkout({
      '.github/workflows/ci.yml': ci,
      '.github/simulci/tests/ci.test.yml':
        'workflow: ci.yml\ncases:\n  - { name: x, when: { event: push, branch: main }, then: { conclusion: failure } }\n',
    });
    expect(runTestCommand({ dir }, io())).toBe(1);
    expect(runTestCommand({ dir, assume: 'build.t=failure' }, io())).toBe(0);
    const none = io();
    expect(runTestCommand({ dir: checkout({ '.github/workflows/ci.yml': ci }) }, none)).toBe(2);
    expect(none.out.join('')).toContain('T000 no test files');
  });
});

describe('reports', () => {
  const project = loadFiles({ '.github/workflows/ci.yml': ci });
  const result = runTests(project, [
    {
      path: 't.test.yml',
      text: 'workflow: ci.yml\ncases:\n  - { name: a, when: { event: push, branch: main }, then: { run: [deploy] } }\n  - { name: b, when: { event: push, branch: main }, then: { run: [nope] } }\n  - { name: c, when: { event: push }, then: { run: [build] }, skip: later }\n',
    },
    { path: 'bad.test.yml', text: 'workflow: ci.yml\ncases: [\n' },
  ]);

  it('renders text, annotations and JUnit from one result', () => {
    const text = renderTextReport(result);
    expect(text).toContain('t.test.yml → ci.yml\n  ✗ a\n      run[0]: expected deploy to run; it skips\n');
    expect(text).toContain("  ! b\n      run[0]: no job 'nope' in ci.yml (jobs: build, deploy)\n");
    expect(text).toContain('  - c (later)\n');
    expect(text).toContain('bad.test.yml\n  T001 ');
    expect(text).toMatch(/\n0 passed · 1 failed · 1 invalid · 1 skipped · exit 2\n$/);
    const annotations = renderAnnotations(result);
    expect(annotations.filter((l) => l.startsWith('::error'))).toHaveLength(3);
    expect(annotations[0]).toMatch(
      /^::error file=t\.test\.yml,line=3,col=\d+,title=simulci%3A a::run\[0\]: expected deploy to run; it skips%0A/,
    );
    const junit = renderJUnit(result);
    expect(junit).toContain('<testsuites name="simulci" tests="4" failures="1" errors="2" skipped="1">');
    expect(junit).toContain('<skipped message="later"/>');
    expect(junit).toMatch(
      /<testcase classname="bad\.test\.yml" name="\(file\)" time="0">\n {6}<error type="T001" message="T001 /,
    );
  });
});

describe('simulci plan --as-test', () => {
  it('prints a test case for the scenario, with the assumptions given', () => {
    const dir = checkout({ '.github/workflows/ci.yml': ci });
    const out = planOutput({
      dir,
      event: 'push',
      branch: 'main',
      format: 'text',
      detail: 'steps',
      asTest: 'steps',
      assume: 'build.t=failure',
    });
    expect(out.code).toBe(0);
    expect(out.text).toBe(`workflow: ci.yml
cases:
  - name: push main with 1 assumption
    when:
      event: push
      branch: main
      assume:
        - step: build.t
          outcome: failure
    then:
      run:
        - build
      skip:
        - deploy
      conclusion: failure
      units:
        build.t:
          runs: yes
`);
    expect(
      planOutput({ dir, event: 'push', branch: 'main', format: 'text', detail: 'steps', assume: 'nonsense' })
        .code,
    ).toBe(2);
  });
});
