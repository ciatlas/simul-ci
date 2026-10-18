import {
  loadFiles,
  mergeScenario,
  runCase,
  runTests,
  type Snapshot,
  type SnapshotStore,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const ci = `
name: CI
on:
  push:
    branches: [main]
    paths: ['src/**']
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"
      - id: t
        run: npm test
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    env:
      TARGET: prod
    steps:
      - id: d
        run: ./deploy "\${{ needs.build.outputs.version }}"
        env:
          DRY: 'false'
  notify:
    needs: build
    if: vars.NOTIFY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: echo notify }]
`;
const project = loadFiles({ '.github/workflows/ci.yml': ci });
const run = (text: string, options = {}) => runTests(project, [{ path: 't.test.yml', text }], options);
const headlines = (text: string, options = {}) => {
  const r = run(text, options);
  return r.files.flatMap((f) =>
    f.failures.map((x) => x.headline).concat(f.cases.flatMap((c) => c.failures.map((x) => x.headline))),
  );
};

const passing = `
workflow: ci.yml
given: { event: push, branch: main, changed: [src/a.ts] }
cases:
  - name: a main push deploys
    when: {}
    then:
      triggered: true
      run: [build, deploy, build.v]
      skip:
        - notify: if
      conclusion: success
      checks: [build, deploy, notify]
      unknowns: []
      units:
        build: { result: success, check: build, outputs: { version: 1.2.3 }, conclusion: success }
        build.v: { outputs: { version: '1.2.3' }, outcome: success, runs: yes }
        deploy: { environment: production, env: { TARGET: prod } }
        deploy.d: { env: { TARGET: prod, DRY: 'false' }, runs: true }
        notify: { runs: no, because: if, result: skipped, check: notify }
  - name: a docs-only push starts nothing
    when: { changed: [docs/x.md] }
    then:
      because: paths
      skip: [build, deploy.d]
      units: { build: { runs: no, because: parent } }
  - name: notify on
    when: { vars: { NOTIFY: 'true' } }
    then: { run: [notify], checks: { notify: success, build: success, deploy: success } }
`;

describe('runTests: a passing file', () => {
  it('passes every assertion kind and exits 0', () => {
    const result = run(passing);
    expect(result.files[0]!.cases.map((c) => [c.name, c.status, c.failures.map((f) => f.headline)])).toEqual([
      ['a main push deploys', 'passed', []],
      ['a docs-only push starts nothing', 'passed', []],
      ['notify on', 'passed', []],
    ]);
    expect(result.summary).toEqual({ passed: 3, failed: 0, invalid: 0, skipped: 0 });
    expect(result.exitCode).toBe(0);
  });

  it('runs one case for the app without positions', () => {
    const result = runCase(
      project,
      { workflow: 'ci.yml', given: { event: 'push', branch: 'main', changed: ['src/a.ts'] } },
      { name: 'one', when: {}, then: { run: ['deploy'] } },
    );
    expect(result.status).toBe('passed');
    expect(result.plan?.schemaVersion).toBe(1);
  });
});

describe('runTests: failures say what was expected and what the plan holds', () => {
  it('names the unit, the claim and the actual, with the chain under a verdict', () => {
    const result = run(`
workflow: ci.yml
given: { event: push, branch: main, changed: [src/a.ts] }
cases:
  - name: wrong
    when: { vars: { NOTIFY: 'true' } }
    then:
      run: [build]
      skip: [notify]
      conclusion: failure
      checks: [build, deploy]
      unknowns: [build.t.outputs.x]
      units:
        build: { outcome: success }
        build.v: { outputs: { version: '9.9.9' } }
        deploy: { environment: staging, with: { x: 1 } }
        deploy.d: { env: { MISSING: x } }
        notify: { because: if }
`);
    const c = result.files[0]!.cases[0]!;
    expect(c.failures.map((f) => `${f.status} ${f.code ?? ''} ${f.headline}`.replace(/\s+/g, ' '))).toEqual([
      'failed skip[0]: expected notify to skip; it runs',
      "failed conclusion: expected the run of ci.yml to conclude 'failure'; it is 'success'",
      "failed checks: expected ci.yml to report 'build', 'deploy'; it reports 'build', 'deploy', 'notify'",
      "failed unknowns: expected 'build.t.outputs.x'; the plan has (none)",
      'invalid T206 units.build.outcome: outcome is not a field of a job; a job or leg has conclusion (its check run) and result (what needs.<id>.result reads)',
      "failed units.build.v.outputs.version: expected build[v] to output '9.9.9'; it is '1.2.3'".replace(
        'build[v]',
        'build.v',
      ),
      'invalid T206 units.deploy.with: with belongs to a step or to a job that calls a reusable workflow',
      "failed units.deploy.environment: expected deploy to target 'staging'; it is 'production'",
      "failed units.deploy.d.env.MISSING: expected env at deploy.d to have 'x'; it is '' (not set)",
      "failed units.notify.because: notify runs; nothing decided against it, so there is no reason to compare with 'if'",
    ]);
    const skip = c.failures[0]!;
    expect(skip.detail).toEqual([
      '  parent yes (ci.yml)',
      "→ if: vars.NOTIFY == 'true' → true",
      '    ← vars.NOTIFY = true',
      expect.stringMatching(/^ {4}at \.github\/workflows\/ci\.yml:\d+:\d+$/),
    ]);
    expect(skip.at).toEqual({ line: 9, col: 14 });
    expect(skip.workflowLoc).toMatchObject({ file: '.github/workflows/ci.yml' });
    expect(c.failures[1]!.detail).toEqual(['jobs: build success · deploy success · notify success']);
    expect(c.failures[2]!.detail).toEqual(['missing: (none)', "unexpected: 'notify'"]);
    expect(result.exitCode).toBe(2);
  });

  it('treats a unit under a skipped or untriggered parent as unexpanded, and a typo below it as an error', () => {
    const lines = headlines(`
workflow: ci.yml
given: { event: push, branch: main }
cases:
  - name: untriggered
    when: { changed: [docs/x.md] }
    then:
      run: [build]
      maybe: [deploy.d]
      skip: [deploy.d, nope, build.z]
      units: { build: { outputs: { version: '' } }, deploy: { runs: no }, notify: { runs: no, because: parent } }
`);
    expect(lines).toEqual([
      'run[0]: expected build to run; it is not planned',
      "skip[1]: no job 'nope' in ci.yml (jobs: build, deploy, notify)",
      "skip[2]: no step 'z' in 'build' (2 steps)",
      'maybe[0]: expected deploy.d to maybe run; it is not planned',
      'units.build: expected build to run; it is not planned',
    ]);
    const detail = run(`
workflow: ci.yml
cases:
  - name: untriggered
    when: { event: push, branch: main, changed: [docs/x.md] }
    then: { run: [build] }
`).files[0]!.cases[0]!.failures[0]!.detail;
    expect(detail).toEqual(["ci.yml is not triggered, so 'build' is not in the plan"]);
  });

  it('explains a maybe with its unknowns and pins, and accepts it under allowMaybe with a note', () => {
    const text = (extra: string) => `
workflow: ci.yml
given: { event: push, branch: main }
cases:
  - name: no changed files
    when: {}
    ${extra}
    then: { triggered: true, run: [build] }
`;
    const strict = run(text(''));
    const f = strict.files[0]!.cases[0]!.failures;
    expect(f.map((x) => x.headline)).toEqual([
      'triggered: expected ci.yml to be triggered; it may be (maybe)',
      'run[0]: expected build to run; it may run (maybe)',
    ]);
    expect(f[0]!.detail).toEqual([
      '  on: push',
      '  branches [main] ← main: true',
      '→ paths [src/**] ← ? (scenario.changed): ? (scenario.changed)',
      '? scenario.changed · pin: scenario: {"changed":["src/**"]}',
      'a maybe fails this assertion; pin the unknown, or set allowMaybe: true to accept it',
    ]);
    expect(strict.exitCode).toBe(1);
    const relaxed = run(text('allowMaybe: true'));
    expect(relaxed.files[0]!.cases[0]!.status).toBe('passed');
    expect(relaxed.files[0]!.cases[0]!.notes).toEqual([
      'triggered: ci.yml may be triggered, accepted (allowMaybe)',
      'run[0]: build is maybe, accepted (allowMaybe)',
    ]);
    expect(run(text('allowMaybe: true'), { strict: true }).exitCode).toBe(1);
  });
});

describe('runTests: invalid files', () => {
  it('reports schema problems with codes, positions and did-you-mean', () => {
    const result = run(`
workflow: ci.yml
cases:
  - name: a
    when: { event: push, brnach: main }
    then: { run: [build] }
  - name: a
    when: { event: push }
    then: { because: path-filter }
  - name: b
    when: { event: push }
  - name: c
    when: { event: push }
    then: { runs: yes }
  - name: d
    when: { event: push }
    then: { run: ['bad path!'] }
`);
    const file = result.files[0]!;
    expect(file.status).toBe('invalid');
    expect(file.failures.map((f) => `${f.headline} @${f.at.line}:${f.at.col}`).sort()).toEqual(
      [
        "T002 cases.0.when.brnach: unknown key; did you mean 'branch'? @5:26",
        "T002 cases.1.then.because: 'path-filter' is not a reason; one of event, types, schedule, default-branch, skip-ci, parent, if, matrix, limit, filter, branches, branches-ignore, tags, tags-ignore, paths, paths-ignore, workflows @9:22",
        "T002 cases.3.then.runs: unknown key; did you mean 'run'? @14:13",
        'T002 cases.4.then.run.0: a unit path such as deploy, test[os=windows-latest].unit, publish.#2, release/build or build.changes/detect @17:19',
        'T102 cases.2: a case asserts nothing: add then or snapshot: true @10:5',
        "T103 cases.1.name: duplicate case name 'a' (first at cases[0]) @7:5",
      ].sort(),
    );
    expect(result.exitCode).toBe(2);
  });

  it('reports YAML errors, a missing workflow, a bad scenario and mock problems where they are written', () => {
    expect(headlines('workflow: ci.yml\ncases: [\n')[0]).toMatch(/^T001 /);
    const missing = run(
      'workflow: nope.yml\ncases:\n  - { name: x, when: { event: push }, then: { run: [a] } }\n',
    );
    expect(missing.files[0]!.failures[0]!.headline).toBe(
      'T201 workflow: no .github/workflows/nope.yml in the project (workflows: ci.yml)',
    );
    expect(missing.files[0]!.cases.map((c) => c.status)).toEqual(['invalid']);
    expect(
      headlines(
        'workflow: ci.yml\ncases:\n  - { name: x, when: { event: push, branch: main, tag: v1 }, then: { run: [build] } }\n',
      )[0],
    ).toMatch(/^T202 cases\.0\.when: /);
    const mocks = run(`
workflow: ci.yml
given: { event: push, branch: main, changed: [src/a.ts] }
cases:
  - name: x
    when:
      assume:
        - { step: build.v, outputs: { nope: '1' } }
    then: { run: [build] }
`);
    const f = mocks.files[0]!.cases[0]!.failures[0]!;
    expect(f.code).toBe('SC101');
    expect(f.headline).toMatch(/^SC101 assume\[0\] sets output 'nope'/);
    expect(f.at).toEqual({ line: 8, col: 11 });
    expect(mocks.exitCode).toBe(2);
    expect(runTests(project, []).files[0]!.failures[0]!.headline).toBe(
      'T000 no test files: expected .github/simulci/tests/**/*.test.yml',
    );
  });

  it('runs only the only cases, rejects only under ci, honours skip and filter', () => {
    const text = `
workflow: ci.yml
given: { event: push, branch: main, changed: [src/a.ts] }
cases:
  - { name: one, when: {}, then: { run: [build] }, only: true }
  - { name: two, when: {}, then: { run: [build] } }
  - { name: three, when: {}, then: { run: [build] }, skip: flaky }
`;
    const local = run(text);
    expect(local.files[0]!.cases.map((c) => [c.status, c.reason])).toEqual([
      ['passed', undefined],
      ['skipped', 'only elsewhere'],
      ['skipped', 'flaky'],
    ]);
    const underCi = run(text, { ci: true });
    expect(underCi.files[0]!.failures[0]!.headline).toBe(
      'T104 only left in a test file (CI=true runs every case)',
    );
    expect(underCi.files[0]!.cases.map((c) => c.status)).toEqual(['passed', 'passed', 'skipped']);
    expect(underCi.exitCode).toBe(2);
    expect(
      run(text.replace(', only: true', ''), { filter: 'tw' }).files[0]!.cases.map((c) => c.reason),
    ).toEqual(['filter', undefined, 'flaky']);
  });
});

describe('mergeScenario', () => {
  it('merges records, replaces the ref group whole, keeps the rest of given', () => {
    expect(
      mergeScenario(
        { event: 'push', branch: 'main', inputs: { a: 1 }, vars: { X: '1' }, changed: ['a'] },
        { tag: 'v1', inputs: { b: 2 }, changed: ['b'] },
      ),
    ).toEqual({ event: 'push', tag: 'v1', inputs: { a: 1, b: 2 }, vars: { X: '1' }, changed: ['b'] });
  });
});

describe('snapshots', () => {
  const memory = (): SnapshotStore & { files: Map<string, Snapshot> } => {
    const files = new Map<string, Snapshot>();
    return { files, read: (p) => files.get(p), write: (p, s) => files.set(p, s) };
  };
  const text = `
workflow: ci.yml
given: { event: push, branch: main, changed: [src/a.ts] }
cases:
  - { name: snap, when: {}, snapshot: true }
`;

  it('writes a missing snapshot locally, compares on the next run, and fails on a change or under ci', () => {
    const store = memory();
    const first = run(text, { snapshots: store });
    expect(first.files[0]!.cases[0]!.notes).toEqual(['snapshot written']);
    expect(first.exitCode).toBe(0);
    const stored = store.files.get('t.test.yml')!;
    expect(Object.keys(stored.cases)).toEqual(['snap']);
    expect(JSON.stringify(stored)).not.toContain('"loc"');
    expect(run(text, { snapshots: store }).files[0]!.cases[0]!.notes).toEqual([]);
    const changed = runTests(
      loadFiles({
        '.github/workflows/ci.yml': ci.replace("if: github.ref == 'refs/heads/main'", 'if: false'),
      }),
      [{ path: 't.test.yml', text }],
      { snapshots: store },
    );
    const f = changed.files[0]!.cases[0]!.failures[0]!;
    expect(f.headline).toMatch(
      /^snapshot: the plan of 'snap' changed, \+\d+\/-\d+ lines \(run simulci test -u to accept\)$/,
    );
    expect(f.detail.some((l) => l.startsWith('- ') || l.startsWith('+ '))).toBe(true);
    expect(changed.exitCode).toBe(1);
    const inCi = run(text, { snapshots: memory(), ci: true });
    expect(inCi.files[0]!.cases[0]!.failures[0]!.headline).toBe(
      "snapshot: no snapshot for 'snap' (CI=true never writes one; run simulci test -u and commit it)",
    );
    expect(inCi.exitCode).toBe(1);
    expect(headlines(text)[0]).toBe('T207 cases.0.snapshot: this host has no snapshot store');
  });

  it('updates and prunes with update, and warns about obsolete entries', () => {
    const store = memory();
    store.files.set('t.test.yml', { schemaVersion: 1, cases: { old: {}, snap: {} } });
    const warned = run(text, { snapshots: store });
    expect(warned.files[0]!.notes).toEqual(['obsolete snapshot "old" (no such case; -u removes it)']);
    expect(warned.files[0]!.cases[0]!.status).toBe('failed');
    expect(run(text, { snapshots: store, strict: true }).files[0]!.failures[0]!.headline).toBe(
      'snapshot: obsolete snapshot "old" (no such case; -u removes it)',
    );
    const updated = run(text, { snapshots: store, update: true });
    expect(updated.files[0]!.cases[0]!.notes).toEqual(['snapshot updated']);
    expect(Object.keys(store.files.get('t.test.yml')!.cases)).toEqual(['snap']);
    expect(updated.exitCode).toBe(0);
  });
});
