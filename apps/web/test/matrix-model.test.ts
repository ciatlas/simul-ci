/**
 * What the matrix editor reads from the document and gives the ops (synthesis § 4.7, § 2.7): a chip shows a value as
 * the file writes it; typed values are strings, quoted where YAML would read another type (`3.10` stays a string),
 * and numbers only in a dimension of numbers; removing the last value removes the dimension and the `matrix:` and
 * `strategy:` it empties; a part set at run time or written through an alias is read-only; the live line counts the
 * plan's legs, and past 256 the `matrix-limit` warning says so.
 */
import { type Json, planOp, WorkflowDocument, type WorkflowOp } from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import type { JobPlan, LegPlan, MatrixPlan, Tri } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import {
  chipText,
  type Dimension,
  entryWith,
  entryWithout,
  legLimit,
  legLine,
  matrixModel,
  parsePairs,
  replacedValue,
  splitValues,
  typedValue,
  withValue,
} from '../src/edit/matrix/model';

const CI = '.github/workflows/ci.yml';
const open = (text: string): WorkflowDocument => WorkflowDocument.open(text, { path: CI, kind: 'workflow' });

const TEXT = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [22, 24]
        python: ['3.9']
        os:
          - ubuntu-latest
        include:
          - { node: 24, experimental: true }
        exclude:
          - node: 22
            os: ubuntu-latest
    steps: [{ run: npm test }]
  lint:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        tool: [eslint]
    steps: [{ run: npx lint }]
