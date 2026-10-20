/**
 * What Properties reads from the document and writes back (synthesis § 4.4, § 2.7): a field shows the value as the
 * file writes it, without YAML's quotes or a block's header; an alias, a merge key or a shape the field cannot hold
 * is shown as its source; typed text becomes the op's value by the field's kind, a binding keeping its number or
 * boolean only when the text spells the same value.
 */
import { WorkflowDocument } from '@simulci/document';
import { describe, expect, it } from 'vitest';
import {
  bindingValue,
  type FieldSpec,
  groupKey,
  jobFields,
  shown,
  stepFields,
  valueOf,
  workflowFields,
} from '../src/edit/property/model';

const CI = '.github/workflows/ci.yml';
const doc = WorkflowDocument.open(
  `name: 'CI: all'
on: push
jobs:
  a:
    runs-on: [self-hosted, linux]
    environment: { name: prod, url: x }
    timeout-minutes: 5
    steps:
      - run: |
          npm ci
          npm test
      - <<: { uses: x }
  b:
    runs-on: &r ubuntu-latest
    if: \${{ always() }}
    steps: [{ uses: actions/checkout@v4 }]
  c:
    runs-on: *r
    steps: [{ run: x }]
`,
  { path: CI, kind: 'workflow' },
);
const field = (specs: FieldSpec[], key: string): FieldSpec => specs.find((s) => s.key === key)!;

describe('the fields', () => {
  it('are a job’s runner fields, or a call’s uses; a step’s action or script fields', () => {
    expect(jobFields(CI, 'a', false).map((f) => f.key)).toEqual([
      'name',
      'runs-on',
      'if',
      'environment',
      'continue-on-error',
      'timeout-minutes',
    ]);
    expect(jobFields(CI, 'a', true).map((f) => f.key)).toEqual(['name', 'uses', 'if']);
    expect(stepFields(CI, 'a', 0, true).map((f) => f.key)).toContain('uses');
    expect(stepFields(CI, 'a', 0, false).map((f) => f.key)).toEqual([
      'name',
      'run',
      'shell',
      'working-directory',
      'if',
      'continue-on-error',
      'timeout-minutes',
    ]);
    expect(field(workflowFields(CI), 'run-name').op(null)).toEqual({
      op: 'setWorkflowField',
      file: CI,
      field: 'run-name',
      value: null,
    });
    expect(field(stepFields(CI, 'a', 1, false), 'name').op('x', { name: 'n' })).toMatchObject({
      op: 'setStepField',
      index: 1,
      fp: { name: 'n' },
    });
  });

  it('show the value as written, a list of labels joined, a block’s lines without its header', () => {
    const job = jobFields(CI, 'a', false);
    expect(shown(doc, field(workflowFields(CI), 'name'))).toEqual({ text: 'CI: all', line: 1 });
    expect(shown(doc, field(job, 'runs-on')).text).toBe('self-hosted, linux');
    expect(shown(doc, field(job, 'timeout-minutes')).text).toBe('5');
    expect(shown(doc, field(job, 'if'))).toEqual({ text: '' });
    expect(shown(doc, field(stepFields(CI, 'a', 0, false), 'run')).text).toBe('npm ci\nnpm test');
    expect(shown(doc, field(jobFields(CI, 'b', false), 'if')).text).toBe('${{ always() }}');
  });

  it('show their source, read-only, for an alias, a merge key or a shape they cannot hold', () => {
    expect(shown(doc, field(jobFields(CI, 'c', false), 'runs-on'))).toMatchObject({
      fixed: { source: '*r', probe: true },
    });
    expect(shown(doc, field(stepFields(CI, 'a', 1, true), 'uses')).fixed).toMatchObject({ probe: true });
    expect(shown(doc, field(jobFields(CI, 'a', false), 'environment')).fixed).toMatchObject({
      source: '{ name: prod, url: x }',
      why: 'Environment is written as YAML this field cannot show; edit it in the YAML pane.',
    });
  });
});

describe('typed text', () => {
  it('becomes the value of the field’s kind, nothing removing the key', () => {
    expect(valueOf('text', '  x  ', undefined)).toBe('x');
    expect(valueOf('text', '   ', 'x')).toBeNull();
    expect(valueOf('number', '30', 5)).toBe(30);
    expect(valueOf('number', '${{ vars.T }}', 5)).toBe('${{ vars.T }}');
    expect(valueOf('flag', 'true', undefined)).toBe(true);
    expect(valueOf('flag', '${{ x }}', undefined)).toBe('${{ x }}');
    expect(valueOf('labels', 'a, b,', 'a')).toEqual(['a', 'b']);
    expect(valueOf('labels', 'linux', ['a', 'b'])).toEqual(['linux']);
    expect(valueOf('labels', 'linux', 'a')).toBe('linux');
    expect(valueOf('lines', 'a\n  b', undefined)).toBe('a\n  b');
    expect(valueOf('value', '', 'x')).toBe('');
  });

  it('keeps a binding’s number or boolean only when the text spells the same value', () => {
    expect(bindingValue('22', 20)).toBe(22);
    expect(bindingValue('3.10', 3.1)).toBe('3.10');
    expect(bindingValue('false', true)).toBe(false);
    expect(bindingValue('22', '20')).toBe('22');
    expect(bindingValue('22', undefined)).toBe('22');
  });

  it('is grouped by the field it was typed in', () => {
    expect(groupKey(CI, ['jobs', 'a', 'steps', 0, 'run'])).toBe(`field:${CI}:jobs.a.steps.0.run`);
  });
});
