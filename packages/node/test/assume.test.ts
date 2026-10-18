import { describe, expect, it } from 'vitest';
import { AssumeError, parseAssume } from '../src/assume';

describe('parseAssume', () => {
  it('reads the shorthands and YAML mappings', () => {
    expect(
      parseAssume([
        'build.t=failure',
        'deploy=failure',
        'build.t.outputs.sha=abc',
        'deploy.#1.env.TARGET=prod',
        'build.c=as:hit',
        '{ uses: actions/cache, as: miss }',
      ]),
    ).toEqual([
      { step: 'build.t', outcome: 'failure' },
      { job: 'deploy', outcome: 'failure' },
      { step: 'build.t', outputs: { sha: 'abc' } },
      { step: 'deploy.#1', env: { TARGET: 'prod' } },
      { step: 'build.c', as: 'hit' },
      { uses: 'actions/cache', as: 'miss' },
    ]);
    expect(parseAssume([], '- { step: a.b, outcome: failure }\n')).toEqual([
      { step: 'a.b', outcome: 'failure' },
    ]);
    expect(() => parseAssume(['nonsense'])).toThrow(AssumeError);
    expect(() => parseAssume(['build.t=maybe'])).toThrow(/invalid assume entries/);
    expect(() => parseAssume([], 'step: x\n')).toThrow(/YAML list/);
  });
});
