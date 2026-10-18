import { AssumeEntrySchema, type Location, MockResolver, usesMatches } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const at = (chain: Location['chain'], workflow = '.github/workflows/ci.yml'): Location => ({
  workflow,
  chain,
});
const unit = at([
  { kind: 'job', id: 'build' },
  { kind: 'step', id: 'unit', index: 1 },
]);
const win = at([
  { kind: 'job', id: 'test', leg: { os: 'windows-latest' } },
  { kind: 'step', id: 'unit', index: 1 },
]);

describe('AssumeEntrySchema', () => {
  it('needs exactly one target and at least one fact', () => {
    expect(AssumeEntrySchema.safeParse({ step: 'build.unit', outcome: 'failure' }).success).toBe(true);
    expect(
      AssumeEntrySchema.safeParse({ uses: 'actions/cache', job: 'build', outputs: { 'cache-hit': 'true' } })
        .success,
    ).toBe(true);
    expect(AssumeEntrySchema.safeParse({ step: 'a', job: 'b', outcome: 'failure' }).success).toBe(false);
    expect(AssumeEntrySchema.safeParse({ step: 'build.unit' }).success).toBe(false);
    expect(AssumeEntrySchema.safeParse({ job: 'build', env: { X: '1' } }).success).toBe(false);
    expect(AssumeEntrySchema.safeParse({ step: 'build.unit', conclusion: 'success' }).success).toBe(false);
    expect(
      AssumeEntrySchema.safeParse({ step: 'build.unit', outputs: { v: { unknown: true } } }).success,
    ).toBe(true);
  });
});

describe('MockResolver', () => {
  it('states outcome, outputs and env from the entries that name the unit', () => {
    const r = new MockResolver({
      case: [
        { step: 'build.unit', outcome: 'failure', outputs: { changed: 'true', n: 3 }, env: { MODE: 'ci' } },
      ],
    });
    const facts = r.factsFor(unit, 'n1');
    expect(facts.outcome).toEqual({ value: { known: true, value: 'failure' }, by: 'assume[0]' });
    expect(facts.outputs).toEqual({
      changed: { value: { known: true, value: 'true' }, by: 'assume[0]' },
      n: { value: { known: true, value: '3' }, by: 'assume[0]' },
    });
    expect(facts.env).toEqual({ MODE: { value: { known: true, value: 'ci' }, by: 'assume[0]' } });
    expect(r.unmatched()).toEqual([]);
  });

  it('lets a closer layer win, and within a layer the entry naming more of the unit', () => {
    const r = new MockResolver({
      given: [{ step: 'test.unit', outcome: 'success', outputs: { v: 'given' } }],
      case: [
        { step: 'test.unit', outputs: { v: 'any' } },
        { step: 'test[os=windows-latest].unit', outputs: { v: 'windows' } },
      ],
      cli: [{ step: 'test.unit', outcome: 'failure' }],
    });
    const facts = r.factsFor(win, 'n1');
    expect(facts.outcome).toEqual({ value: { known: true, value: 'failure' }, by: 'cli[0]' });
    expect(facts.outputs.v).toEqual({ value: { known: true, value: 'windows' }, by: 'assume[1]' });
  });

  it('composes fields from partial entries and reports an equal-rank conflict (SC103)', () => {
    const r = new MockResolver({
      case: [
        { step: 'build.unit', outcome: 'failure' },
        { step: 'build.unit', outputs: { v: '1' } },
        { step: 'build.unit', outputs: { v: '2' } },
      ],
    });
    const facts = r.factsFor(unit, 'n1');
    expect(facts.outcome?.by).toBe('assume[0]');
    expect(facts.outputs.v?.value).toEqual({ known: false, unknowns: ['conflict:n1.outputs.v'] });
    expect(r.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'SC103',
        message: 'assume[1] and assume[2] both set outputs.v of n1 to different values',
        node: 'n1',
        mock: 'assume[1]',
      },
    ]);
  });

  it('matches uses: patterns within a job scope and reports entries that matched nothing', () => {
    const r = new MockResolver({
      case: [
        { uses: 'actions/cache', outputs: { 'cache-hit': 'true' } },
        { uses: 'actions/cache@v3', job: 'other', outputs: { 'cache-hit': 'false' } },
        { step: 'nowhere.x', outcome: 'failure' },
      ],
    });
    const facts = r.factsFor(unit, 'n1', 'actions/cache/restore@v4');
    expect(facts.outputs['cache-hit']?.by).toBe('assume[0]');
    expect(r.factsFor(unit, 'n2', 'actions/checkout@v5').outputs).toEqual({});
    expect(r.unmatched().map((c) => c.ref)).toEqual(['assume[1]', 'assume[2]']);
  });

  it('refuses a job-level entry for a step and a step entry for a job', () => {
    const r = new MockResolver({
      case: [
        { job: 'build', outcome: 'failure' },
        { step: 'build.unit', outcome: 'failure' },
      ],
    });
    expect(r.factsFor(unit, 'step').outcome?.by).toBe('assume[1]');
    expect(r.factsFor(at([{ kind: 'job', id: 'build' }]), 'job').outcome?.by).toBe('assume[0]');
  });

  it('reports a path it cannot read (SC100)', () => {
    const r = new MockResolver({ case: [{ step: 'a.b.c', outcome: 'failure' }] });
    expect(r.diagnostics[0]).toMatchObject({ code: 'SC100', mock: 'assume[0]' });
  });
});

describe('usesMatches', () => {
  it('matches the repository, its sub-actions, and the ref when given', () => {
    expect(usesMatches({ repo: 'actions/cache' }, 'actions/cache@v4')).toBe(true);
    expect(usesMatches({ repo: 'actions/cache' }, 'actions/cache/restore@v4')).toBe(true);
    expect(usesMatches({ repo: 'actions/cache' }, 'actions/cachet@v4')).toBe(false);
    expect(usesMatches({ repo: 'actions/cache', ref: 'v4' }, 'actions/cache@v4')).toBe(true);
    expect(usesMatches({ repo: 'actions/cache', ref: 'v4' }, 'actions/cache@v3')).toBe(false);
    expect(usesMatches({ repo: './.github/actions/x' }, './.github/actions/x')).toBe(true);
  });
});