`;

/** The text an op writes, through the document's own planner, as the editor's dispatch commits it. */
function written(text: string, op: WorkflowOp): string {
  const doc = open(text);
  const plan = planOp(op, { doc: (path) => (path === CI ? doc : undefined) });
  if (!plan.ok) throw new Error(plan.message);
  return applyEdits(text, plan.value[CI] ?? []).text;
}

const dim = (dims: Dimension[], name: string) => {
  const found = dims.find((d) => d.name === name)!;
  if (found.fixed) throw new Error(`${name} is read-only`);
  return found;
};
const setDim = (job: string, name: string, values: Json[] | null): WorkflowOp => ({
  op: 'setMatrixDim',
  file: CI,
  job,
  dim: name,
  values,
});

describe('the model of a matrix', () => {
  it('reads the dimensions as chips of their source, the entries as pairs, fail-fast as written', () => {
    const model = matrixModel(open(TEXT), 'test');
    expect(model.present).toBe(true);
    expect(model.fixed).toBeUndefined();
    expect(model.dims.map((d) => d.name)).toEqual(['node', 'python', 'os']);
    expect(dim(model.dims, 'node').values.map((c) => c.source)).toEqual(['22', '24']);
    expect(dim(model.dims, 'python').values).toEqual([{ value: '3.9', source: "'3.9'" }]);
    // A block list's line is its first item's.
    expect(dim(model.dims, 'os').line).toBe(11);
    expect(model.include).toEqual({
      entries: [
        {
          index: 0,
          line: 13,
          pairs: [
            { key: 'node', value: 24, source: '24' },
            { key: 'experimental', value: true, source: 'true' },
          ],
        },
      ],
    });
    expect(model.exclude.fixed).toBeUndefined();
    expect(model.failFast).toEqual({ value: false, line: 6 });
    expect(matrixModel(open(TEXT), 'lint').failFast).toEqual({ value: true });
  });

  it('is absent for a job without strategy, and a chip edits the value as text', () => {
    const model = matrixModel(open('on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: y }]\n'), 'a');
    expect(model).toMatchObject({ present: false, dims: [], include: { entries: [] } });
    expect([chipText('3.10'), chipText(22), chipText(true), chipText(null)]).toEqual([
      '3.10',
      '22',
      'true',
      '',
    ]);
  });
});

describe('typed values', () => {
  it('are strings, numbers beside numbers and booleans beside booleans', () => {
    expect(typedValue(' 3.10 ', ['3.9'])).toBe('3.10');
    expect(typedValue('26', [22, 24])).toBe(26);
    expect(typedValue('false', [true])).toBe(false);
    expect(typedValue('true', ['yes'])).toBe('true');
    expect(typedValue('22', undefined)).toBe('22');
    expect(typedValue('22', [])).toBe('22');
    expect(typedValue('latest', [22, 24])).toBe('latest');
    expect(splitValues('ubuntu-latest, windows-latest,, ')).toEqual(['ubuntu-latest', 'windows-latest']);
  });

  it('keep 3.10 a string in the file, and 26 a number in a dimension of numbers', () => {
    const model = matrixModel(open(TEXT), 'test');
    const python = written(
      TEXT,
      setDim('test', 'python', withValue(dim(model.dims, 'python').values, '3.10')),
    );
    expect(python).toContain("        python: ['3.9', '3.10']\n");
    const node = written(TEXT, setDim('test', 'node', withValue(dim(model.dims, 'node').values, '26')));
    expect(node).toContain('        node: [22, 24, 26]\n');
    // A new dimension's values are strings: the writer quotes the ones YAML would read as numbers.
    const added = written(TEXT, setDim('lint', 'python', splitValues('3.10, 3.12')));
    expect(added).toContain("        tool: [eslint]\n        python: ['3.10', '3.12']\n");
  });

  it('replace a value in place, keeping the others as written', () => {
    const chips = dim(matrixModel(open(TEXT), 'test').dims, 'node').values;
    expect(replacedValue(chips, 1, '26')).toEqual([22, 26]);
    expect(replacedValue(chips, 0, ' ')).toEqual([24]);
    // A dimension's only value, typed again, keeps its type.
    expect(replacedValue([{ value: 22, source: '22' }], 0, '26')).toEqual([26]);
    expect(replacedValue([{ value: true, source: 'true' }], 0, 'false')).toEqual([false]);
    expect(written(TEXT, setDim('test', 'node', replacedValue(chips, 1, '26')))).toContain(
      'node: [22, 26]\n',
    );
  });
});

describe('emptied parts', () => {
  it('go with their last value: the dimension, then the matrix and the strategy it empties', () => {
    const lint = dim(matrixModel(open(TEXT), 'lint').dims, 'tool');
    expect(replacedValue(lint.values, 0, '')).toBeNull();
    const after = written(TEXT, setDim('lint', 'tool', replacedValue(lint.values, 0, '')));
    expect(after).toBe(TEXT.replace('    strategy:\n      matrix:\n        tool: [eslint]\n', ''));
    expect(matrixModel(open(after), 'lint').present).toBe(false);
  });

  it('keep a strategy that holds more than the matrix', () => {
    const os = dim(matrixModel(open(TEXT), 'test').dims, 'os');
    const after = written(TEXT, setDim('test', 'os', replacedValue(os.values, 0, '')));
    expect(after).not.toContain('        os:\n');
    expect(after).toContain('      fail-fast: false\n');
  });
});

describe('include and exclude entries', () => {
  it('read pairs typed key=value, several separated by commas', () => {
    expect(parsePairs('os=windows-latest, node = 20')).toEqual([
      ['os', 'windows-latest'],
      ['node', '20'],
    ]);
    expect(parsePairs('os')).toBeUndefined();
    expect(parsePairs('=x')).toBeUndefined();
    expect(parsePairs('')).toBeUndefined();
  });

  it('type a value by the values its key has in the matrix, so the entry matches those legs', () => {
    const model = matrixModel(open(TEXT), 'test');
    expect(entryWith(undefined, [['node', '20']], model)).toEqual({ node: 20 });
    expect(entryWith(undefined, [['python', '3.10']], model)).toEqual({ python: '3.10' });
    // A key only entries name is typed by them; a key the matrix does not have is a string.
    expect(entryWith(undefined, [['experimental', 'false']], model)).toEqual({ experimental: false });
    expect(entryWith(undefined, [['label', 'true']], model)).toEqual({ label: 'true' });
    const [entry] = model.include.fixed ? [] : model.include.entries;
    expect(entryWith(entry, [['os', 'macos-latest']], model)).toEqual({
      node: 24,
      experimental: true,
      os: 'macos-latest',
    });
    expect(entryWithout(entry!, 'node')).toEqual({ experimental: true });
    expect(entryWithout({ index: 0, line: 1, pairs: [{ key: 'a', value: 1, source: '1' }] }, 'a')).toBeNull();
  });

  it('append and remove through the op, the emptied list going with its last entry', () => {
    const model = matrixModel(open(TEXT), 'test');
    const op = (index: number | 'append', entry: Record<string, Json> | null): WorkflowOp => ({
      op: 'setMatrixEntry',
      file: CI,
      job: 'test',
      list: 'include',
      index,
      entry,
    });
    const appended = written(TEXT, op('append', entryWith(undefined, [['node', '20']], model)));
    expect(appended).toContain('          - { node: 24, experimental: true }\n          - { node: 20 }\n');
    expect(written(TEXT, op(0, null))).not.toContain('include');
  });
});

describe('parts set at run time', () => {
  it('are read-only: a matrix, a dimension, a list, fail-fast', () => {
    const text = `on: push
