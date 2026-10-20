import type { Json } from '@simulci/document';
import type { NewStep, WorkflowOp } from '../src/ops/types';

/**
 * The job and step ops' meaning over plain JSON, written apart from the ops: what the property compares the text's
 * new value with. `needs` compare as lists (`needs: a` is `[a]` to GitHub).
 */
type Map = Record<string, unknown>;
const isMap = (v: unknown): v is Map => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

type Style = { ifWrapped: boolean };
type Of<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;
type Apply = (root: Map, jobs: Map, op: never, style: Style) => void;

export function opExpected(js: unknown, op: WorkflowOp, style: Style): unknown {
  const root = clone(js) as Map;
  const jobs = isMap(root.jobs) ? root.jobs : {};
  MODEL[op.op]?.(root, jobs, op as never, style);
  return normalize(root);
}

const stepsOf = (jobs: Map, job: string): unknown[] => (jobs[job] as Map).steps as unknown[];

const MODEL: Partial<Record<WorkflowOp['op'], Apply>> = {
  setWorkflowField: (root, _, op: Of<'setWorkflowField'>) => setOrDelete(root, op.field, op.value),
  addJob: (root, jobs, op: Of<'addJob'>, style) => {
    root.jobs = { ...jobs, [op.id]: newJob(op.job, style) };
  },
  removeJob: (_, jobs, op: Of<'removeJob'>) => {
    delete jobs[op.job];
    for (const other of Object.values(jobs)) if (isMap(other)) dropNeed(other, op.job);
  },
  setJobField: (_, jobs, op: Of<'setJobField'>, style) =>
    setOrDelete(jobs[op.job] as Map, op.field, fieldValue(op.field, op.value, style)),
  setNeeds: (_, jobs, op: Of<'setNeeds'>) =>
    setOrDelete(jobs[op.job] as Map, 'needs', op.needs.length === 0 ? null : op.needs),
  setOutput: (_, jobs, op: Of<'setOutput'>) => setPair(jobs[op.job] as Map, 'outputs', op.name, op.value),
  setBinding: (_, jobs, op: Of<'setBinding'>) => {
    const owner = op.step ? stepMap(stepsOf(jobs, op.job), op.step.index, op.value) : (jobs[op.job] as Map);
    if (owner) setPair(owner, op.kind, op.name, op.value);
  },
  addStep: (_, jobs, op: Of<'addStep'>, style) => {
    const job = jobs[op.job] as Map;
    job.steps = [...(Array.isArray(job.steps) ? job.steps : [])].toSpliced(
      op.index,
      0,
      newStep(op.step, style),
    );
  },
  removeStep: (_, jobs, op: Of<'removeStep'>) => {
    const steps = stepsOf(jobs, op.job).toSpliced(op.index, 1);
    (jobs[op.job] as Map).steps = steps.length === 0 ? null : steps;
  },
  moveStep: (_, jobs, op: Of<'moveStep'>) => {
    const steps = [...stepsOf(jobs, op.job)];
    const [step] = steps.splice(op.from, 1);
    (jobs[op.job] as Map).steps = steps.toSpliced(op.to, 0, step);
  },
  setStepField: (_, jobs, op: Of<'setStepField'>, style) => {
    const step = stepMap(stepsOf(jobs, op.job), op.index, op.value);
    if (step) setOrDelete(step, op.field, fieldValue(op.field, op.value, style));
  },
};

/** A step as a map: an empty one (`-`) becomes one when it gets a pair; removing what it lacks changes nothing. */
function stepMap(steps: unknown[], index: number, value: unknown): Map | undefined {
  if (isMap(steps[index])) return steps[index];
  if (value === null) return undefined;
  steps[index] = {};
  return steps[index] as Map;
}

function setOrDelete(map: Map, key: string, value: unknown): void {
  if (value === null) delete map[key];
  else map[key] = value;
}

/** A pair of a map under a key, named as the map writes it whatever its case; the map gone when its last pair is. */
function setPair(owner: Map, kind: string, name: string, value: unknown): void {
  if (value === null && !isMap(owner[kind])) return;
  const map = isMap(owner[kind]) ? owner[kind] : {};
  const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
  setOrDelete(map, key, value);
  if (Object.keys(map).length === 0) delete owner[kind];
  else owner[kind] = map;
}

function dropNeed(job: Map, id: string): void {
  const needs = typeof job.needs === 'string' ? [job.needs] : Array.isArray(job.needs) ? job.needs : [];
  const kept = needs.filter((n) => String(n).toLowerCase() !== id.toLowerCase());
  if (kept.length === needs.length) return;
  if (kept.length === 0) delete job.needs;
  else job.needs = kept;
}

function fieldValue(field: string, value: Json | null, style: Style): unknown {
  if (typeof value !== 'string') return value;
  if (field === 'timeout-minutes' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (field === 'continue-on-error' && /^(?:true|false)$/.test(value)) return value === 'true';
  return field === 'if' ? ifValue(value, style) : value;
}

/** A condition starting with `!` is wrapped as `${{ }}` when the file wraps its conditions. */
const ifValue = (value: string, style: Style): string =>
  value.trimStart().startsWith('!') && style.ifWrapped ? `\${{ ${value.trim()} }}` : value;

function newStep(step: NewStep, style: Style): Map {
  const out: Map = { ...step };
  if (typeof step.run === 'string' && step.run.includes('\n') && !step.run.endsWith('\n'))
    out.run = `${step.run}\n`;
  if (step.if !== undefined) out.if = fieldValue('if', step.if, style);
  return out;
}

function newJob(job: Of<'addJob'>['job'], style: Style): Map {
  const out: Map = { ...job };
  if (job.steps) out.steps = job.steps.map((s) => newStep(s, style));
  if (job.needs?.length === 0) delete out.needs;
  if (job.if !== undefined) out.if = fieldValue('if', job.if, style);
  return out;
}

/** `needs: a` as `needs: [a]`, so either form compares equal. */
function normalize(root: Map): Map {
  const jobs = isMap(root.jobs) ? root.jobs : {};
  for (const job of Object.values(jobs))
    if (isMap(job) && typeof job.needs === 'string') job.needs = [job.needs];
  return root;
}

export const normalized = (js: unknown): unknown => (isMap(js) ? normalize(clone(js)) : js);
