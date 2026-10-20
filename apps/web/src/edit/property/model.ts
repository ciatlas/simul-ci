import type {
  Fp,
  Json,
  JobField,
  NodeInfo,
  StepField,
  WorkflowDocument,
  WorkflowOp,
  YamlPath,
} from '@simulci/document';

/**
 * What Properties edits (synthesis § 4.4), as data: the fields of the workflow, a job and a step, what each shows from
 * the document of the text now, and how the text the author types becomes the value of its op. The values are the
 * file's, not the plan's: the plan lags the text by a load, and evaluates what the file only says.
 */

/**
 * How a field reads what is typed: `text` a string, `lines` a multi-line string (`run`), `expression` a condition,
 * `number` a number or an expression, `flag` true or false or an expression, `labels` one runner label or several
 * separated by commas, `value` a binding's value (`with`, `env`, `outputs`), which an empty text does not remove.
 */
export type FieldKind = 'text' | 'lines' | 'expression' | 'number' | 'flag' | 'labels' | 'value';

export interface FieldSpec {
  /** The key it writes, which names it in the group key and the `i` key's request. */
  key: string;
  label: string;
  kind: FieldKind;
  /** Where its value is, in the document. */
  path: YamlPath;
  /** The op that writes a value (`null` removes the key), with the step's fingerprint read when the session began. */
  op: (value: Json | null, fp?: Fp) => WorkflowOp;
  placeholder?: string;
}

/** The workflow's own fields; its `on:` is the triggers editor's. */
export function workflowFields(file: string): FieldSpec[] {
  const field = (key: 'name' | 'run-name', label: string, placeholder: string): FieldSpec => ({
    key,
    label,
    kind: 'text',
    path: [key],
    op: (value) => ({
      op: 'setWorkflowField',
      file,
      field: key,
      value: value === null ? null : asText(value),
    }),
    placeholder,
  });
  return [field('name', 'Name', 'the file name'), field('run-name', 'Run name', 'the workflow name')];
}

/** A job's fields; a job that calls a reusable workflow has `uses` and none of a runner's. */
export function jobFields(file: string, job: string, call: boolean): FieldSpec[] {
  const field = (key: JobField, label: string, kind: FieldKind, placeholder?: string): FieldSpec => ({
    key,
    label,
    kind,
    path: ['jobs', job, key],
    op: (value) => ({ op: 'setJobField', file, job, field: key, value }),
    ...(placeholder ? { placeholder } : {}),
  });
  const name = field('name', 'Name', 'text', job);
  const runIf = field('if', 'Run if', 'expression', 'success()');
  if (call) return [name, field('uses', 'Uses', 'text'), runIf];
  return [
    name,
    field('runs-on', 'Runs on', 'labels'),
    runIf,
    field('environment', 'Environment', 'text'),
    field('continue-on-error', 'Continue on error', 'flag', 'false'),
    field('timeout-minutes', 'Timeout (minutes)', 'number', '360'),
  ];
}

/** A step's fields: an action's `uses`, or a script's `run`, `shell` and `working-directory`. */
export function stepFields(file: string, job: string, index: number, action: boolean): FieldSpec[] {
  const field = (key: StepField, label: string, kind: FieldKind, placeholder?: string): FieldSpec => ({
    key,
    label,
    kind,
    path: ['jobs', job, 'steps', index, key],
    op: (value, fp) => ({ op: 'setStepField', file, job, index, fp: fp ?? {}, field: key, value }),
    ...(placeholder ? { placeholder } : {}),
  });
  const kind = action
    ? [field('uses', 'Uses', 'text')]
    : [
        field('run', 'Run', 'lines'),
        field('shell', 'Shell', 'text', 'bash'),
        field('working-directory', 'Working directory', 'text'),
      ];
  return [
    field('name', 'Name', 'text'),
    ...kind,
    field('if', 'Run if', 'expression', 'success()'),
    field('continue-on-error', 'Continue on error', 'flag', 'false'),
    field('timeout-minutes', 'Timeout (minutes)', 'number'),
  ];
}

