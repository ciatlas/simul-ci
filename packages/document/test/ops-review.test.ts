import { describe, expect, it } from 'vitest';
import { WorkflowDocument, type EditPlan, type Fix, type TextEdit } from '@simulci/document';
import { planOp } from '../src/ops/plan';
import { stepIdFor } from '../src/ops/ids';
import { fingerprint } from '../src/ops/steps';
import type { Fp, OpContext, WorkflowOp } from '../src/ops/types';
import { fixture } from './corpus';

// The cases the adversarial review of the ops found, each kept fixed here.

const FILE = 'x.yml';
const open = (text: string, generated?: string) =>
  WorkflowDocument.open(text, { path: FILE, kind: 'workflow', ...(generated ? { generated } : {}) });
const ctxOf = (doc: WorkflowDocument, shared?: 'all'): OpContext => ({
  doc: (p) => (p === FILE ? doc : undefined),
  ...(shared ? { shared } : {}),
});
const plan = (doc: WorkflowDocument, op: WorkflowOp, shared?: 'all') => planOp(op, ctxOf(doc, shared));

/** The text an op leaves, or `refused: <reason>: <message>`. */
const result = (planned: EditPlan<Record<string, TextEdit[]>>): string =>
  planned.ok ? planned.documents[FILE]!.text : `refused: ${planned.reason}: ${planned.message}`;

function fp(doc: WorkflowDocument, job: string, index: number): Fp {
  const { id, name, uses, runHead } = doc.jobs().find((j) => j.id === job)!.steps[index]!;
  return Object.fromEntries(Object.entries({ id, name, uses, runHead }).filter(([, v]) => v !== undefined));
}

/** What the edit runtime does with a fix: its ops in turn, then the refused op again. */
function runFix(doc: WorkflowDocument, op: WorkflowOp, fix: Fix): string {
  let current = doc;
  const ops = fix.kind === 'ops' || fix.kind === 'shared-all' ? (fix.ops ?? []) : [];
  for (const fixOp of ops) {
    const step = plan(current, fixOp);
    if (!step.ok) return `fix refused: ${step.reason}`;
    current = step.documents[FILE]!;
  }
  return result(plan(current, op, fix.kind === 'shared-all' ? 'all' : undefined));
}

describe('needs', () => {
  it('sees needs through an alias and in another case when it looks for a loop', () => {
    const aliased = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n  c:\n    needs: &up [a]\n    runs-on: x\n  b:\n    needs: *up\n    runs-on: x\n',
    );
    expect(result(plan(aliased, { op: 'setNeeds', file: FILE, job: 'a', needs: ['b'] }))).toMatch(
      /^refused: cycle/,
    );
    const cased = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n  b:\n    needs: a\n    runs-on: x\n  c:\n    needs: B\n    runs-on: x\n',
    );
    expect(result(plan(cased, { op: 'setNeeds', file: FILE, job: 'a', needs: ['c'] }))).toBe(
      'refused: cycle: c already needs a through b; a needing c would loop.',
    );
  });

  it('refuses a job needing itself as a loop, also on a new job', () => {
    const doc = open('on: push\njobs:\n  b:\n    runs-on: x\n');
    expect(result(plan(doc, { op: 'setNeeds', file: FILE, job: 'b', needs: ['B'] }))).toBe(
      'refused: cycle: b cannot need itself.',
    );
    expect(result(plan(doc, { op: 'addJob', file: FILE, id: 'lint', job: { needs: ['lint'] } }))).toBe(
      'refused: cycle: lint cannot need itself.',
    );
    expect(result(plan(doc, { op: 'addJob', file: FILE, id: 'lint', job: { needs: ['ghost'] } }))).toMatch(
      /^refused: not-found/,
    );
    expect(result(plan(doc, { op: 'addJob', file: FILE, id: 'lint', job: { needs: ['B', 'b'] } }))).toContain(
      '    needs: [b]\n',
    );
  });

  it('takes out every entry naming a removed job, and diffs repeated needs without throwing', () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n  c:\n    runs-on: x\n  b:\n    needs: [a, c, A]\n    runs-on: x\n',
    );
    expect(result(plan(doc, { op: 'removeJob', file: FILE, job: 'a' }))).toContain('    needs: [c]\n');
    expect(result(plan(doc, { op: 'setNeeds', file: FILE, job: 'b', needs: ['a', 'c'] }))).toContain(
      '    needs: [a, c]\n',
    );
  });

  it('writes nothing for the same needs in another case, and treats an empty `needs:` as none', () => {
    const doc = open(
      'on: push\njobs:\n  build:\n    runs-on: x\n  deploy:\n    needs: Build\n    runs-on: x\n  e:\n    needs:\n    runs-on: x\n',
    );
    const same = plan(doc, { op: 'setNeeds', file: FILE, job: 'deploy', needs: ['build'] });
    expect(same.ok && same.value[FILE]).toEqual([]);
    expect(result(plan(doc, { op: 'setNeeds', file: FILE, job: 'e', needs: ['build'] }))).toContain(
      '    needs: build\n',
    );
  });

  it('warns when a need taken out is still read', () => {
    const doc = open(
      "on: push\njobs:\n  build:\n    runs-on: x\n  deploy:\n    needs: [build]\n    if: needs['build'].result == 'success'\n    runs-on: x\n",
    );
    const removed = plan(doc, { op: 'setNeeds', file: FILE, job: 'deploy', needs: [] });
    expect(removed.ok && removed.warnings.map((w) => w.message)).toEqual([
      '1 expression still reads needs.build (line 7).',
    ]);
  });

  it('checks every job a shared `needs` reaches under "Change all"', () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n  b:\n    needs: &n [a]\n    runs-on: x\n  c:\n    needs: *n\n    runs-on: x\n',
    );
    expect(result(plan(doc, { op: 'setNeeds', file: FILE, job: 'b', needs: ['a', 'c'] }, 'all'))).toBe(
      'refused: cycle: c cannot need itself.',
    );
  });
});

