import { FeatureFlags } from '@actions/expressions/features';
import {
  isBasicExpression,
  isBoolean,
  isMapping,
  isNumber,
  isSequence,
  isString,
  NoOperationTraceWriter,
  parseWorkflow,
} from '@actions/workflow-parser';
import { convertOn } from '@actions/workflow-parser/model/converter/events';
import { handleTemplateTokenErrors } from '@actions/workflow-parser/model/converter/handle-errors';
import {
  convertToIfCondition,
  ensureStatusFunction,
} from '@actions/workflow-parser/model/converter/if-condition';
import type { EventsConfig } from '@actions/workflow-parser/model/workflow-template';
import {
  TemplateContext,
  TemplateValidationErrors,
} from '@actions/workflow-parser/templates/template-context';
import type { TemplateValidationError } from '@actions/workflow-parser/templates/template-validation-error';
import type { TemplateToken } from '@actions/workflow-parser/templates/tokens/template-token';
import { getWorkflowSchema } from '@actions/workflow-parser/workflows/workflow-schema';

/**
 * Run settings: what decides a run and is not in core's IR, read with GitHub's own parser (`@actions/workflow-parser`,
 * the one behind the Actions language service) and its converter: the events with their filters, concurrency, every
 * `if:` with the implicit `success()`, `continue-on-error`, timeouts, `fail-fast` and `max-parallel`. Joined to core's
 * IR by job id and step index: steps are numbered by their position in the YAML sequence, whatever the converter makes
 * of them.
 *
 * The converter's entry point is asynchronous (it may fetch reusable workflows); the engine is synchronous, so this
 * module walks the parsed template itself and calls the converter's synchronous pieces. Conversion errors never drop
 * a job or a step: the unit gets GitHub's defaults and the error is listed.
 */

/** A setting written as an expression, which only the run can evaluate. */
export interface Expression {
  expression: string;
}

export interface Concurrency {
  /** The group as written (`ci-${{ github.ref }}` stays as written). */
  group?: string;
  cancelInProgress?: boolean | Expression;
}

export interface StepSettings {
  /** The step's position in the job's `steps:` sequence (core's `StepDecl.index`). */
  index: number;
  /** The `if:` as GitHub evaluates it: `success()` when absent, `success() && (…)` unless a status function appears. */
  if: string;
  continueOnError?: boolean | Expression;
  timeoutMinutes?: number | Expression;
}

export interface JobSettings {
  id: string;
  if: string;
  continueOnError?: boolean | Expression;
  timeoutMinutes?: number | Expression;
  /** `strategy.fail-fast`; absent means GitHub's default, `true`. */
  failFast?: boolean | Expression;
  maxParallel?: number | Expression;
  concurrency?: Concurrency;
  steps: StepSettings[];
}

export interface SettingsDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

export interface WorkflowSettings {
  /** The events the workflow listens to, with their filters, as the converter reads `on:`. */
  events: EventsConfig;
  concurrency?: Concurrency;
  jobs: Record<string, JobSettings>;
  /** Schema and conversion errors. The settings above are still as complete as the file allowed. */
  errors: SettingsDiagnostic[];
}

const WORKFLOW_FEATURES = new FeatureFlags({ allowBackgroundSteps: true });
const DEFAULT_IF = 'success()';

/** Reads the run settings of one workflow file. Never throws: an unreadable file gives empty settings and the errors. */
export function readSettings(path: string, text: string): WorkflowSettings {
  const context = new TemplateContext(
    new TemplateValidationErrors(),
    getWorkflowSchema(),
    new NoOperationTraceWriter(),
  );
  context.state.featureFlags = WORKFLOW_FEATURES;
  const settings: WorkflowSettings = { events: {}, jobs: {}, errors: [] };
  const root = parseWorkflow({ name: path, content: text }, context).value;
  if (root && isMapping(root)) {
    for (const item of root) {
      const key = isString(item.key) ? item.key.value : undefined;
      if (key === 'on')
        settings.events = handleTemplateTokenErrors(root, context, {}, () => convertOn(context, item.value));
      else if (key === 'concurrency') settings.concurrency = readConcurrency(item.value);
      else if (key === 'jobs') settings.jobs = readJobs(context, item.value);
    }
  }
  settings.errors = context.errors.getErrors().map((e) => diagnostic(path, e));
  return settings;
}

function readJobs(context: TemplateContext, token: TemplateToken): Record<string, JobSettings> {
  const jobs: Record<string, JobSettings> = {};
  if (!isMapping(token)) return jobs;
  for (const item of token) {
    if (!isString(item.key)) continue;
    const job: JobSettings = { id: item.key.value, if: DEFAULT_IF, steps: [] };
    jobs[job.id] = job;
    if (isMapping(item.value))
      for (const prop of item.value) readJobProperty(context, job, keyOf(prop.key), prop.value);
  }
  return jobs;
}

