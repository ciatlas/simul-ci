/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import {
  AssumeListSchema,
  caseFromPlan,
  fileFromPlan,
  type LoadedProject,
  loadFiles,
  parseScenario,
  renderMermaid,
  renderText,
  ScenarioError,
  ScenarioInputSchema,
  simulate,
} from '@simulci/engine';
import { deriveTables } from './derived';
import { outlineOf } from './outline';
import type {
  CaseRequest,
  EngineRequest,
  EngineResponse,
  InvalidResponse,
  LoadRequest,
  Outline,
  SimulateRequest,
} from './protocol';

/** The worker's state: one loaded project, numbered so a reply can be told from a stale one. */
export interface WorkerState {
  project?: { version: number; loaded: LoadedProject; outline: Outline };
  nextVersion: number;
}

export const initialState = (): WorkerState => ({ nextVersion: 1 });

/** One request to one response, pure over the state: the worker and its tests call it. */
export function handle(
  state: WorkerState,
  request: EngineRequest,
): { state: WorkerState; response: EngineResponse } {
  try {
    if (request.type === 'load') return load(state, request);
    if (!state.project || state.project.version !== request.project) {
      return {
        state,
        response: {
          id: request.id,
          type: 'error',
          kind: 'stale',
          message: `project ${request.project} is not loaded`,
        },
      };
    }
    const invalid = validate(request);
    if (invalid) return { state, response: invalid };
    return {
      state,
      response: request.type === 'simulate' ? plan(state.project, request) : testCase(state.project, request),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const response: EngineResponse = { id: request.id, type: 'error', kind: 'engine', message };
    if (e instanceof Error && e.stack) response.stack = e.stack;
    return { state, response };
  }
}

function load(state: WorkerState, request: LoadRequest): { state: WorkerState; response: EngineResponse } {
  const started = performance.now();
  try {
    const loaded = loadFiles(request.files, request.repository);
    const outline = outlineOf(loaded);
    const version = state.nextVersion;
    return {
      state: { project: { version, loaded, outline }, nextVersion: version + 1 },
      response: {
        id: request.id,
        type: 'loaded',
        project: version,
        outline,
        ms: performance.now() - started,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { state, response: { id: request.id, type: 'error', kind: 'load', message } };
  }
}

/** The scenario and the mocks checked before the engine sees them, so a mistake comes back with its path. */
function validate(request: SimulateRequest | CaseRequest): InvalidResponse | undefined {
  const scenario = ScenarioInputSchema.safeParse(request.scenario);
  if (!scenario.success)
    return { id: request.id, type: 'invalid', what: 'scenario', issues: issuesOf(scenario.error.issues) };
  const assume = AssumeListSchema.safeParse(request.assume);
  if (!assume.success)
    return { id: request.id, type: 'invalid', what: 'assume', issues: issuesOf(assume.error.issues) };
  try {
    parseScenario(request.scenario);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    return { id: request.id, type: 'invalid', what: 'scenario', issues: [{ path: [], message: e.message }] };
  }
  return undefined;
}

interface ZodIssueLike {
  path: PropertyKey[];
  message: string;
  /** zod 4: the issues of each union member that was tried. */
  errors?: ZodIssueLike[][];
}

/** The leaf issues: a union's own "Invalid input" says less than the issues of the member that was meant. */
const issuesOf = (issues: ZodIssueLike[]): InvalidResponse['issues'] =>
  issues
    .flatMap((i) => leaves(i, []))
    .map((i) => ({
      path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
      message: i.message,
    }));

/** A member's issues have paths relative to the union; they are returned under the full path. */
function leaves(issue: ZodIssueLike, prefix: PropertyKey[]): ZodIssueLike[] {
  const path = [...prefix, ...issue.path];
  const nested = (issue.errors ?? []).flat().flatMap((e) => leaves(e, path));
  return nested.length ? nested : [{ ...issue, path }];
}

function plan(project: NonNullable<WorkerState['project']>, request: SimulateRequest): EngineResponse {
  const started = performance.now();
  const result = simulate({
    project: project.loaded,
    scenario: request.scenario,
    assume: request.assume,
    detail: request.detail,
  });
  const simulated = performance.now();
  const derived = deriveTables(result, project.outline);
  const text = renderText(result);
  return {
    id: request.id,
    type: 'plan',
    project: project.version,
    plan: result,
    derived,
    text,
    ms: { simulate: simulated - started, derive: performance.now() - simulated },
  };
}

function testCase(project: NonNullable<WorkerState['project']>, request: CaseRequest): EngineResponse {
  const known = project.outline.workflows.some(
    (w) => w.path === request.workflow || w.path.endsWith(`/${request.workflow}`),
  );
  if (!known)
    return {
      id: request.id,
      type: 'invalid',
      what: 'workflow',
      issues: [{ path: ['workflow'], message: `no workflow at ${request.workflow}` }],
    };
  const result = simulate({
    project: project.loaded,
    scenario: request.scenario,
    assume: request.assume,
    detail: 'steps',
  });
  if (request.format === 'text') return { id: request.id, type: 'case', text: renderText(result) };
  if (request.format === 'mermaid') return { id: request.id, type: 'case', text: renderMermaid(result) };
  const opts = {
    plan: result,
    workflow: request.workflow,
    scenario: request.scenario,
    assume: request.assume,
    detail: request.detail,
    ...(request.name === undefined ? {} : { name: request.name }),
  };
  return { id: request.id, type: 'case', text: fileFromPlan(opts), case: caseFromPlan(opts) };
}
