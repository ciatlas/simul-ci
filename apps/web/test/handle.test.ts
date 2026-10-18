import { describe, expect, it } from 'vitest';
import { handle } from '../src/worker/handle';

const files = {
  '.github/workflows/ci.yml':
    'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
};

describe('the worker handler', () => {
  it('answers a simulate request with the plan and the time it took', () => {
    const r = handle({ id: 7, type: 'simulate', files, scenario: { event: 'push', branch: 'main' } });
    expect(r.id).toBe(7);
    if (r.type !== 'plan') throw new Error(r.message);
    expect(r.plan.workflows[0]!.triggered.verdict).toBe('yes');
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("tells the author's mistakes from the engine's", () => {
    const scenario = handle({
      id: 1,
      type: 'simulate',
      files,
      scenario: { event: 'push', branch: 'main', tag: 'v1' },
    });
    expect(scenario).toMatchObject({ id: 1, type: 'error', kind: 'scenario' });
    const mocks = handle({
      id: 2,
      type: 'simulate',
      files,
      scenario: { event: 'push' },
      assume: [{ step: 'a.#1' }] as never,
    });
    expect(mocks).toMatchObject({ id: 2, type: 'error', kind: 'mocks' });
  });
});
