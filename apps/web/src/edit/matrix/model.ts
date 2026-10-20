import type { Json, NodeInfo, WorkflowDocument, YamlPath } from '@simulci/document';
import type { JobPlan, Tri } from '@simulci/engine';

/**
 * What the matrix editor edits (synthesis § 4.7), as data: a job's `strategy:` read from the document of the text now,
 * the values the ops are given for what the author types, and the line that counts the legs of the plan. A part
 * written as YAML the editor cannot write in place (an expression read at run time, an alias, a merge key, a shape
 * that is not a list of values) is `fixed`: its source and why, read-only.
 */

export const strategyPath = (job: string): YamlPath => ['jobs', job, 'strategy'];
export const matrixPath = (job: string): YamlPath => [...strategyPath(job), 'matrix'];

/** A part shown as its source, read-only, with why: "Set at run time", followed by a link to edit it in YAML. */
export interface Fixed {
  source: string;
  line: number;
  why: string;
}

/** A value as the file writes it: `22`, `'3.10'`, `ubuntu-latest`. */
export interface Chip {
  value: Json;
  source: string;
}

export type Dimension =
  | { name: string; line: number; values: Chip[]; fixed?: undefined }
  | { name: string; line: number; fixed: Fixed };

/** One `key: value` of an `include` or `exclude` entry. */
export interface Pair extends Chip {
  key: string;
}

export interface Entry {
  index: number;
  line: number;
  pairs: Pair[];
}

export type Entries = { entries: Entry[]; fixed?: undefined } | { fixed: Fixed };

export interface MatrixModel {
  /** The job writes `strategy:`. */
  present: boolean;
  /**
   * The strategy, or its matrix, held as a whole (an expression, an alias, a merge key, not a map): `part` says which.
   * A matrix set at run time leaves `fail-fast` and `max-parallel` editable.
   */
  fixed?: Fixed & { part: 'strategy' | 'matrix' };
  dims: Dimension[];
  include: Entries;
  exclude: Entries;
  /** `fail-fast` as written, else GitHub's default (`true`). */
  failFast: { value: boolean; line?: number; fixed?: Fixed };
}

const NONE: Entries = { entries: [] };

export function matrixModel(doc: WorkflowDocument, job: string): MatrixModel {
  const base: MatrixModel = {
    present: false,
    dims: [],
    include: NONE,
    exclude: NONE,
    failFast: { value: true },
  };
  const strategy = doc.get(strategyPath(job));
  if (!strategy) return base;
  const held = fixedOf(strategy, 'map');
  if (held) return { ...base, present: true, fixed: { ...held, part: 'strategy' } };
  const failFast = failFastOf(doc.get([...strategyPath(job), 'fail-fast']));
  const matrix = doc.get(matrixPath(job));
  if (!matrix) return { ...base, present: true, failFast };
  const heldMatrix = fixedOf(matrix, 'map');
  if (heldMatrix) return { ...base, present: true, failFast, fixed: { ...heldMatrix, part: 'matrix' } };
  const keys = Object.keys(asMap(matrix.value));
  const dims = keys
    .filter((key) => key !== 'include' && key !== 'exclude')
    .map((key) => dimensionOf(doc, [...matrixPath(job), key], key));
  return {
    present: true,
    dims,
    include: entriesOf(doc, [...matrixPath(job), 'include']),
    exclude: entriesOf(doc, [...matrixPath(job), 'exclude']),
    failFast,
  };
}

/**
 * Why a node is shown read-only where the editor wants `kind` (`null` stands for an empty one); undefined when it can
 * be edited. An expression is set at run time; an alias or a merge key would change other places.
 */
function fixedOf(info: NodeInfo, kind: 'map' | 'seq'): Fixed | undefined {
  const at = { source: info.source, line: info.line };
  if (info.alias !== undefined) return { ...at, why: `A reference to &${info.alias}` };
  if (info.merge) return { ...at, why: 'In a map that merges another (<<:)' };
  if (info.kind === kind || info.kind === 'null') return undefined;
  if (isExpression(info.value)) return { ...at, why: RUN_TIME };
  return { ...at, why: 'Written as YAML this editor cannot show' };
}

const RUN_TIME = 'Set at run time';

const isExpression = (value: Json | undefined): boolean => typeof value === 'string' && value.includes('${{');

