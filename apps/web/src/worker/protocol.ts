import type {
  AssumeEntry,
  GeneratedCase,
  Json,
  Loc,
  NodeId,
  RunPlan,
  ScenarioInput,
  UnknownId,
} from '@simulci/engine';

/**
 * What the UI and the engine worker say to each other, version 1. The RunPlan JSON is the contract: the worker
 * loads, simulates and derives; the UI renders. Every request carries an id the reply echoes, so stale answers are
 * dropped; `PROTOCOL` is a tripwire asserted on `ready`, bumped on an incompatible change.
 */

export const PROTOCOL = 1 as const;
export const SUPPORTED_RUN_PLAN = 1 as const;

export interface LoadRequest {
  id: number;
  type: 'load';
  /** Repository files by path (`.github/workflows/ci.yml`, …). */
  files: Record<string, string>;
  /**
   * Route tests by path (`.github/simulci/tests/ci.test.yml`): never loaded into the project, only checked against
   * the test file schema, their failures reported as the Outline's `kind: 'test'` files.
   */
  tests?: Record<string, string>;
  repository?: string;
}

export interface SimulateRequest {
  id: number;
  type: 'simulate';
  /** The project version `loaded` named; a stale one is answered with `error: stale`. */
  project: number;
  scenario: ScenarioInput;
  assume: AssumeEntry[];
  detail: 'legs' | 'steps';
  /**
   * Depth-0 workflows, by path, whose jobs are planned although nothing triggers them (the engine's
   * `planUntriggered`): edit mode's focused workflow, so an edit that stops it from running leaves its jobs to edit.
   */
  planUntriggered?: string[];
}

export interface CaseRequest {
  id: number;
  type: 'case';
  project: number;
  /** The depth-0 workflow the case is about. */
  workflow: string;
  scenario: ScenarioInput;
  assume: AssumeEntry[];
  detail: 'jobs' | 'steps';
  name?: string;
  format: 'test' | 'text' | 'mermaid';
  /**
   * The `given` of the test file the case is for, which `simulci test` merges into each case's scenario and mocks: the
   * case is planned under it, its `when` still the scenario sent. One the test file schema refuses is not applied (the
   * file's own failure says why).
   */
  given?: unknown;
}

export type EngineRequest = LoadRequest | SimulateRequest | CaseRequest;

export interface ModelInfo {
  id: string;
  version: string;
  presets: string[];
}

export interface ReadyResponse {
  type: 'ready';
  protocol: typeof PROTOCOL;
  engine: { version: string; runPlan: number };
  models: ModelInfo[];
  /**
   * Every event `on:` takes, with its activity types and the ones that apply when `types:` is omitted (both empty for
   * an event without types): what the triggers editor's Add event offers. Sent once, here.
   */
  events?: Record<string, { types: string[]; default: string[] }>;
}

export interface LoadedResponse {
  id: number;
  type: 'loaded';
  project: number;
  outline: Outline;
  ms: number;
}

export interface PlanResponse {
  id: number;
  type: 'plan';
  project: number;
  plan: RunPlan;
  derived: Derived;
  /** The plan as `simulci plan` prints it. */
  text: string;
  ms: { simulate: number; derive: number };
}

export interface CaseResponse {
  id: number;
  type: 'case';
  text: string;
  case?: GeneratedCase;
  /**
   * The error diagnostics of the plan a test case was written from (a mock that matches nothing, a conflict):
   * `simulci test` reports a case invalid for any of them. Absent when there are none.
   */
  errors?: { code: string; message: string }[];
}

export interface InvalidResponse {
  id: number;
  type: 'invalid';
  what: 'scenario' | 'assume' | 'workflow';
  issues: { path: (string | number)[]; message: string }[];
}

export interface ErrorResponse {
  id: number;
  type: 'error';
  /** `stale`: another project is loaded; `load`: the files could not be loaded; `engine`: ours. */
  kind: 'stale' | 'load' | 'engine';
  message: string;
  stack?: string;
}

export type EngineResponse =
  | ReadyResponse
  | LoadedResponse
  | PlanResponse
  | CaseResponse
  | InvalidResponse
  | ErrorResponse;