describe('jobs and steps', () => {
  it('does not copy a matrix runner into a new job, and adds the first job to `jobs: {}`', () => {
    const matrix = open(
      'on: push\njobs:\n  test:\n    strategy:\n      matrix:\n        os: [a, b]\n    runs-on: ${{ matrix.os }}\n',
    );
    expect(result(plan(matrix, { op: 'addJob', file: FILE, id: 'lint', after: 'test', job: {} }))).toContain(
      '  lint:\n    runs-on: ubuntu-latest\n',
    );
    const empty = open('on: push\njobs: {}\n');
    expect(result(plan(empty, { op: 'addJob', file: FILE, id: 'a', job: { steps: [{ run: 'a' }] } }))).toBe(
      'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: a\n',
    );
  });

  it("checks a new step's id and writes its `if:` as the file does", () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n    if: ${{ !cancelled() }}\n    steps:\n      - id: detect\n        run: x\n',
    );
    const step = (s: object) => plan(doc, { op: 'addStep', file: FILE, job: 'a', index: 1, step: s });
    expect(result(step({ id: 'DETECT', run: 'y' }))).toMatch(/^refused: duplicate-id/);
    expect(result(step({ id: '1 bad', run: 'y' }))).toMatch(/^refused: invalid-id/);
    expect(result(step({ if: '!cancelled()', run: 'y' }))).toContain('      - if: ${{ !cancelled() }}\n');
    expect(result(step({ run: 0 as never }))).toContain('      - run: 0\n');
  });

  it('warns when a move puts a step before the step whose outputs it reads', () => {
    const doc = open(
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - id: detect\n        run: x\n      - if: steps.detect.outputs.ok == 'true'\n        run: y\n",
    );
    const moved = plan(doc, { op: 'moveStep', file: FILE, job: 'a', from: 0, to: 1, fp: fp(doc, 'a', 0) });
    expect(moved.ok && moved.warnings.map((w) => w.message)).toEqual([
      '1 expression still reads steps.detect, now before that step runs (line 8).',
    ]);
  });
});