function readJobProperty(
  context: TemplateContext,
  job: JobSettings,
  key: string | undefined,
  value: TemplateToken,
): void {
  switch (key) {
    case 'if':
      job.if = readIf(context, value);
      break;
    case 'continue-on-error':
      job.continueOnError = readBoolean(context, value, key);
      break;
    case 'timeout-minutes':
      job.timeoutMinutes = readNumber(context, value, key);
      break;
    case 'concurrency':
      job.concurrency = readConcurrency(value);
      break;
    case 'strategy':
      readStrategy(context, value, job);
      break;
    case 'steps':
      job.steps = readSteps(context, value);
      break;
    default:
      break;
  }
}

function readStrategy(context: TemplateContext, token: TemplateToken, job: JobSettings): void {
  if (!isMapping(token)) return;
  for (const prop of token) {
    const key = keyOf(prop.key);
    if (key === 'fail-fast') job.failFast = readBoolean(context, prop.value, key);
    else if (key === 'max-parallel') job.maxParallel = readNumber(context, prop.value, key);
  }
}

/** Steps are numbered by their position in the sequence, whatever the converter makes of each. */
function readSteps(context: TemplateContext, token: TemplateToken): StepSettings[] {
  if (!isSequence(token)) return [];
  const steps: StepSettings[] = [];
  for (const item of token) {
    const step: StepSettings = { index: steps.length, if: DEFAULT_IF };
    steps.push(step);
    if (isMapping(item))
      for (const prop of item) readStepProperty(context, step, keyOf(prop.key), prop.value);
  }
  return steps;
}

function readStepProperty(
  context: TemplateContext,
  step: StepSettings,
  key: string | undefined,
  value: TemplateToken,
): void {
  if (key === 'if') step.if = readIf(context, value);
  else if (key === 'continue-on-error') step.continueOnError = readBoolean(context, value, key);
  else if (key === 'timeout-minutes') step.timeoutMinutes = readNumber(context, value, key);
}

/**
 * The condition as GitHub evaluates it. The converter reads strings and expressions; a YAML boolean or number
 * (`if: false`) is read here, as the string GitHub makes of it, and wrapped by the same rule.
 */
function readIf(context: TemplateContext, token: TemplateToken): string {
  if (isBoolean(token) || isNumber(token))
    return ensureStatusFunction(String(token.value), token.definitionInfo);
  const converted = handleTemplateTokenErrors(token, context, undefined, () =>
    convertToIfCondition(context, token),
  );
  return converted?.expression ?? DEFAULT_IF;
}

function readConcurrency(token: TemplateToken): Concurrency {
  if (!isMapping(token)) {
    const group = scalarText(token);
    return group === undefined ? {} : { group };
  }
  const out: Concurrency = {};
  for (const prop of token) {
    const key = keyOf(prop.key);
    if (key === 'group') {
      const group = scalarText(prop.value);
      if (group !== undefined) out.group = group;
    } else if (key === 'cancel-in-progress') {
      const value = literal(prop.value);
      if (typeof value === 'boolean' || isExpression(value)) out.cancelInProgress = value;
    }
  }
  return out;
}

function readBoolean(
  context: TemplateContext,
  token: TemplateToken,
  key: string,
): boolean | Expression | undefined {
  const value = literal(token);
  if (typeof value === 'boolean' || isExpression(value)) return value;
  if (value === 'true' || value === 'false') return value === 'true';
  context.error(token, `'${key}' must be a boolean or an expression`);
  return undefined;
}

function readNumber(
  context: TemplateContext,
  token: TemplateToken,
  key: string,
): number | Expression | undefined {
  const value = literal(token);
  if (typeof value === 'number' || isExpression(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  context.error(token, `'${key}' must be a number or an expression`);
  return undefined;
}

const keyOf = (token: TemplateToken): string | undefined => (isString(token) ? token.value : undefined);

const isExpression = (value: unknown): value is Expression =>
  typeof value === 'object' && value !== null && 'expression' in value;

/** A scalar's value: the literal, or the expression it is. */
function literal(token: TemplateToken): string | number | boolean | Expression | null {
  if (isBasicExpression(token)) return { expression: token.expression };
  if (isBoolean(token) || isNumber(token) || isString(token)) return token.value;
  return null;
}

/** A scalar as written in the file, expressions included (`ci-${{ github.ref }}`). */
function scalarText(token: TemplateToken): string | undefined {
  if (isBasicExpression(token)) return token.source ?? `\${{ ${token.expression} }}`;
  if (isString(token) || isBoolean(token) || isNumber(token)) return String(token.value);
  return undefined;
}

function diagnostic(path: string, e: TemplateValidationError): SettingsDiagnostic {
  // The parser prefixes the file name it was given and the position; keep the message alone.
  const message = (e.message.startsWith(path) ? e.message.slice(path.length) : e.message).replace(
    /^(?: \(Line: \d+, Col: \d+\))?:\s*/,
    '',
  );
  const out: SettingsDiagnostic = { message };
  if (e.range) {
    out.line = e.range.start.line;
    out.column = e.range.start.column;
  }
  return out;
}