/** One event under `on:`, as hints for the scenario form; never a result. */
export interface OutlineEvent {
  event: string;
  types?: { allowed: string[]; all: string[]; narrowed: boolean };
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
  crons?: string[];
  /**
   * Each of `crons` in words, as GitHub words it (the engine's `describeCron`): `Runs at 06:00, only on Monday`;
   * null for a cron GitHub would not accept, whose problem is among the file's errors.
   */
  cronText?: (string | null)[];
  workflows?: string[];
  /** The line of the event key under `on:`, and of each filter key. */
  loc?: { line: number; filters: Record<string, number> };
}

export interface OutlineInput {
  name: string;
  type?: string;
  required: boolean;
  default?: Json;
  options?: string[];
  description?: string;
}

export interface OutlineStep {
  index: number;
  id?: string;
  name?: string;
  uses?: string;
  line: number;
}

export interface OutlineJob {
  id: string;
  name?: string;
  needs: string[];
  uses?: string;
  matrix: boolean;
  steps: OutlineStep[];
  line: number;
  /** The names of the job's `outputs:`, which the jobs that need it read; absent when it declares none. */
  outputs?: string[];
}

/** The interface a reusable workflow declares under `on.workflow_call`, for the jobs that call it. */
export interface OutlineCall {
  inputs: OutlineInput[];
  outputs: string[];
  secrets: string[];
}

/** A local action (`action.yml` under its directory): what a step that uses it may pass and read. */
export interface OutlineAction {
  /** The directory `uses: ./<dir>` points at, repository-relative. */
  dir: string;
  file: string;
  name?: string;
  /** `runs.using`: `composite`, `node20`, `docker`. */
  using?: string;
  inputs: OutlineInput[];
  outputs: string[];
}

export interface OutlineWorkflow {
  path: string;
  name?: string;
  callable: boolean;
  generated?: string;
  /** In declaration order, `workflow_call` excluded. */
  events: OutlineEvent[];
  dispatch?: OutlineInput[];
  /** Its `workflow_call` interface, when other workflows may call it. */
  call?: OutlineCall;
  jobs: OutlineJob[];
  onLine: number;
}

export interface OutlineFile {
  path: string;
  kind: 'workflow' | 'action' | 'test' | 'other';
  /**
   * `yaml`: the YAML parser refused the text (core's `parseErrors`), which the edit hold watches for; `workflow`: the
   * workflow converter refused what parsed (an unknown event, a bad filter); `test`: a route test's failure as `simulci
   * test` reports it before running a case (T001 YAML, T002 schema, T103 a duplicate name), which never holds the
   * plan: no route test is in it.
   */
  errors: { line: number; column: number; message: string; source?: 'yaml' | 'workflow' | 'test' }[];
  /** Core's marker of a generated workflow or action (`DO NOT EDIT`, `.lock.yml`): the pane keeps it read-only. */
  generated?: string;
}

/** What the project holds, for the form, the outline tree and the YAML pane: hints, never results. */
export interface Outline {
  files: OutlineFile[];
  workflows: OutlineWorkflow[];
  /** The activity types of the events present, from the engine's table. */
  events: Record<string, { types: string[]; default: string[] }>;
  /** The local actions the workflows use, by directory; absent when there are none. */
  actions?: OutlineAction[];
}

/** Lookups over the plan computed by the worker with the engine's own functions, so the main thread needs no engine. */
export interface Derived {
  unitPaths: Record<NodeId, string>;
  kinds: Record<NodeId, 'workflow' | 'job' | 'leg' | 'step' | 'composite'>;
  /** The deciding clause of every node, worded as the CLI words it. */
  clauses: Record<NodeId, string>;
  /** The index of the deciding reason in the node's chain. */
  decidingIndex: Record<NodeId, number>;
  /** Where the deciding reason is written, when the plan or the outline knows. */
  decidingLoc: Record<NodeId, Loc>;
  /** The needs whose results decided a job through its `if:` (worker/deciding.ts), for jobs that have any. */
  decidingNeeds: Record<NodeId, NodeId[]>;
  unknownPaths: Record<UnknownId, string>;
}

const TYPES = new Set(['load', 'simulate', 'case']);

const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null;

/** Whether a message is a request the worker answers: the shape is checked, not trusted. */
export function isEngineRequest(data: unknown): data is EngineRequest {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'number' || typeof d.type !== 'string' || !TYPES.has(d.type)) return false;
  if (d.type === 'load') return isObject(d.files) && (d.tests === undefined || isObject(d.tests));
  return (
    typeof d.project === 'number' &&
    typeof d.scenario === 'object' &&
    d.scenario !== null &&
    Array.isArray(d.assume)
  );
}
