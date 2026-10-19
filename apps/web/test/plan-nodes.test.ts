import type { ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import { declaredAt, decisionOf, planNodes } from '../src/plan/nodes';
import { handle, initialState } from '../src/worker/handle';
import type { PlanResponse } from '../src/worker/protocol';

function simulated(files: Record<string, string>, scenario: ScenarioInput): PlanResponse {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  return step.response;
}

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const starter = sampleByName('starter')!.files;

describe('planNodes', () => {
  // A tag push runs Release (and its composite action); a push to main lays out CI's jobs and legs.
  const { plan, derived } = simulated(starter, { event: 'push', tag: 'v1.0.0' });
  const nodes = planNodes(plan);
  const ci = planNodes(simulated(starter, { event: 'push', branch: 'main' }).plan);

  it('holds every node the worker names, with the kind it gives', () => {
    for (const [id, kind] of Object.entries(derived.kinds)) expect(nodes.get(id)?.kind, id).toBe(kind);
    expect(nodes.size).toBe(Object.keys(derived.kinds).length);
  });

  it('is built once per plan', () => {
    expect(planNodes(plan)).toBe(nodes);
  });

  it('puts a job with one bare leg under the job, and a matrix leg under its own id', () => {
    expect(ci.get(`${CI}#deploy`)?.kind).toBe('job');
    expect(ci.get(`${CI}#test[node=22]`)?.kind).toBe('leg');
  });

  it('gives each node its decision and where it is declared', () => {
    const wf = nodes.get(RELEASE)!;
    expect(decisionOf(wf)).toBe(plan.workflows.find((w) => w.path === RELEASE)!.triggered);
    expect(declaredAt(wf)).toEqual({ file: RELEASE, line: 1, column: 1 });
    const publish = nodes.get(`${RELEASE}#publish`)!;
    expect(publish.kind === 'job' && decisionOf(publish)).toBe(publish.kind === 'job' && publish.job.runs);
    expect(declaredAt(publish)?.file).toBe(RELEASE);
    const leg = ci.get(`${CI}#test[node=22]`)!;
    expect(declaredAt(leg)?.line).toBeGreaterThan(1);
  });

  it('lists a composite action and its inner steps with the leg they run in', () => {
    const composite = [...nodes.values()].find((n) => n.kind === 'composite');
    expect(composite).toBeDefined();
    if (composite?.kind !== 'composite') return;
    expect(decisionOf(composite)).toBe(composite.step.runs);
    expect(declaredAt(composite)).toBe(composite.step.loc);
    for (const inner of composite.action.steps) {
      const n = nodes.get(inner.id);
      expect(n?.kind).toBe('step');
      if (n?.kind === 'step') expect(n.leg).toBe(composite.leg);
    }
  });
});
