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
import { jobReferences, stepReferences } from './refs';
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

/** An op over what the document holds now, and the references a rename of it reads. */
function pickOp(doc: WorkflowDocument, rand: Rand): WorkflowOp | undefined {
  const jobs = doc.jobs();
  const job = pick(rand, jobs);
  if (!job) return undefined;
  const ops = { ...JOB_OPS, ...MORE_OPS };
  const kind = pick(rand, Object.keys(ops))!;
  return ops[kind]!(doc, rand, job.id, job.steps.length);
}

const EVENTS = ['push', 'pull_request', 'workflow_dispatch', 'release', 'issues'];
const FILTERS = ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore'] as const;
const PATTERNS = ['main', 'release/**', 'v*', '!docs/**', '**.md', 'src/**'];
const CRONS = ['0 4 * * 1', '*/15 * * * *', '30 5 * * *'];
const MATRIX: Json[] = ['ubuntu-latest', 'macos-latest', '22', '24', 26, '3.10', true, '${{ inputs.x }}'];

const some = <T>(rand: Rand, items: readonly T[]): T[] => items.filter(() => rand() < 0.4);
const eventsIn = (doc: WorkflowDocument): string[] => {
  const on = doc.get(['on'])?.value;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((e): e is string => typeof e === 'string');
  return typeof on === 'object' && on !== null ? Object.keys(on) : [];
};

/** The trigger, matrix and rename ops: each over the document's events, the job's matrix or its ids. */
const MORE_OPS: typeof JOB_OPS = {
  addEvent: (_, rand) => ({ op: 'addEvent', file: FILE, event: pick(rand, EVENTS)! }),
  removeEvent: (doc, rand) => {
    const event = pick(rand, eventsIn(doc));
    return event === undefined ? undefined : { op: 'removeEvent', file: FILE, event };
  },
  setFilter: (doc, rand) => ({
    op: 'setFilter',
    file: FILE,
    event: pick(rand, eventsIn(doc)) ?? 'push',
    filter: pick(rand, FILTERS)!,
    patterns: rand() < 0.25 ? null : some(rand, PATTERNS),
  }),
  setTypes: (doc, rand) => ({
    op: 'setTypes',
    file: FILE,
    event: pick(rand, eventsIn(doc)) ?? 'pull_request',
    types: rand() < 0.25 ? null : some(rand, ['opened', 'synchronize', 'closed']),
  }),
  switchFilter: (doc, rand) => {
    const event = pick(rand, eventsIn(doc));
    const value = event === undefined ? undefined : doc.get(['on', event])?.value;
    const keys = typeof value === 'object' && value !== null ? Object.keys(value) : [];
    const from = pick(
      rand,
      FILTERS.filter((f) => keys.includes(f)),
    );
    if (event === undefined || from === undefined) return undefined;
    const to = from.endsWith('-ignore') ? from.slice(0, -'-ignore'.length) : `${from}-ignore`;
    return { op: 'switchFilter', file: FILE, event, from, to: to as (typeof FILTERS)[number] };
  },
  setSchedule: (_, rand) => ({
    op: 'setSchedule',
    file: FILE,
    crons: some(rand, CRONS).map((cron) => (rand() < 0.5 ? { cron } : { cron, timezone: 'Europe/Berlin' })),
  }),
  setDispatchInput: (_, rand) => ({
    op: 'setDispatchInput',
    file: FILE,
    name: pick(rand, ['deploy', 'target', 'dry-run'])!,
    input:
      rand() < 0.25
        ? null
        : {
            ...(rand() < 0.5 ? { description: 'What to do' } : {}),
            ...(rand() < 0.5 ? { required: rand() < 0.5 } : {}),
            ...(rand() < 0.5 ? { type: 'choice' as const, options: some(rand, ['a', 'b', 'c']) } : {}),
            ...(rand() < 0.3 ? { default: 'a' } : {}),
          },
  }),
  setMatrixDim: (_, rand, job) => ({
    op: 'setMatrixDim',
    file: FILE,
    job,
    dim: pick(rand, ['os', 'node', 'python'])!,
    values: rand() < 0.2 ? null : some(rand, MATRIX),
  }),
  setMatrixEntry: (doc, rand, job) => {
    const list = pick(rand, ['include', 'exclude'] as const)!;
    const items = doc.get(['jobs', job, 'strategy', 'matrix', list])?.value;
    const length = Array.isArray(items) ? items.length : 0;
    const index = length > 0 && rand() < 0.6 ? at(rand, length) : 'append';
    const entry =
      rand() < 0.3 ? null : { os: pick(rand, ['linux', 'windows'])!, ...(rand() < 0.5 ? { node: 26 } : {}) };
    return { op: 'setMatrixEntry', file: FILE, job, list, index, entry };
  },
  setStrategyField: (_, rand, job) => ({
    op: 'setStrategyField',
    file: FILE,
    job,
    field: pick(rand, ['fail-fast', 'max-parallel'] as const)!,
    value: pick(rand, [true, false, 'false', 2, '3', '${{ inputs.n }}', null])!,
  }),
  renameJob: (_, rand, job) => ({
    op: 'renameJob',
    file: FILE,
    job,
    to: `${job.slice(0, 3)}_${at(rand, 1e6)}`,
  }),
  renameStepId: (doc, rand, job, steps) => {
    const index = at(rand, steps);
    return steps > 0
      ? {
          op: 'renameStepId',
          file: FILE,
          job,
          index,
          fp: fingerprint(doc, job, index),
          to: `s_${at(rand, 1e6)}`,
        }
      : undefined;
  },
};

/** What the worker would find for a rename, built from the document (E2's `referencesOf` by its structure). */
function refsFor(doc: WorkflowDocument, op: WorkflowOp) {
  if (op.op === 'renameJob') return jobReferences(doc, op.job);
  if (op.op === 'renameStepId') return stepReferences(doc, op.job, op.index);
  return undefined;
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
    const refs = refsFor(doc, op);
    const result = planOp(op, { doc: () => doc, ...(refs ? { refs } : {}) });
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
