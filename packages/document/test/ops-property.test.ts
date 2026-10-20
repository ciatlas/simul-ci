import { loadProject, memoryFileSystem } from '@ciatlas/core';
import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowDocument, type Json, type TextEdit } from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import { planOp } from '../src/ops/plan';
import type { Fp, JobField, NewStep, StepField, WorkflowOp } from '../src/ops/types';
import { BOM, crlf, fixtures, workflows } from './corpus';
import { normalized, opExpected } from './ops-model';
import { same } from './model';
import { runs } from './runs';
import { valueOf } from './walk';

vi.setConfig({ testTimeout: 600_000 });

const FILE = '.github/workflows/ci.yml';
const open = (text: string) => WorkflowDocument.open(text, { path: FILE, kind: 'workflow' });

const VALUES: Json[] = [
  'ubuntu-latest',
  '24',
  '3.10',
  '',
  'true',
  "github.ref == 'refs/heads/main'",
  '!cancelled()',
  'a: b',
  '#x',
  '${{ matrix.os }}',
  'two\nlines',
  30,
  true,
  null,
];
const STEPS: NewStep[] = [
  { run: 'echo hi' },
  { uses: 'actions/checkout@v4' },
  { name: 'Lint', run: 'npm run lint\nnpm run fmt' },
  { uses: 'actions/setup-node@v4', with: { 'node-version': '24', cache: 'pnpm' } },
  { id: 'meta', run: 'echo "v=1" >> "$GITHUB_OUTPUT"', if: 'always()' },
];
const JOB_FIELDS: JobField[] = [
  'name',
  'runs-on',
  'if',
  'environment',
  'continue-on-error',
  'timeout-minutes',
];
const STEP_FIELDS: StepField[] = [
  'name',
  'if',
  'run',
  'shell',
  'working-directory',
  'continue-on-error',
  'timeout-minutes',
];

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]): T | undefined => items[Math.floor(rand() * items.length)];
const at = (rand: Rand, n: number) => Math.floor(rand() * n);

function fingerprint(doc: WorkflowDocument, job: string, index: number): Fp {
  const { id, name, uses, runHead } = doc.jobs().find((j) => j.id === job)!.steps[index]!;
  return Object.fromEntries(Object.entries({ id, name, uses, runHead }).filter(([, v]) => v !== undefined));
}

/** An op over what the document holds now. */
function pickOp(doc: WorkflowDocument, rand: Rand): WorkflowOp | undefined {
  const jobs = doc.jobs();
  const job = pick(rand, jobs);
  if (!job) return undefined;
  const kind = pick(rand, Object.keys(JOB_OPS))!;
  return JOB_OPS[kind]!(doc, rand, job.id, job.steps.length);
}

const JOB_OPS: Record<
  string,
  (doc: WorkflowDocument, rand: Rand, job: string, steps: number) => WorkflowOp | undefined
