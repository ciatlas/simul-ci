import type { SessionState } from '../state/store';
import type { CaseResult, EngineClient } from '../worker/client';
import type { CaseRequest } from '../worker/protocol';

/**
 * Copy as test case (synthesis § 7): the focused workflow's route test, or the plan in another format, written by
 * the engine in the worker from the scenario and the assumptions in the store, simulated again (the worker keeps no
 * plan). The case is the engine's `simulci plan --as-test`: the scenario as the author gave it, every maybe a
 * `# <unit>: maybe — <unknown> → pin: …` comment (`→ (no pin: …)` when nothing can pin it) and `allowMaybe: true`,
 * so it passes as a record of what is open.
 */

export type CaseFormat = 'jobs' | 'steps' | 'text' | 'mermaid';

export interface FormatInfo {
  format: CaseFormat;
  label: string;
  /** The download's media type. */
  type: string;
}

/**
 * In the dialog's order; the first is the default. A case is about the focused workflow; the plan formats show every
 * workflow the scenario reaches, as `simulci plan` prints them.
 */
export const CASE_FORMATS: readonly FormatInfo[] = [
  { format: 'jobs', label: 'Test case (jobs)', type: 'application/yaml' },
  { format: 'steps', label: 'Test case (steps)', type: 'application/yaml' },
  { format: 'text', label: 'Plan as text', type: 'text/plain' },
  { format: 'mermaid', label: 'Plan as Mermaid', type: 'text/plain' },
];

export const formatInfo = (format: CaseFormat): FormatInfo =>
  CASE_FORMATS.find((f) => f.format === format) ?? CASE_FORMATS[0]!;

export const isTestFormat = (format: CaseFormat): boolean => format === 'jobs' || format === 'steps';

/** Where `simulci test` looks for route tests (`@simulci/node`'s `TESTS_DIR`; a test keeps the two equal). */
export const TESTS_DIR = '.github/simulci/tests';

type Inputs = Pick<SessionState, 'plan' | 'focus' | 'project' | 'scenario' | 'assume'>;

export type CaseAvailability =
  | { ok: true; workflow: string; project: number }
  | { ok: false; reason: string };

/**
 * Whether a case can be asked for: a project loaded, a plan for it, and a focused workflow the plan holds at depth
 * 0 (a case is about a workflow an event starts, never a callee).
 */
export function caseAvailability(s: Pick<SessionState, 'plan' | 'focus' | 'project'>): CaseAvailability {
  if (s.project.status !== 'ready' || s.project.version === undefined || !s.plan)
    return { ok: false, reason: 'no plan yet' };
  const { focus } = s;
  if (focus === undefined) return { ok: false, reason: 'no workflow picked' };
  const known = s.plan.plan.workflows.some((w) => w.depth === 0 && w.path === focus);
  return known
    ? { ok: true, workflow: focus, project: s.project.version }
    : { ok: false, reason: `no workflow ${focus} in the plan` };
}

/** The `case` request for a format, or nothing while a case cannot be asked for. */
export function caseBody(s: Inputs, format: CaseFormat): CaseBody | undefined {
  const available = caseAvailability(s);
  return available.ok ? bodyOf(s, available, format) : undefined;
}

type CaseBody = Omit<CaseRequest, 'id' | 'type'>;

function bodyOf(s: Inputs, available: Extract<CaseAvailability, { ok: true }>, format: CaseFormat): CaseBody {
  return {
    project: available.project,
    workflow: available.workflow,
    scenario: s.scenario,
    assume: s.assume,
    detail: format === 'steps' ? 'steps' : 'jobs',
    format: isTestFormat(format) ? 'test' : format === 'text' ? 'text' : 'mermaid',
  };
}

/**
 * What the dialog shows for an answer. `maybes` counts the case's maybe comments; `errors` are the headlines of the
 * error diagnostics of the plan the case was written from, each of which makes `simulci test` report the case
 * invalid (a mock that matches nothing, a conflict). Both are empty for the plan formats.
 */
export type CaseOutcome =
  | { type: 'case'; text: string; maybes: number; errors: string[] }
  | { type: 'failed'; message: string }
  | { type: 'superseded' };

export function outcomeOf(result: CaseResult): CaseOutcome {
  if (result.type === 'superseded') return result;
  if (result.type === 'case')
    return {
      type: 'case',
      text: result.text,
      maybes: result.case?.comments.length ?? 0,
      errors: (result.errors ?? []).map((e) => `${e.code} ${e.message}`),
    };
  if (result.type === 'invalid')
    return { type: 'failed', message: `the ${result.what} is not valid: ${messagesOf(result.issues)}` };
  if (result.kind === 'stale') return { type: 'failed', message: 'the files were loaded again; try again' };
  return { type: 'failed', message: result.message };
}

const messagesOf = (issues: { path: (string | number)[]; message: string }[]): string =>
  issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');

/** Asks the worker for the case in a format, from the inputs the store holds now. */
export async function requestCase(
  client: Pick<EngineClient, 'case'>,
  s: Inputs,
  format: CaseFormat,
): Promise<CaseOutcome> {
  const available = caseAvailability(s);
  if (!available.ok) return { type: 'failed', message: available.reason };
  return outcomeOf(await client.case(bodyOf(s, available, format)));
}

/** `ci` for `.github/workflows/ci.yml` or `ci.yaml`. */
const stemOf = (workflow: string): string => workflow.replace(/^.*\//, '').replace(/\.ya?ml$/i, '');

/** Where the case belongs in the repository: `.github/simulci/tests/ci.test.yml`. */
export const testFilePath = (workflow: string): string => `${TESTS_DIR}/${stemOf(workflow)}.test.yml`;

/** The name a download takes: `ci.test.yml` for a case, `plan.txt` and `plan.mmd` for the whole plan. */
export function downloadName(workflow: string, format: CaseFormat): string {
  if (isTestFormat(format)) return `${stemOf(workflow)}.test.yml`;
  return format === 'text' ? 'plan.txt' : 'plan.mmd';
}

/** Where the text goes and what reads it, for the line under it. */
export interface Destination {
  /** The file to save a case as; the plan formats have none. */
  path?: string;
  command: string;
}

export function destinationOf(workflow: string, format: CaseFormat): Destination {
  if (isTestFormat(format)) return { path: testFilePath(workflow), command: 'simulci test' };
  return { command: format === 'text' ? 'simulci plan' : 'simulci plan --format mermaid' };
}