/**
 * What a field shows: the value as the file writes it, without YAML's quotes or a block scalar's header, and its
 * line. `fixed` says why the field only shows its source: an alias or a merge key on the way, which the edit's own
 * refusal explains (`probe`), or a shape the field cannot write.
 */
export interface Shown {
  text: string;
  line?: number;
  fixed?: { source: string; why?: string; probe?: true };
}

export function shown(doc: WorkflowDocument, spec: FieldSpec): Shown {
  // A key that is not written may still be out of reach: in a map that merges another (`<<:`), or behind an alias.
  const info = doc.get(spec.path) ?? held(doc.get(spec.path.slice(0, -1)));
  if (!info) return { text: '' };
  if (info.alias !== undefined || info.merge) {
    const fixed: NonNullable<Shown['fixed']> = { source: info.source, probe: true };
    if (info.merge)
      fixed.why = `${spec.label} is in a map that merges another (\`<<:\`); edit it in the YAML pane.`;
    return { text: info.source, line: info.line, fixed };
  }
  const text = textOf(info, spec.kind);
  if (text !== undefined) return { text, line: info.line };
  return {
    text: info.source,
    line: info.line,
    fixed: {
      source: info.source,
      why: `${spec.label} is written as YAML this field cannot show; edit it in the YAML pane.`,
    },
  };
}

/** The map a field's key would go in, when no edit may write there. */
const held = (parent: NodeInfo | undefined): NodeInfo | undefined =>
  parent && (parent.alias !== undefined || parent.merge) ? parent : undefined;

/** The value as the field shows it; undefined for a shape the field cannot show (a map, a nested list). */
function textOf(info: NodeInfo, kind: FieldKind): string | undefined {
  const { value } = info;
  if (value === null || value === undefined) return '';
  if (kind === 'labels' && Array.isArray(value) && value.every(isScalar)) return value.join(', ');
  if (!isScalar(value)) return undefined;
  const text = String(value);
  // A `run: |` keeps its final line break, which the op adds back.
  return kind === 'lines' ? text.replace(/\r?\n$/, '') : text;
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/**
 * The value of an op from what is typed: nothing removes the key; a number field reads digits as a number, a flag
 * `true` and `false` as booleans, a labels field commas as a list (or keeps a list a list); anything else is the
 * string, an expression included.
 */
export function valueOf(kind: FieldKind, typed: string, current: Json | undefined): Json | null {
  if (kind === 'value') return bindingValue(typed, current);
  const text = kind === 'lines' ? typed : typed.trim();
  if (text === '') return null;
  if (kind === 'number' && /^\d+(\.\d+)?$/.test(text)) return Number(text);
  if (kind === 'flag' && (text === 'true' || text === 'false')) return text === 'true';
  if (kind === 'labels' && (text.includes(',') || Array.isArray(current)))
    return text
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label !== '');
  return text;
}

/**
 * A binding's value (`with`, `env`, `outputs`) from what is typed: a number or a boolean the file has stays one when
 * the text spells the same value, so editing `node-version: 20` to 22 writes 22; anything else is a string, which the
 * scalar writer quotes when YAML would read it as another type (`'3.10'`).
 */
export function bindingValue(typed: string, current: Json | undefined): Json {
  if (typeof current === 'number' && /^-?\d+(\.\d+)?$/.test(typed) && String(Number(typed)) === typed)
    return Number(typed);
  if (typeof current === 'boolean' && (typed === 'true' || typed === 'false')) return typed === 'true';
  return typed;
}

/** A value as text: a string as it is, anything else as JSON (`30`, `true`, `[a, b]`). */
export const asText = (value: Json): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** The group a field's focus session commits under: one undo entry per session. */
export const groupKey = (file: string, path: YamlPath): string => `field:${file}:${path.join('.')}`;