const asMap = (value: Json | undefined): Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};

const isScalar = (value: Json): boolean => value === null || typeof value !== 'object';

/** A dimension: a list of values written in place, else its source read-only. */
function dimensionOf(doc: WorkflowDocument, path: YamlPath, name: string): Dimension {
  const info = doc.get(path)!;
  const held = fixedOf(info, 'seq');
  if (held) return { name, line: info.line, fixed: held };
  const values = Array.isArray(info.value) ? info.value : [];
  if (!values.every(isScalar))
    return {
      name,
      line: info.line,
      fixed: { source: info.source, line: info.line, why: 'Its values are not plain values' },
    };
  return { name, line: info.line, values: values.map((value, i) => chipAt(doc, [...path, i], value)) };
}

const chipAt = (doc: WorkflowDocument, path: YamlPath, value: Json): Chip => ({
  value,
  source: doc.get(path)?.source ?? JSON.stringify(value),
});

/** `include` or `exclude`: entries of `key: value` pairs, else the list's source read-only. */
function entriesOf(doc: WorkflowDocument, path: YamlPath): Entries {
  const info = doc.get(path);
  if (!info) return NONE;
  const held = fixedOf(info, 'seq');
  if (held) return { fixed: held };
  const items = Array.isArray(info.value) ? info.value : [];
  const entries: Entry[] = [];
  for (const [index, item] of items.entries()) {
    const entry = doc.get([...path, index])!;
    if (fixedOf(entry, 'map') || entry.kind !== 'map')
      return { fixed: { source: info.source, line: info.line, why: 'Its entries are not maps' } };
    const pairs = Object.entries(asMap(item)).map(([key, value]): Pair => ({
      key,
      value,
      source: chipAt(doc, [...path, index, key], value).source,
    }));
    entries.push({ index, line: entry.line, pairs });
  }
  return { entries };
}

function failFastOf(info: NodeInfo | undefined): MatrixModel['failFast'] {
  if (!info) return { value: true };
  if (typeof info.value === 'boolean' && info.alias === undefined && !info.merge)
    return { value: info.value, line: info.line };
  const held = fixedOf(info, 'map') ?? { source: info.source, line: info.line, why: 'Not true or false' };
  return { value: true, fixed: held };
}

/**
 * The value the ops are given for a typed one (synthesis § 2.7): the text, a string, which the scalar writer quotes
 * when YAML would read it as another type (`3.10` is written `'3.10'`). Where the values beside it are all numbers, a
 * text that spells a number is that number, as `setMatrixDim` reads it (`26` into `[22, 24]`); where they are all
 * booleans, `true` and `false` are booleans.
 */
export function typedValue(text: string, values: readonly Json[] | undefined): Json {
  const typed = text.trim();
  if (!values?.length) return typed;
  if (values.every((v) => typeof v === 'number') && /^-?\d+(?:\.\d+)?$/.test(typed)) return Number(typed);
  if (values.every((v) => typeof v === 'boolean') && (typed === 'true' || typed === 'false'))
    return typed === 'true';
  return typed;
}