describe('planning', () => {
  it("answers with the file's lock before anything the op asks", () => {
    const generated = open(
      '# DO NOT EDIT\non: push\njobs:\n  a:\n    runs-on: x\n  b:\n    needs: a\n    runs-on: x\n',
      'DO NOT EDIT',
    );
    expect(result(plan(generated, { op: 'setNeeds', file: FILE, job: 'a', needs: ['b'] }))).toMatch(
      /^refused: generated/,
    );
    expect(
      result(plan(generated, { op: 'setJobField', file: FILE, job: 'a', field: 'if', value: null })),
    ).toMatch(/^refused: generated/);
  });

  it('offers fixes that clear every blocker in one go', () => {
    const shared = open(fixture('shared.yml'));
    const removeBuild: WorkflowOp = { op: 'removeJob', file: FILE, job: 'build' };
    const refusal = plan(shared, removeBuild);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.fixes.map((fix) => runFix(shared, removeBuild, fix))).not.toContainEqual(
      expect.stringMatching(/refused/),
    );
    const removeStep: WorkflowOp = {
      op: 'removeStep',
      file: FILE,
      job: 'build',
      index: 0,
      fp: fp(shared, 'build', 0),
    };
    const inside = plan(shared, removeStep);
    if (inside.ok) throw new Error('expected a refusal');
    for (const fix of inside.fixes) expect(runFix(shared, removeStep, fix), fix.label).not.toMatch(/refused/);
  });

  it("names the first document's lines in a refusal from a later step of an op", () => {
    const doc = open(
      'on: push\njobs:\n  b:\n    needs:\n      - a\n      - z\n    runs-on: x\n  z:\n    runs-on: x\n  a:\n    runs-on: &r ubuntu-latest\n  c:\n    runs-on: *r\n',
    );
    const refused = plan(doc, { op: 'removeJob', file: FILE, job: 'a' });
    expect(refused.ok || refused.message).toBe(
      'a on line 11 defines `&r`, which 1 other place reuses (line 13).',
    );
  });

  it('adds what a shared job lacks under "Change all", and warns callers only of a change', () => {
    const shared = open(fixture('shared.yml'));
    expect(
      result(plan(shared, { op: 'setOutput', file: FILE, job: 'build', name: 'o', value: 'v' }, 'all')),
    ).toContain('    outputs:\n      o: v\n');
    const called = open('on: workflow_call\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n');
    const converted = plan(called, { op: 'convertEol', file: FILE, eol: '\r\n' });
    expect(converted.ok && converted.warnings).toEqual([]);
    const named = plan(called, { op: 'setJobField', file: FILE, job: 'a', field: 'name', value: 'A' });
    expect(named.ok && named.warnings.map((w) => w.code)).toEqual(['callers']);
  });
});

