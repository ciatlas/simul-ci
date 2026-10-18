import { MocksError, ScenarioError, simulate } from '@simulci/engine';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** One request to one response, pure: the worker and its tests call it. */
export function handle(request: WorkerRequest): WorkerResponse {
  const started = performance.now();
  try {
    const plan = simulate({
      files: request.files,
      scenario: request.scenario,
      detail: request.detail ?? 'steps',
      ...(request.assume ? { assume: request.assume } : {}),
    });
    return { id: request.id, type: 'plan', plan, ms: performance.now() - started };
  } catch (e) {
    const kind = e instanceof ScenarioError ? 'scenario' : e instanceof MocksError ? 'mocks' : 'engine';
    return { id: request.id, type: 'error', kind, message: e instanceof Error ? e.message : String(e) };
  }
}