jobs:
  a:
    runs-on: x
    strategy:
      fail-fast: \${{ inputs.fast }}
      matrix: \${{ fromJSON(needs.setup.outputs.matrix) }}
    steps: [{ run: y }]
  b:
    runs-on: x
    strategy:
      matrix:
        os: \${{ fromJSON(inputs.os) }}
        node: [22]
        include: \${{ fromJSON(inputs.extra) }}
    steps: [{ run: y }]
`;
    const a = matrixModel(open(text), 'a');
    expect(a.fixed).toEqual({
      part: 'matrix',
      source: '${{ fromJSON(needs.setup.outputs.matrix) }}',
      line: 7,
      why: 'Set at run time',
    });
    expect(a.failFast.fixed?.why).toBe('Set at run time');
    const b = matrixModel(open(text), 'b');
    expect(b.dims[0]).toEqual({
      name: 'os',
      line: 13,
      fixed: { source: '${{ fromJSON(inputs.os) }}', line: 13, why: 'Set at run time' },
    });
    expect(dim(b.dims, 'node').values).toEqual([{ value: 22, source: '22' }]);
    expect(b.include.fixed?.why).toBe('Set at run time');
    expect(b.exclude).toEqual({ entries: [] });
  });

  it('as are a strategy written through an alias and a dimension that is not a list', () => {
    const text = `on: push
jobs:
  a:
    runs-on: x
    strategy: &s
      matrix:
        os: ubuntu-latest
    steps: [{ run: y }]
  b:
    runs-on: x
    strategy: *s
    steps: [{ run: y }]
`;
    expect(matrixModel(open(text), 'b').fixed).toMatchObject({ part: 'strategy', why: 'A reference to &s' });
    expect(matrixModel(open(text), 'a').dims[0]?.fixed?.why).toBe('Written as YAML this editor cannot show');
  });
});

const leg = (verdict: Tri, n: number): LegPlan =>
  ({
    id: `${CI}#test[n=${n}]`,
    legKey: `n=${n}`,
    values: {},
    runs: { verdict, chain: [] },
  }) as unknown as LegPlan;

const jobPlan = (matrix: Partial<MatrixPlan> | undefined, legs: LegPlan[], verdict: Tri = 'yes'): JobPlan =>
  ({
    id: `${CI}#test`,
    jobId: 'test',
    runs: { verdict, chain: [] },
    legs,
    ...(matrix ? { matrix: { keys: [], exact: true, dynamic: false, truncated: false, ...matrix } } : {}),
  }) as unknown as JobPlan;

describe('the live line', () => {
  it('counts the plan’s legs by verdict', () => {
    const legs = [leg('yes', 1), leg('yes', 2), leg('no', 3), leg('maybe', 4), leg('yes', 5), leg('no', 6)];
    expect(legLine(jobPlan({ count: 6 }, legs))).toBe('6 legs: 3 run · 1 might run · 2 skipped');
    expect(legLine(jobPlan({ count: 1 }, [leg('yes', 1)]))).toBe('1 leg: 1 run');
    expect(legLine(jobPlan({ count: 4 }, [], 'no'))).toBe('4 legs: 4 skipped');
    expect(legLine(jobPlan({ dynamic: true }, [leg('maybe', 1)]))).toBe('The legs are set at run time.');
    expect(legLine(jobPlan(undefined, [leg('yes', 1)]))).toBeUndefined();
  });

  it('warns past 256 legs, and when there are too many to list', () => {
    expect(legLimit(jobPlan({ count: 256 }, []))).toBeUndefined();
    expect(legLimit(jobPlan({ count: 300 }, []))).toBe(
      "test's matrix makes 300 legs; GitHub runs at most 256 jobs from one matrix.",
    );
    expect(legLimit(jobPlan({ truncated: true }, []))).toMatch(/too many combinations/);
    expect(legLimit(jobPlan({ dynamic: true }, []))).toBeUndefined();
  });
});