describe('steps and bindings', () => {
  it('tells apart steps that look the same by the digest of the whole step', () => {
    const steps =
      'on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/upload-artifact@v4\n        with: {name: logs}\n      - uses: actions/upload-artifact@v4\n        with: {name: dist}\n';
    const before = open(steps);
    const picked = fingerprint(before, 'build', 1)!;
    // The checkout line goes in the pane before the op runs: the step now at index 1 is `dist`.
    const after = open(steps.replace('      - uses: actions/checkout@v4\n', ''));
    expect(result(plan(after, { op: 'removeStep', file: FILE, job: 'build', index: 1, fp: picked }))).toMatch(
      /^refused: moved/,
    );
    expect(
      result(plan(after, { op: 'removeStep', file: FILE, job: 'build', index: 0, fp: picked })),
    ).not.toMatch(/refused/);
  });

  it('writes a binding under the key the map has whatever its case, and an output name only when it is an id', () => {
    const doc = open(
      "on: push\njobs:\n  a:\n    runs-on: x\n    env:\n      CI: 'true'\n    steps:\n      - run: x\n",
    );
    expect(
      result(plan(doc, { op: 'setBinding', file: FILE, job: 'a', kind: 'env', name: 'ci', value: 'false' })),
    ).toContain("      CI: 'false'\n");
    expect(
      result(plan(doc, { op: 'setBinding', file: FILE, job: 'a', kind: 'env', name: 'ci', value: null })),
    ).not.toContain('CI');
    expect(
      result(plan(doc, { op: 'setOutput', file: FILE, job: 'a', name: 'my output', value: 'v' })),
    ).toMatch(/^refused: invalid-id/);
  });

  it("refuses what the job's or step's kind does not take", () => {
    const doc = open(
      'on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: make\n      - uses: a/b@v1\n  call:\n    uses: ./w.yml\n',
    );
    const refused = (op: WorkflowOp) => result(plan(doc, op)).split(':')[1];
    const step = (index: number) => ({ index, fp: fingerprint(doc, 'build', index)! });
    expect(refused({ op: 'setBinding', file: FILE, job: 'build', kind: 'with', name: 'a', value: '1' })).toBe(
      ' unsupported-shape',
    );
    expect(refused({ op: 'setBinding', file: FILE, job: 'call', kind: 'env', name: 'A', value: '1' })).toBe(
      ' unsupported-shape',
    );
    expect(refused({ op: 'setOutput', file: FILE, job: 'call', name: 'o', value: 'v' })).toBe(
      ' unsupported-shape',
    );
    expect(
      refused({
        op: 'setBinding',
        file: FILE,
        job: 'build',
        step: step(0),
        kind: 'with',
        name: 'a',
        value: '1',
      }),
    ).toBe(' unsupported-shape');
    expect(
      refused({ op: 'setStepField', file: FILE, job: 'build', ...step(1), field: 'shell', value: 'bash' }),
    ).toBe(' unsupported-shape');
    expect(
      refused({ op: 'setStepField', file: FILE, job: 'build', ...step(0), field: 'uses', value: 'a/b@v1' }),
    ).toBe(' unsupported-shape');
  });

  it('reads jobs and fields through aliases, and takes `[]` and odd indexes as they are', () => {
    const doc = open(
      'on: push\njobs:\n  test: &job\n    runs-on: x\n    steps:\n      - &t\n        run: npm test\n  again: *job\n  more:\n    runs-on: x\n    steps:\n      - *t\n  empty:\n    runs-on: x\n    steps: []\n',
    );
    expect(
      result(plan(doc, { op: 'addStep', file: FILE, job: 'again', index: 0, step: { run: 'x' } })),
    ).toMatch(/^refused: alias/);
    const absent = plan(doc, {
      op: 'setStepField',
      file: FILE,
      job: 'more',
      index: 0,
      fp: fingerprint(doc, 'more', 0)!,
      field: 'shell',
      value: null,
    });
    expect(absent.ok && absent.value[FILE]).toEqual([]);
    expect(
      result(plan(doc, { op: 'addStep', file: FILE, job: 'empty', index: 0, step: { run: 'x' } })),
    ).toContain('    steps:\n      - run: x\n');
    expect(
      result(plan(doc, { op: 'addStep', file: FILE, job: 'empty', index: 0.5, step: { run: 'x' } })),
    ).toMatch(/^refused: out-of-range/);
  });

  it('offers no "Change all" that would copy away the anchor it is about', () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: x\n        env: &e\n          TOKEN: t\n      - run: y\n        env: *e\n',
    );
    const op: WorkflowOp = {
      op: 'setBinding',
      file: FILE,
      job: 'a',
      step: { index: 0, fp: fingerprint(doc, 'a', 0)! },
      kind: 'env',
      name: 'TOKEN',
      value: null,
    };
    const refusal = plan(doc, op);
    if (refusal.ok) throw new Error('expected a refusal');
    expect(refusal.fixes.map((fix) => fix.label)).toEqual(['Change only here']);
  });

  it('suggests a step id from the action, else the name, as an id', () => {
    expect(stepIdFor({ uses: './', name: 'Build the local action' })).toBe('build-the-local-action');
    expect(stepIdFor({ name: '2nd pass' })).toBe('step-2nd-pass');
    expect(stepIdFor({ name: 'Café  -- build' })).toBe('cafe-build');
    expect(stepIdFor({ uses: '${{ inputs.action }}' })).toBeUndefined();
    expect(stepIdFor({ uses: 'actions/setup-node@v4', name: 'Node' })).toBe('setup-node');
  });

  it('finds a loop through a need that names the new job, and lets an output there keep its name', () => {
    const doc = open(
      'on: push\njobs:\n  x:\n    needs: lint\n    runs-on: x\n    outputs:\n      image.tag: a\n',
    );
    expect(result(plan(doc, { op: 'addJob', file: FILE, id: 'lint', job: { needs: ['x'] } }))).toBe(
      'refused: cycle: x already needs lint; lint needing x would loop.',
    );
    expect(
      result(plan(doc, { op: 'setOutput', file: FILE, job: 'x', name: 'image.tag', value: 'b' })),
    ).toContain('      image.tag: b\n');
  });

  it('refuses job fields a reusable call does not take, and `uses` on a job that runs steps', () => {
    const doc = open(
      'on: push\njobs:\n  build:\n    runs-on: x\n    steps: [{run: a}]\n  call:\n    uses: ./w.yml\n',
    );
    const field = (job: string, f: 'runs-on' | 'uses' | 'timeout-minutes', value: string | number) =>
      result(plan(doc, { op: 'setJobField', file: FILE, job, field: f, value }));
    expect(field('call', 'runs-on', 'x')).toMatch(
      /^refused: unsupported-shape: The job call calls a reusable workflow/,
    );
    expect(field('call', 'timeout-minutes', 5)).toMatch(/^refused: unsupported-shape/);
    expect(field('build', 'uses', './w.yml')).toMatch(
      /^refused: unsupported-shape: The job build runs steps/,
    );
  });

  it('offers no fix that the planner found could not get the op through', () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    runs-on: x\n  t: &tmpl\n    needs: [a]\n    runs-on: x\n  u: *tmpl\n  x:\n    needs: [u]\n    runs-on: x\n',
    );
    const refusal = plan(doc, { op: 'setNeeds', file: FILE, job: 't', needs: ['a', 'x'] });
    if (refusal.ok) throw new Error('expected a refusal');
    expect(refusal.fixes.map((fix) => fix.label)).toEqual(['Change only here']);
  });
});
