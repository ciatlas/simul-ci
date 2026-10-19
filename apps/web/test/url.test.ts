import { ScenarioInputSchema } from '@simulci/engine';
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { ASSUME_URL_LIMIT, readSearch, SCENARIO_KEYS, writeSearch } from '../src/state/url';

describe('the URL picker', () => {
  it('names every key of the scenario schema, in its order', () => {
    expect([...SCENARIO_KEYS]).toEqual(Object.keys(ScenarioInputSchema.shape));
  });

  it('round-trips a state through the router serializer', () => {
    const state = {
      scenario: { event: 'push', branch: 'main', changed: ['src/a.ts'], inputs: { dry: true }, number: 12 },
      assume: [{ step: 'build.detect', outputs: { changed: 'true' } }],
      wf: '.github/workflows/ci.yml',
      sel: 'deploy',
      d: 'legs' as const,
      view: 'text' as const,
      hide: true as const,
    };
    const search = defaultStringifySearch(writeSearch(state));
    expect(search).toContain('event=push&branch=main');
    expect(readSearch(defaultParseSearch(search))).toEqual(state);
  });

  it('leaves out what says nothing and what has the wrong shape', () => {
    expect(writeSearch({ scenario: { event: 'push', message: '', secrets: [], vars: {} } })).toEqual({
      event: 'push',
    });
    expect(writeSearch({ assume: [], hide: false as never, d: 'steps' as never })).toEqual({});
    expect(readSearch({ branch: 'main' })).toEqual({});
    expect(
      readSearch({ event: 'push', number: '12', changed: 'src/a.ts', actor: ['x'], merged: 'yes' }),
    ).toEqual({
      scenario: { event: 'push' },
    });
    expect(readSearch({ event: 'push', a: ['build'], wf: '', d: 'steps', view: 'graph', hide: 0 })).toEqual({
      scenario: { event: 'push' },
    });
    expect(readSearch({ event: 'push', hide: '1' })).toEqual({ scenario: { event: 'push' }, hide: true });
  });

  it('drops a key holding a value the form could not show as text', () => {
    expect(readSearch(defaultParseSearch('?event=push&changed=[null]'))).toEqual({
      scenario: { event: 'push' },
    });
    const junk = [
      { changed: ['src/a.ts', null] },
      { changed: [{ path: { toString: 1 } }] },
      { changed: [['src/a.ts']] },
      { inputs: { dry: true, name: { toString: 1 } } },
      { workflow_run: { name: ['CI'] } },
      { actor: { login: { name: 'x' } } },
      { vars: { X: [1] } },
    ];
    for (const keys of junk)
      expect(readSearch({ event: 'push', ...keys })).toEqual({ scenario: { event: 'push' } });
  });

  it('keeps every value that reads as text, for the worker to judge', () => {
    const scenario = {
      event: 'workflow_dispatch',
      changed: ['src/a.ts', { path: 'docs/b.md', status: 'added' }, { path: 1 }],
      inputs: { dry: true, count: 2, name: 'x', none: null },
      workflow_run: { name: 'CI', conclusion: 'failure' },
      secrets: [1, {}],
    };
    expect(readSearch(scenario)).toEqual({ scenario });
    expect(
      readSearch(defaultParseSearch(defaultStringifySearch(writeSearch({ scenario: scenario as never })))),
    ).toEqual({ scenario });
  });

  it('drops the assume entries when one names its unit, workflow or preset with something not text, or a record with something else', () => {
    const junk = [
      { step: 5, outcome: 'failure' },
      { uses: 5, outcome: 'failure' },
      { job: null, outcome: 'failure' },
      { workflow: ['ci.yml'], step: 'a.b', outcome: 'failure' },
      { step: 'a.b', as: { name: 'hit' } },
      { step: 'build.detect', matrix: null, outcome: 'failure' },
      { step: 'build.detect', outputs: 'true' },
      { step: 'build.detect', env: ['A'] },
    ];
    for (const entry of junk)
      expect(
        readSearch({ event: 'push', a: [{ job: 'a', outcome: 'success' }, entry] }),
        JSON.stringify(entry),
      ).toEqual({ scenario: { event: 'push' } });
    const kept = [
      { workflow: 'ci.yml', step: 'a.b', outcome: 'failure' },
      { job: 'a', uses: 'actions/cache', as: 'hit' },
      { job: 'test', matrix: { node: 22 }, outcome: 'cancelled' },
    ];
    expect(readSearch({ event: 'push', a: kept })).toEqual({ scenario: { event: 'push' }, assume: kept });
  });

  it('keeps assume entries out of the URL once they are too long for one', () => {
    const assume = Array.from({ length: 200 }, (_, i) => ({
      step: `job.step${i}`,
      outcome: 'failure' as const,
    }));
    expect(JSON.stringify(assume).length).toBeGreaterThan(ASSUME_URL_LIMIT);
    expect(writeSearch({ assume })).toEqual({});
    expect(writeSearch({ assume: assume.slice(0, 3) }).a).toHaveLength(3);
  });
});
