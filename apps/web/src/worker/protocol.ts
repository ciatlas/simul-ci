import type { AssumeEntry, RunPlan, ScenarioInput } from '@simulci/engine';

/**
 * What the UI and the engine worker say to each other. The RunPlan JSON is the only contract: the worker simulates,
 * the UI renders. Every request carries an id the response echoes, so stale answers are dropped.
 */

export interface SimulateRequest {
  id: number;
  type: 'simulate';
  /** Repository files by path (`.github/workflows/ci.yml`, …). */
  files: Record<string, string>;
  scenario: ScenarioInput;
  assume?: AssumeEntry[];
  detail?: 'legs' | 'steps';
}

export type WorkerRequest = SimulateRequest;

export interface PlanResponse {
  id: number;
  type: 'plan';
  plan: RunPlan;
  /** Milliseconds the simulation took in the worker. */
  ms: number;
}

export interface ErrorResponse {
  id: number;
  type: 'error';
  /** `scenario` and `mocks` are the author's to fix; `engine` is ours. */
  kind: 'scenario' | 'mocks' | 'engine';
  message: string;
}

export type WorkerResponse = PlanResponse | ErrorResponse;
