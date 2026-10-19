import type { AssumeEntry, Diagnostic, ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import { assumptionRows, entryLabel, issuesOf } from '../src/panels/assumption-rows';
import { handle, initialState } from '../src/worker/handle';
import type { EngineResponse } from '../src/worker/protocol';

/** The worker's answer for the starter under a scenario and a case layer: a plan, or its refusal. */
function answer(scenario: ScenarioInput, assume: AssumeEntry[]): EngineResponse {
  const loaded = handle(initialState(), { id: 1, type: 'load', files: starter, repository: 'o/r' });
  return handle(loaded.state, { id: 2, type: 'simulate', project: 1, scenario, assume, detail: 'steps' })
    .response;
}

const starter = sampleByName('starter')!.files;
const CI = '.github/workflows/ci.yml';
const push: ScenarioInput = { event: 'push', branch: 'main', changed: ['src/a.ts'] };

describe('assumptionRows', () => {
  const assume: AssumeEntry[] = [
    { step: 'build.detect', outputs: { changed: 'true' } },
    { job: 'nope', outcome: 'failure' },
    { job: 'build', outcome: 'success' },
    { step: 'build.detect', outputs: { nope: 'x' } },
  ];
  const r = answer(push, assume);
  if (r.type !== 'plan') throw new Error(JSON.stringify(r));
  const rows = assumptionRows(assume, r.plan, r.derived);

  it('lists every entry in order, by the ref the plan names it with', () => {
    expect(rows.map((row) => [row.index, row.ref, row.entry])).toEqual(
      assume.map((e, i) => [i, `assume[${i}]`, e]),
    );
  });

  it('says where an entry applied, as a unit path, and what it supplied there', () => {
    expect(rows[0]).toMatchObject({
      applied: [{ at: 'build.detect', provides: ['outputs.changed'] }],
      diagnostics: [],
      status: 'ok',
    });
    expect(rows[2]?.applied).toEqual([{ at: 'build', provides: ['outcome'] }]);
  });

  it('marks an entry that matches nothing as an error (SC102)', () => {
    expect(rows[1]).toMatchObject({ applied: [], status: 'error' });
    expect(rows[1]?.diagnostics.map((d) => d.code)).toEqual(['SC102']);
  });

  it('carries the info the engine gives about an entry, and an undeclared output as an error', () => {
    expect(rows[2]?.status).toBe('info');
    expect(rows[2]?.diagnostics.map((d) => d.code)).toEqual(['SC108']);
    expect(rows[3]?.status).toBe('error');
    expect(rows[3]?.diagnostics.map((d) => d.code)).toEqual(['SC101']);
  });

  it('puts errors first, then warnings, then info, and keeps a node the table has no path for', () => {
    const said = (severity: Diagnostic['severity'], code: string): Diagnostic => ({
      severity,
      code,
      message: code,
      mock: 'assume[0]',
    });
    const plan = {
      ...r.plan,
      mocks: [{ ref: 'assume[0]', layer: 'case' as const, at: `${CI}#gone`, provides: ['outcome'] }],
      diagnostics: [
        said('info', 'I'),
        said('warning', 'W'),
        said('error', 'E'),
        { ...said('error', 'X'), mock: 'cli[0]' },
      ],
    };
    const [row] = assumptionRows([assume[0]!], plan, r.derived);
    expect(row?.diagnostics.map((d) => d.code)).toEqual(['E', 'W', 'I']);
    expect(row?.status).toBe('error');
    expect(row?.applied).toEqual([{ at: `${CI}#gone`, provides: ['outcome'] }]);
    const [warned] = assumptionRows(
      [assume[0]!],
      { ...plan, diagnostics: [said('info', 'I'), said('warning', 'W')] },
      r.derived,
    );
    expect(warned?.status).toBe('warning');
  });

  it('lists nothing for an empty case layer', () => {
    expect(assumptionRows([], r.plan, r.derived)).toEqual([]);
  });
});

describe('entryLabel', () => {
  it('names the unit and what the entry states', () => {
    expect(entryLabel({ step: 'build.detect', outputs: { changed: 'true' }, outcome: 'failure' })).toBe(
      'build.detect · outputs.changed = true, outcome failure',
    );
    expect(entryLabel({ workflow: 'ci.yml', job: 'test', matrix: { node: 22 }, outcome: 'cancelled' })).toBe(
      'ci.yml:test[node=22] · outcome cancelled',
    );
    expect(entryLabel({ job: 'publish', uses: 'actions/cache', as: 'hit' })).toBe(
      'publish uses actions/cache · as hit',
    );
    expect(entryLabel({ uses: 'actions/cache', outputs: { 'cache-hit': '' } })).toBe(
      "uses actions/cache · outputs.cache-hit = ''",
    );
    expect(entryLabel({ step: 'a.b', env: { X: { unknown: true }, Y: 1 } })).toBe(
      'a.b · env.X = unknown, env.Y = 1',
    );
    expect(entryLabel({ step: 'a.b' })).toBe('a.b');
  });
});

describe('issuesOf', () => {
  it("gives the worker's refusal of one entry, with the rest of the path in front", () => {
    const refused = answer(push, [
      { step: 'build.detect', outputs: { changed: 'true' } },
      { step: 'a.b', outcome: 'nope' } as unknown as AssumeEntry,
      { job: 'x' },
    ]);
    if (refused.type !== 'invalid') throw new Error(JSON.stringify(refused));
    expect(refused.what).toBe('assume');
    expect(issuesOf(refused.issues, 0)).toEqual([]);
    const [outcome] = issuesOf(refused.issues, 1);
    expect(outcome).toMatch(/^outcome: /);
    expect(issuesOf(refused.issues, 2)).toEqual(['state an outcome, outputs, env or as']);
    expect(issuesOf([{ path: [3, 'outputs', 'x'], message: 'bad' }], 3)).toEqual(['outputs.x: bad']);
  });
});
