import type { WorkflowOp } from '../src/ops/types';

/**
 * The trigger, matrix and rename ops' meaning over plain JSON, written apart from the ops, for the op-sequence
 * property (`ops-model.ts` holds the job and step ops').
 */
type Map = Record<string, unknown>;
type Of<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;
export type Apply = (root: Map, jobs: Map, op: never) => void;

const isMap = (v: unknown): v is Map => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `on:` as a map of its events, each with no value when it was a scalar or a list. */
function onMap(root: Map): Map {
  const on = root.on;
  if (isMap(on)) return on;
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? (on as string[]) : [];
  root.on = Object.fromEntries(events.map((e) => [e, null]));
  return root.on as Map;
}

/** An entry out, and each collection above it that it leaves empty, down to paths of `top` segments. */
function dropUp(root: Map, path: (string | number)[], top: number): void {
  for (let n = path.length; n >= top; n--) {
    const parent = path.slice(0, n - 1).reduce<unknown>((at, k) => (at as Map)[k as string], root);
    const key = path[n - 1]!;
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Map)[String(key)];
    const left = Array.isArray(parent) ? parent.length : Object.keys(parent as Map).length;
    if (left > 0 || n - 1 < top) return;
  }
}

/** An entry out; a map it leaves empty is left with no value, as `on:` and its events are. */
function dropToNull(root: Map, path: string[]): void {
  const parent = path.slice(0, -1).reduce<unknown>((at, k) => (at as Map)[k], root) as Map;
  delete parent[path.at(-1)!];
  if (Object.keys(parent).length > 0) return;
  const holder = path.slice(0, -2).reduce<unknown>((at, k) => (at as Map)[k], root) as Map;
  holder[path.at(-2)!] = null;
}

/** A key under an event, set or removed with `null`; removing the last leaves the event with no value. */
function eventKey(root: Map, event: string, key: string, values: unknown): void {
  if (values === null) {
    const on = root.on;
    if (!isMap(on) || !isMap(on[event]) || !(key in on[event])) return;
    delete on[event][key];
    if (Object.keys(on[event]).length === 0) on[event] = null;
    return;
  }
  const on = onMap(root);
  on[event] = { ...(isMap(on[event]) ? on[event] : {}), [key]: values };
}

/** A key of a map as the map writes it whatever its case, or the name itself. */
const keyIn = (map: unknown, name: string): string =>
  (isMap(map) ? Object.keys(map) : []).find((k) => same(k, name)) ?? name;

const INPUT_KEYS = ['description', 'required', 'default', 'type', 'options'];

const strategy = (jobs: Map, job: string): Map | undefined =>
  isMap((jobs[job] as Map).strategy) ? ((jobs[job] as Map).strategy as Map) : undefined;

function ensure(map: Map, key: string): Map {
  if (!isMap(map[key])) map[key] = {};
  return map[key] as Map;
}

const numeric = (v: unknown) => typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim());