> = {
  workflow: (_, rand) => ({
    op: 'setWorkflowField',
    file: FILE,
    field: pick(rand, ['name', 'run-name'] as const)!,
    value: rand() < 0.2 ? null : `W ${at(rand, 9)}`,
  }),
  addJob: (doc, rand, job) => ({
    op: 'addJob',
    file: FILE,
    id: `new_${at(rand, 1e6)}`,
    ...(rand() < 0.5 ? { after: job } : {}),
    job: { 'runs-on': 'ubuntu-latest', needs: rand() < 0.5 ? [job] : [], steps: [pick(rand, STEPS)!] },
  }),
  removeJob: (doc, _, job) => (doc.jobs().length > 1 ? { op: 'removeJob', file: FILE, job } : undefined),
  setJobField: (_, rand, job) => ({
    op: 'setJobField',
    file: FILE,
    job,
    field: pick(rand, JOB_FIELDS)!,
    value: pick(rand, VALUES)!,
  }),
  setNeeds: (doc, rand, job) => {
    const others = doc
      .jobs()
      .map((j) => j.id)
      .filter((id) => id !== job);
    return { op: 'setNeeds', file: FILE, job, needs: others.filter(() => rand() < 0.4) };
  },
  setOutput: (_, rand, job) => ({
    op: 'setOutput',
    file: FILE,
    job,
    name: pick(rand, ['out', 'version'])!,
    value: rand() < 0.3 ? null : '${{ steps.x.outputs.y }}',
  }),
  setBinding: (doc, rand, job, steps) => {
    const index = steps > 0 && rand() < 0.6 ? at(rand, steps) : undefined;
    const step = index === undefined ? {} : { step: { index, fp: fingerprint(doc, job, index) } };
    return {
      op: 'setBinding',
      file: FILE,
      job,
      ...step,
      kind: pick(rand, ['with', 'env'] as const)!,
      name: pick(rand, ['A', 'token'])!,
      value: rand() < 0.3 ? null : pick(rand, VALUES)!,
    };
  },
  addStep: (_, rand, job, steps) => ({
    op: 'addStep',
    file: FILE,
    job,
    index: at(rand, steps + 1),
    step: pick(rand, STEPS)!,
  }),
  removeStep: (doc, rand, job, steps) => {
    const index = at(rand, steps);
    return steps > 1
      ? { op: 'removeStep', file: FILE, job, index, fp: fingerprint(doc, job, index) }
      : undefined;
  },
  moveStep: (doc, rand, job, steps) => {
    const from = at(rand, steps);
    return steps > 1
      ? { op: 'moveStep', file: FILE, job, from, to: at(rand, steps), fp: fingerprint(doc, job, from) }
      : undefined;
  },
  setStepField: (doc, rand, job, steps) => {
    const index = at(rand, steps);
    return steps > 0
      ? {
          op: 'setStepField',
          file: FILE,
          job,
          index,
          fp: fingerprint(doc, job, index),
          field: pick(rand, STEP_FIELDS)!,
          value: pick(rand, VALUES)!,
        }
      : undefined;
  },
};

function coreErrors(text: string): string[] {
  const project = loadProject({ root: '.', fs: memoryFileSystem({ [FILE]: text }), validateSchema: false });
  return (project.workflows.get(FILE)?.parseErrors ?? []).map((e) => e.message);
}

/** Up to 12 ops; each means what the model says; then undo gives the bytes back and redo gives them again. */
function sequence(original: string, stream: readonly number[]): void {
  let i = 0;
  const rand = () => stream[i++ % stream.length]! / 1_000_000;
  let doc = open(original);
  const undo: TextEdit[][] = [];
  const redo: TextEdit[][] = [];
  for (let n = 0; n < 12; n++) {
    const op = pickOp(doc, rand);
    if (!op) continue;
    const result = planOp(op, { doc: () => doc });
    if (!result.ok) {
      expect(
        result.reason,
        `${JSON.stringify(op)}\n${result.message}\n${JSON.stringify(result.fixes)}\n${JSON.stringify(doc.text)}`,
      ).not.toBe('internal');
      continue;
    }
    const edits = result.value[FILE]!;
    const next = result.documents[FILE]!;
    const want = opExpected(valueOf(doc), op, { ifWrapped: doc.style.ifStyle === 'wrapped' });
    expect(
      same(normalized(valueOf(next)), want),
      `${JSON.stringify(op)}\n--- before\n${doc.text}\n--- after\n${next.text}`,
    ).toBe(true);
    const { inverse } = applyEdits(doc.text, edits);
    undo.push(inverse);
    redo.push(edits);
    doc = next;
  }
  expect(coreErrors(doc.text)).toEqual([]);
  let text = doc.text;
  for (const inverse of undo.toReversed()) text = applyEdits(text, inverse).text;
  expect(text).toBe(original);
  for (const edits of redo) text = applyEdits(text, edits).text;
  expect(text).toBe(doc.text);
}

const files = [...fixtures(), ...workflows().filter((f) => !f.name.startsWith('.github/'))].filter((f) => {
  const doc = open(f.text);
  return doc.status.editable && doc.jobs().length > 0 && doc.anchors.dangling.length === 0;
});

describe('op sequences (fast-check)', () => {
  it.each(files.map((f) => [f.name, f.text, f.owned] as const))(
    '%s: the meaning as defined, undo and redo to identical bytes',
    (_, text, owned) => {
      const variants = [text, crlf(text), `${BOM}${crlf(text)}`];
      fc.assert(
        fc.property(
          fc.nat({ max: 2 }),
          fc.array(fc.integer({ min: 0, max: 999_999 }), { minLength: 40, maxLength: 120 }),
          (v, stream) => sequence(variants[v]!, stream),
        ),
        { numRuns: runs(owned ? 100 : 15) },
      );
    },
  );
});
