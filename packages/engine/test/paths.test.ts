import {
  formatUnitPath,
  type Location,
  parseUnitPath,
  pathMatches,
  pathSpecificity,
  UnitPathError,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

describe('parseUnitPath', () => {
  it('reads jobs, legs, steps, positions, nesting and the workflow qualifier', () => {
    expect(parseUnitPath('deploy')).toEqual({ segments: [{ job: 'deploy' }] });
    expect(parseUnitPath('test.unit')).toEqual({ segments: [{ job: 'test', step: { id: 'unit' } }] });
    expect(parseUnitPath('test[os=windows-latest,node=20].#2')).toEqual({
      segments: [{ job: 'test', leg: { os: 'windows-latest', node: '20' }, step: { index: 2 } }],
    });
    expect(parseUnitPath('rel/build.v')).toEqual({
      segments: [{ job: 'rel' }, { job: 'build', step: { id: 'v' } }],
    });
    expect(parseUnitPath('build.setup/cache')).toEqual({
      segments: [{ job: 'build', step: { id: 'setup' } }, { step: { id: 'cache' } }],
    });
    expect(parseUnitPath('ci.yml:deploy')).toEqual({ workflow: 'ci.yml', segments: [{ job: 'deploy' }] });
    expect(parseUnitPath(' a[n=2].#1 ')).toEqual({
      segments: [{ job: 'a', leg: { n: '2' }, step: { index: 1 } }],
    });
  });

  it('refuses what is not a path', () => {
    expect(() => parseUnitPath('')).toThrow(UnitPathError);
    expect(() => parseUnitPath('a.b.c')).toThrow(UnitPathError);
    expect(() => parseUnitPath('1job')).toThrow(UnitPathError);
    expect(() => parseUnitPath('a[os]')).toThrow(UnitPathError);
    expect(() => parseUnitPath('a.#0')).toThrow(UnitPathError);
  });

  it('round-trips through formatUnitPath', () => {
    for (const p of [
      'deploy',
      'test.unit',
      'test[node=20,os=x].#2',
      'rel/build.v',
      'build.setup/cache',
      'ci.yml:deploy',
    ]) {
      expect(formatUnitPath(parseUnitPath(p))).toBe(p);
    }
  });
});

describe('pathMatches', () => {
  const step: Location = {
    workflow: '.github/workflows/ci.yml',
    chain: [
      { kind: 'job', id: 'test', leg: { os: 'ubuntu-latest', node: '20' } },
      { kind: 'step', id: 'unit', index: 2 },
    ],
  };
  const idless: Location = {
    workflow: '.github/workflows/ci.yml',
    chain: [
      { kind: 'job', id: 'a' },
      { kind: 'step', index: 1 },
    ],
  };
  const inner: Location = {
    workflow: '.github/workflows/ci.yml',
    chain: [
      { kind: 'job', id: 'build' },
      { kind: 'step', id: 'setup', index: 1 },
      { kind: 'step', index: 1 },
    ],
  };
  const callee: Location = {
    workflow: '.github/workflows/rel.yml',
    chain: [
      { kind: 'job', id: 'rel' },
      { kind: 'job', id: 'build' },
      { kind: 'step', id: 'v', index: 3 },
    ],
  };

  it('matches the same depth with leg values as a subset', () => {
    expect(pathMatches(parseUnitPath('test.unit'), step)).toBe(true);
    expect(pathMatches(parseUnitPath('test[os=ubuntu-latest].unit'), step)).toBe(true);
    expect(pathMatches(parseUnitPath('test[os=windows-latest].unit'), step)).toBe(false);
    expect(pathMatches(parseUnitPath('test[node=20,os=ubuntu-latest].unit'), step)).toBe(true);
    expect(pathMatches(parseUnitPath('test'), step)).toBe(false);
    expect(pathMatches(parseUnitPath('test.#2'), step)).toBe(true);
    expect(pathMatches(parseUnitPath('test.#1'), step)).toBe(false);
    expect(pathMatches(parseUnitPath('a.#1'), idless)).toBe(true);
    expect(pathMatches(parseUnitPath('build.setup/#1'), inner)).toBe(true);
    expect(pathMatches(parseUnitPath('rel/build.v'), callee)).toBe(true);
    expect(pathMatches(parseUnitPath('build.v'), callee)).toBe(false);
  });

  it('honours the workflow qualifier in its three spellings', () => {
    for (const w of ['ci', 'ci.yml', '.github/workflows/ci.yml'])
      expect(pathMatches(parseUnitPath(`${w}:test.unit`), step)).toBe(true);
    expect(pathMatches(parseUnitPath('release:test.unit'), step)).toBe(false);
  });

  it('ranks the more specific path higher', () => {
    const rank = (p: string) => pathSpecificity(parseUnitPath(p));
    expect(rank('test.unit')).toBeGreaterThan(rank('test'));
    expect(rank('test[os=x].unit')).toBeGreaterThan(rank('test.unit'));
    expect(rank('ci.yml:test.unit')).toBeGreaterThan(rank('test.unit'));
    expect(rank('rel/build.v')).toBeGreaterThan(rank('build.v'));
  });
});
