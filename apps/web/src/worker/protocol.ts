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
}

export interface InvalidResponse {
  id: number;
  type: 'invalid';
  what: 'scenario' | 'assume';
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
}

export interface OutlineWorkflow {
  path: string;
  name?: string;
  callable: boolean;
  generated?: string;
  /** In declaration order, `workflow_call` excluded. */
  events: OutlineEvent[];
  dispatch?: OutlineInput[];
  jobs: OutlineJob[];
  onLine: number;
}

export interface OutlineFile {
  path: string;
  kind: 'workflow' | 'action' | 'other';
  errors: { line: number; column: number; message: string }[];
}

/** What the project holds, for the form, the outline tree and the YAML pane: hints, never results. */
export interface Outline {
  files: OutlineFile[];
  workflows: OutlineWorkflow[];
  /** The activity types of the events present, from the engine's table. */
  events: Record<string, { types: string[]; default: string[] }>;
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
  unknownPaths: Record<UnknownId, string>;
}

const TYPES = new Set(['load', 'simulate', 'case']);

/** Whether a message is a request the worker answers: the shape is checked, not trusted. */
export function isEngineRequest(data: unknown): data is EngineRequest {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'number' || typeof d.type !== 'string' || !TYPES.has(d.type)) return false;
  if (d.type === 'load') return typeof d.files === 'object' && d.files !== null;
  return (
    typeof d.project === 'number' &&
    typeof d.scenario === 'object' &&
    d.scenario !== null &&
    Array.isArray(d.assume)
  );
}