/** `ubuntu-latest, windows-latest` as values: split on commas, empty ones dropped. */
export function splitValues(text: string): string[] {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

const valuesOf = (chips: readonly Chip[]): Json[] => chips.map((c) => c.value);

/** A value as the author edits it: a string as it is, a number or a boolean spelled out, nothing for null. */
export const chipText = (value: Json): string =>
  value === null ? '' : typeof value === 'string' ? value : typeof value === 'object' ? '' : String(value);

/** The dimension's values with one more typed at the end. */
export const withValue = (chips: readonly Chip[], text: string): Json[] => [
  ...valuesOf(chips),
  typedValue(text, valuesOf(chips)),
];

/**
 * The dimension's values with the one at `index` typed again, or left out when the text is empty; `null` once none
 * is left, which removes the dimension (and the `matrix:` and `strategy:` it empties).
 */
export function replacedValue(chips: readonly Chip[], index: number, text: string): Json[] | null {
  const values =
    text.trim() === ''
      ? valuesOf(chips.filter((_, i) => i !== index))
      : valuesOf(chips).map((v, i) => (i === index ? typedValue(text, valuesOf(chips)) : v));
  return values.length === 0 ? null : values;
}

/**
 * The values `key` has in the matrix: its dimension's, else those of the `include` and `exclude` entries that name
 * it. What a value typed for it is typed by.
 */
function keyValues(
  model: Pick<MatrixModel, 'dims' | 'include' | 'exclude'>,
  key: string,
): Json[] | undefined {
  const same = (name: string): boolean => name.toLowerCase() === key.toLowerCase();
  const dim = model.dims.find((d) => same(d.name));
  if (dim) return dim.fixed ? undefined : valuesOf(dim.values);
  const entries = [model.include, model.exclude].flatMap((list) => (list.fixed ? [] : list.entries));
  return entries.flatMap((e) => e.pairs.filter((p) => same(p.key)).map((p) => p.value));
}

/**
 * `os=windows-latest, node=20` as pairs: split on commas, each at its first `=`; undefined when a part has no `=` or
 * no key.
 */
export function parsePairs(text: string): [key: string, value: string][] | undefined {
  const parts = splitValues(text).map((part) => {
    const at = part.indexOf('=');
    return at <= 0 ? undefined : ([part.slice(0, at).trim(), part.slice(at + 1).trim()] as [string, string]);
  });
  if (parts.length === 0 || parts.some((p) => p === undefined || p[0] === '')) return undefined;
  return parts as [string, string][];
}

/**
 * An entry with the typed pairs set over its own, each value typed by the values its key has in the matrix
 * (`node=20` into an entry of a matrix whose `node` is `[18, 20]` is the number 20, so it matches those legs).
 */
export function entryWith(
  entry: Entry | undefined,
  pairs: readonly (readonly [string, string])[],
  model: Pick<MatrixModel, 'dims' | 'include' | 'exclude'>,
): Record<string, Json> {
  const own = Object.fromEntries((entry?.pairs ?? []).map((p) => [p.key, p.value]));
  const typed = pairs.map(([key, text]) => [key, typedValue(text, keyValues(model, key))]);
  return { ...own, ...Object.fromEntries(typed) };
}

/** An entry without `key`; `null`, which removes the entry, when it was its last pair. */
export function entryWithout(entry: Entry, key: string): Record<string, Json> | null {
  const pairs = entry.pairs.filter((p) => p.key !== key);
  return pairs.length === 0 ? null : Object.fromEntries(pairs.map((p) => [p.key, p.value]));
}

/** GitHub runs at most this many jobs from one matrix. */
const MAX_LEGS = 256;

const LEG_WORDS: Record<Tri, string> = { yes: 'run', no: 'skipped', maybe: 'might run' };

/**
 * The live line (synthesis § 4.7), from the plan's `MatrixPlan` and legs: "6 legs: 4 run · 2 skipped". A skipped job
 * has no legs in the plan, so all of them are skipped. Undefined for a job without a matrix in the plan.
 */
export function legLine(job: JobPlan): string | undefined {
  const { matrix } = job;
  if (!matrix) return undefined;
  if (matrix.dynamic) return 'The legs are set at run time.';
  if (matrix.count === undefined) return 'Too many combinations to list the legs.';
  const n = matrix.count;
  const counts: Record<Tri, number> = { yes: 0, no: 0, maybe: 0 };
  if (job.runs.verdict === 'no') counts.no = n;
  else for (const leg of job.legs) counts[leg.runs.verdict]++;
  const parts = (['yes', 'maybe', 'no'] as const)
    .filter((v) => counts[v] > 0)
    .map((v) => `${counts[v]} ${LEG_WORDS[v]}`);
  return `${n} ${n === 1 ? 'leg' : 'legs'}${parts.length ? `: ${parts.join(' · ')}` : ''}`;
}

/** The `matrix-limit` warning: the matrix makes more legs than GitHub runs, or too many to list. */
export function legLimit(job: JobPlan): string | undefined {
  const { matrix } = job;
  if (!matrix || matrix.dynamic) return undefined;
  if (matrix.count === undefined)
    return `${job.jobId}'s matrix makes too many combinations; GitHub runs at most ${MAX_LEGS} jobs from one matrix.`;
  return matrix.count > MAX_LEGS
    ? `${job.jobId}'s matrix makes ${matrix.count} legs; GitHub runs at most ${MAX_LEGS} jobs from one matrix.`
    : undefined;
}
