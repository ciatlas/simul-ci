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