export const MORE_MODEL: Partial<Record<WorkflowOp['op'], Apply>> = {
  addEvent: (root, _, op: Of<'addEvent'>) => {
    const on = root.on;
    if (on === undefined || on === null) root.on = op.event;
    else if (typeof on === 'string') root.on = on === op.event ? on : [on, op.event];
    else if (Array.isArray(on)) root.on = on.includes(op.event) ? on : [...on, op.event];
    else if (isMap(on) && !(op.event in on)) on[op.event] = null;
  },
  removeEvent: (root, _, op: Of<'removeEvent'>) => {
    const on = root.on;
    if (typeof on === 'string' && on === op.event) root.on = null;
    else if (Array.isArray(on) && on.includes(op.event)) {
      const left = on.filter((e) => e !== op.event);
      root.on = left.length === 0 ? null : left;
    } else if (isMap(on) && op.event in on) {
      delete on[op.event];
      if (Object.keys(on).length === 0) root.on = null;
    }
  },
  setFilter: (root, _, op: Of<'setFilter'>) => eventKey(root, op.event, op.filter, op.patterns),
  setTypes: (root, _, op: Of<'setTypes'>) => eventKey(root, op.event, 'types', op.types),
  switchFilter: (root, _, op: Of<'switchFilter'>) => {
    const event = (root.on as Map)[op.event] as Map;
    event[op.to] = event[op.from];
    delete event[op.from];
  },
  setSchedule: (root, _, op: Of<'setSchedule'>) => {
    if (op.crons.length === 0) {
      if (isMap(root.on) && 'schedule' in root.on) dropToNull(root, ['on', 'schedule']);
      return;
    }
    const on = onMap(root);
    const old = Array.isArray(on.schedule) ? (on.schedule as Map[]) : [];
    on.schedule = op.crons.map(({ cron, timezone }, i) => {
      const item: Map = i < old.length ? { ...old[i], cron } : { cron };
      if (timezone === undefined) delete item.timezone;
      else item.timezone = timezone;
      return item;
    });
  },
  setDispatchInput: (root, _, op: Of<'setDispatchInput'>) => {
    const inputs = isMap(root.on)
      ? ((root.on.workflow_dispatch as Map | null)?.inputs ?? undefined)
      : undefined;
    const name = keyIn(inputs, op.name);
    if (op.input === null) removeInput(root, inputs, name);
    else setInput(root, isMap(inputs) && name in inputs, name, op.input as Map);
  },
  setMatrixDim: (_, jobs, op: Of<'setMatrixDim'>) => {
    const matrix = strategy(jobs, op.job)?.matrix;
    const dim = keyIn(matrix, op.dim);
    if (op.values === null || op.values.length === 0) {
      if (isMap(matrix) && dim in matrix) dropUp({ jobs }, ['jobs', op.job, 'strategy', 'matrix', dim], 3);
      return;
    }
    const before = isMap(matrix) ? matrix[dim] : undefined;
    const numbers = Array.isArray(before) && before.length > 0 && before.every((v) => typeof v === 'number');
    const values = op.values.map((v) => (numbers && numeric(v) ? Number(v) : v));
    ensure(ensure(jobs[op.job] as Map, 'strategy'), 'matrix')[dim] = values;
  },
  setMatrixEntry: (_, jobs, op: Of<'setMatrixEntry'>) => {
    const path = ['jobs', op.job, 'strategy', 'matrix', op.list];
    if (op.entry === null) {
      if (op.index !== 'append') dropUp({ jobs }, [...path, op.index], 3);
      return;
    }
    const matrix = ensure(ensure(jobs[op.job] as Map, 'strategy'), 'matrix');
    const list = Array.isArray(matrix[op.list]) ? (matrix[op.list] as unknown[]) : [];
    matrix[op.list] = op.index === 'append' ? [...list, op.entry] : list.with(op.index, { ...op.entry });
  },
  setStrategyField: (_, jobs, op: Of<'setStrategyField'>) => {
    if (op.value === null) {
      if (strategy(jobs, op.job) && op.field in strategy(jobs, op.job)!)
        dropUp({ jobs }, ['jobs', op.job, 'strategy', op.field], 3);
      return;
    }
    let value: unknown = op.value;
    if (op.field === 'max-parallel' && numeric(value)) value = Number(value);
    if (op.field === 'fail-fast' && (value === 'true' || value === 'false')) value = value === 'true';
    ensure(jobs[op.job] as Map, 'strategy')[op.field] = value;
  },
  renameJob: (root, jobs, op: Of<'renameJob'>) => {
    for (const job of Object.values(jobs)) {
      if (!isMap(job)) continue;
      if (typeof job.needs === 'string' && same(job.needs, op.job)) job.needs = op.to;
      if (Array.isArray(job.needs))
        job.needs = job.needs.map((n) => (typeof n === 'string' && same(n, op.job) ? op.to : n));
    }
    rewriteReads(
      root,
      [],
      (path) => (path[0] === 'on' && path[2] === 'outputs' ? ['needs', 'jobs'] : ['needs']),
      op.job,
      op.to,
    );
    root.jobs = Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [id === op.job ? op.to : id, job]),
    );
  },
  renameStepId: (_, jobs, op: Of<'renameStepId'>) => {
    const step = ((jobs[op.job] as Map).steps as unknown[])[op.index];
    const old = isMap(step) ? step.id : undefined;
    const map: Map = isMap(step) ? step : {};
    map.id = op.to;
    ((jobs[op.job] as Map).steps as unknown[])[op.index] = map;
    if (typeof old === 'string') rewriteReads(jobs[op.job], ['jobs', op.job], () => ['steps'], old, op.to);
  },
};

/** An input out; `inputs:` with its last one, the event left with no value when that was all it had. */
function removeInput(root: Map, inputs: unknown, name: string): void {
  if (!isMap(inputs) || !(name in inputs)) return;
  delete inputs[name];
  if (Object.keys(inputs).length === 0) dropToNull(root, ['on', 'workflow_dispatch', 'inputs']);
}

/**
 * An input set: one there patched key by key, left with no value when its keys all go (one that had none, as it
 * was); a new one written whole.
 */
function setInput(root: Map, exists: boolean, name: string, given: Map): void {
  const all = ensure(ensure(onMap(root), 'workflow_dispatch'), 'inputs');
  const input: Map = isMap(all[name]) ? { ...all[name] } : {};
  for (const key of INPUT_KEYS) {
    if (given[key] === undefined) delete input[key];
    else input[key] = given[key];
  }
  const had = isMap(all[name]) ? Object.keys(all[name]).length : 0;
  if (!exists || Object.keys(input).length > 0) all[name] = input;
  else if (had > 0) all[name] = null;
}

/**
 * The id written anew in every read of it in the expressions of a value's strings: `${{ }}` regions, or a whole
 * `if:` without one; through the contexts each place reads it by.
 */
function rewriteReads(
  value: unknown,
  path: (string | number)[],
  contexts: (path: (string | number)[]) => string[],
  old: string,
  to: string,
): unknown {
  if (Array.isArray(value)) {
    value.forEach((v, i) => (value[i] = rewriteReads(v, [...path, i], contexts, old, to)));
    return value;
  }
  if (isMap(value)) {
    for (const [k, v] of Object.entries(value)) value[k] = rewriteReads(v, [...path, k], contexts, old, to);
    return value;
  }
  if (typeof value !== 'string') return value;
  const name = old.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const read = new RegExp(
    `((?<![\\w.-])(?:${contexts(path).join('|')})\\s*(?:\\.\\s*|\\[\\s*'))${name}(?![\\w-])`,
    'gi',
  );
  const whole = path.at(-1) === 'if' && !value.includes('${{');
  return whole
    ? value.replace(read, `$1${to}`)
    : value.replace(/\$\{\{[\s\S]*?\}\}/g, (expr) => expr.replace(read, `$1${to}`));
}
