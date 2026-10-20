import { describe, expect, it } from 'vitest';
import {
  convertEol,
  dealias,
  dealiasAnchor,
  insert,
  move,
  remove,
  renameKey,
  replaceAt,
  set,
  WorkflowDocument,
  type EditPlan,
  type Refusal,
  type TextEdit,
} from '@simulci/document';
import { verify } from '../src/verify';
import { fixture } from './corpus';

const PATH = '.github/workflows/ci.yml';
const open = (text: string) => WorkflowDocument.open(text, { path: PATH, kind: 'workflow' });

function refused(plan: EditPlan<TextEdit[]>): Refusal {
  if (plan.ok) throw new Error(`expected a refusal, got ${JSON.stringify(plan.value)}`);
  return plan;
}

describe('refusals of the primitives (§ 2.8)', () => {
  const shared = open(fixture('shared.yml'));

  it('alias: the target is an alias; the fix copies the value here', () => {
    expect(refused(set(shared, ['jobs', 'test', 'runs-on'], 'x'))).toEqual({
      ok: false,
      reason: 'alias',
      file: PATH,
      message: "test's `runs-on` is `*runner`, a reference to `&runner` on line 3.",
      at: ['jobs', 'test', 'runs-on'],
      fixes: [
        {
          kind: 'ops',
          label: 'Give test its own value',
          ops: [{ op: 'dealias', file: PATH, path: ['jobs', 'test', 'runs-on'] }],
          retry: true,
        },
        { kind: 'reveal', label: 'Edit the anchor', line: 3 },
      ],
    });
  });

  it('alias: a parent is an alias', () => {
    expect(refused(set(shared, ['jobs', 'again', 'runs-on'], 'x'))).toMatchObject({
      reason: 'alias',
      message: 'again is `*job`, a reference to `&job` on line 5.',
      at: ['jobs', 'again'],
    });
  });

  it('shared-anchor: the target is inside an anchor others reuse; change only here, or all uses', () => {
    const doc = open(fixture('anchored-runs-on.yml'));
    expect(refused(set(doc, ['jobs', 'build', 'runs-on'], 'self-hosted'))).toEqual({
      ok: false,
      reason: 'shared-anchor',
      file: PATH,
      message: "build's `runs-on` is inside `&runner`, which 1 other place reuses (line 8).",
      at: ['jobs', 'build', 'runs-on'],
      fixes: [
        {
          kind: 'ops',
          label: 'Change only here',
          ops: [{ op: 'dealiasAnchor', file: PATH, anchor: 'runner' }],
          retry: true,
        },
        { kind: 'shared-all', label: 'Change all 2 uses' },
      ],
    });
    expect(refused(insert(shared, ['jobs', 'build', 'steps'], 0, { run: 'x' }))).toMatchObject({
      reason: 'shared-anchor',
      message: expect.stringContaining('`&job`, which 1 other place reuses (line 20)'),
    });
  });

  it('anchor: a removal would orphan an anchor others still use', () => {
    expect(refused(remove(shared, ['jobs', 'build']))).toEqual({
      ok: false,
      reason: 'anchor',
      file: PATH,
      message: 'build on line 5 defines `&job`, which 1 other place reuses (line 20).',
      at: ['jobs', 'build'],
      line: 5,
      fixes: [
        {
          kind: 'ops',
          label: 'Copy into its uses first',
          ops: [{ op: 'dealiasAnchor', file: PATH, anchor: 'job' }],
          retry: true,
        },
      ],
    });
    expect(refused(set(shared, ['env'], 'none'))).toMatchObject({
      reason: 'anchor',
      message: expect.stringContaining('defines `&runner`'),
    });
  });

  it('anchor: a move would put an alias above its anchor', () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    steps:\n      - &setup\n        run: make\n      - *setup\n',
    );
    expect(refused(move(doc, ['jobs', 'a', 'steps'], 1, 0))).toMatchObject({
      reason: 'anchor',
      message: "a's step 1 on line 5 defines `&setup`, which 1 other place reuses (line 7).",
    });
  });

  it('anchor: an alias that names nothing, or an anchor only below it, locks every edit', () => {
    const doc = open(fixture('anchors.yml'));
    expect(refused(set(doc, ['name'], 'x'))).toEqual({
      ok: false,
      reason: 'anchor',
      file: PATH,
      message:
        '`*later` on line 6 comes before its anchor on line 32, and YAML needs the anchor first. Fix it in the YAML pane.',
      line: 6,
      fixes: [{ kind: 'reveal', label: 'Show line 6', line: 6 }],
    });
    const missing = open(fixture('anchors.yml').replace('  EARLY: *later\n', ''));
    expect(refused(set(missing, ['name'], 'x')).message).toBe(
      '`*nowhere` on line 6 names no anchor before it. Fix it in the YAML pane.',
    );
  });

  it('merge-key: a map on the path uses `<<`', () => {
    const doc = open('x: &base\n  runs-on: a\non: push\njobs:\n  m:\n    <<: *base\n    name: m\n');
    expect(refused(set(doc, ['jobs', 'm', 'name'], 'n'))).toEqual({
      ok: false,
      reason: 'merge-key',
      file: PATH,
      message:
        'm uses a YAML merge key (`<<:` on line 6), which GitHub does not apply; edit it in the YAML pane.',
      at: ['jobs', 'm'],
      line: 6,
      fixes: [{ kind: 'reveal', label: 'Show line 6', line: 6 }],
    });
  });

  it('flow-shape: an inline collection over several lines, holding a collection, or asked to hold one', () => {
    const doc = open(
      'on: push\njobs:\n  a:\n    needs: [b,\n      c]\n    with: {x: [1], y: 2}\n    env: {A: 1}\n',
    );
    expect(refused(insert(doc, ['jobs', 'a', 'needs'], 0, 'd'))).toEqual({
      ok: false,
      reason: 'flow-shape',
      file: PATH,
      message: "a's `needs` is written inline over 2 lines; edit it in the YAML pane.",
      at: ['jobs', 'a', 'needs'],
      line: 4,
      fixes: [{ kind: 'reveal', label: 'Show line 4', line: 4 }],
    });
    expect(refused(set(doc, ['jobs', 'a', 'with', 'y'], 3)).message).toBe(
      "a's `with` is written inline with a collection inside; edit it in the YAML pane.",
    );
    expect(refused(set(doc, ['jobs', 'a', 'env', 'B'], [1])).message).toBe(
      "a's `env` is written inline and cannot hold this value; edit it in the YAML pane.",
    );
    expect(refused(move(doc, ['jobs', 'a', 'needs'], 0, 1)).reason).toBe('flow-shape');
  });

  it('unsupported-shape: what an edit cannot write', () => {
    const doc = open(fixture('events.yml'));
    expect(refused(set(doc, [], {})).message).toBe(
      'The whole file cannot be replaced by an edit; edit it in the YAML pane.',
    );
    expect(refused(set(doc, ['jobs', 'build', 'steps', 'x'], 1)).message).toBe(
      "Build's `steps` is not a map; edit it in the YAML pane.",
    );
    expect(refused(insert(doc, ['jobs', 'build'], 0, 1)).message).toBe(
      'Build is not a list; edit it in the YAML pane.',
    );
    expect(refused(remove(doc, ['jobs', 'build', 'steps', 2, 'run'])).message).toBe(
      "Build's step 3 would be left empty; edit it in the YAML pane.",
    );
    expect(refused(remove(open('on: push\n'), ['on'])).message).toBe(
      'The file would be left empty; edit it in the YAML pane.',
    );
    expect(refused(renameKey(doc, ['jobs', 'build', 'steps', 0], 'x')).message).toBe(
      "Build's step 1 is not a key; edit it in the YAML pane.",
    );
  });

  it('not-found and out-of-range: the target is gone', () => {
    const doc = open(fixture('events.yml'));
    expect(refused(remove(doc, ['jobs', 'deploy']))).toEqual({
      ok: false,
      reason: 'not-found',
      file: PATH,
      message: 'deploy is not in ci.yml any more.',
      at: ['jobs', 'deploy'],
      fixes: [],
    });
    expect(refused(remove(doc, ['jobs', 'build', 'steps', 7]))).toMatchObject({
      reason: 'out-of-range',
      message: "build's `steps` has 3 items; there is no item 8.",
    });
    expect(refused(insert(doc, ['jobs', 'build', 'steps'], 9, 'x')).reason).toBe('out-of-range');
    expect(refused(move(doc, ['jobs', 'build', 'steps'], 0, 3)).reason).toBe('out-of-range');
    expect(refused(insert(doc, ['jobs', 'build', 'services'], 1, 'x')).reason).toBe('out-of-range');
    expect(refused(dealias(doc, ['jobs', 'build'])).reason).toBe('not-found');
    expect(refused(dealiasAnchor(doc, 'nope'))).toMatchObject({
      reason: 'not-found',
      message: '`&nope` is not in ci.yml any more.',
    });
  });

  it('duplicate-id: a rename onto a key that is there', () => {
    const doc = open(fixture('comments.yml'));
    expect(refused(renameKey(doc, ['jobs', 'build'], 'test'))).toEqual({
      ok: false,
      reason: 'duplicate-id',
      file: PATH,
      message: '`jobs` already has `test`.',
      at: ['jobs', 'test'],
      fixes: [],
    });
  });

  it('stale: the text at a reference is not what was expected', () => {
    const doc = open(fixture('comments.yml'));
    const from = doc.text.indexOf('needs: build') + 7;
    expect(refused(replaceAt(doc, { from, to: from + 5 }, 'buildx', 'compile'))).toEqual({
      ok: false,
      reason: 'stale',
      file: PATH,
      message: 'ci.yml changed at line 28 while the edit was prepared; try again.',
      line: 28,
      fixes: [],
    });
  });

  it('mixed-eol: no edit but the conversion until the file has one line ending', () => {
    const doc = open('on: push\r\njobs:\n  a: {}\n');
    expect(refused(set(doc, ['on'], 'pull_request'))).toEqual({
      ok: false,
      reason: 'mixed-eol',
      file: PATH,
      message: 'ci.yml mixes CRLF and LF line endings; convert it to one first.',
      fixes: [
        {
          kind: 'ops',
          label: 'Convert to LF',
          ops: [{ op: 'convertEol', file: PATH, eol: '\n' }],
          retry: true,
        },
        {
          kind: 'ops',
          label: 'Convert to CRLF',
          ops: [{ op: 'convertEol', file: PATH, eol: '\r\n' }],
          retry: true,
        },
      ],
    });
    const converted = convertEol(doc, '\n');
    expect(converted.ok && converted.documents[PATH]!.text).toBe('on: push\njobs:\n  a: {}\n');
  });

  it('the status locks: an edit of a locked file gives the lock', () => {
    expect(refused(set(open('on: [\n'), ['on'], 'push')).reason).toBe('invalid-yaml');
    const generated = WorkflowDocument.open('# DO NOT EDIT\non: push\n', {
      path: PATH,
      kind: 'workflow',
      generated: 'DO NOT EDIT',
    });
    expect(refused(remove(generated, ['on'])).reason).toBe('generated');
    expect(refused(convertEol(open('on: push\n---\na: 1\n'), '\r\n')).reason).toBe('multi-document');
  });

  it('a name defined twice: dealiasAnchor cannot tell which', () => {
    const doc = open('a: &x 1\nb: *x\nc: &x 2\nd: *x\n');
    expect(refused(dealiasAnchor(doc, 'x'))).toMatchObject({
      reason: 'unsupported-shape',
      message: '`&x` is defined more than once (lines 1, 3); edit it in the YAML pane.',
      line: 3,
    });
  });

  it('internal: a check that fails refuses, with what it found to report', () => {
    const doc = open('on: push\n');
    const lie = verify(doc, {
      label: 'Lie',
      edits: [{ from: 4, to: 8, insert: 'pull_request' }],
      expect: (js) => js,
    });
    expect(lie).toMatchObject({
      ok: false,
      reason: 'internal',
      message: 'simulci could not make this edit cleanly; nothing was changed.',
      line: 1,
    });
    const report = !lie.ok && lie.fixes.find((f) => f.kind === 'report');
    expect(report && JSON.parse(report.text)).toMatchObject({
      label: 'Lie',
      why: 'the value differs at /on',
    });
    expect(verify(doc, { label: 'Break', edits: [{ from: 4, to: 4, insert: '[' }] })).toMatchObject({
      reason: 'internal',
    });
    expect(
      verify(doc, {
        label: 'Overlap',
        edits: [
          { from: 0, to: 4, insert: '' },
          { from: 2, to: 6, insert: '' },
        ],
      }),
    ).toMatchObject({ reason: 'internal' });
    expect(
      verify(open('on: push\r\n'), { label: 'LF', edits: [{ from: 8, to: 8, insert: 'x: 1\n' }] }),
    ).toMatchObject({ reason: 'internal' });
    expect(
      verify(open('\uFEFFon: push\n'), { label: 'BOM', edits: [{ from: 0, to: 1, insert: '' }] }),
    ).toMatchObject({ reason: 'internal' });
    expect(verify(doc, { label: 'Warn', edits: [{ from: 4, to: 8, insert: '!x' }] })).toMatchObject({
      reason: 'internal',
    });
  });
});
