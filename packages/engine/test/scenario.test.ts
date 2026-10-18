import {
  fullRef,
  normalizeScenario,
  parseScenario,
  refParts,
  ScenarioError,
  ScenarioInputSchema,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

describe('refs', () => {
  it.each([
    ['main', 'refs/heads/main'],
    ['heads/main', 'refs/heads/main'],
    ['tags/v1', 'refs/tags/v1'],
    ['refs/tags/v1', 'refs/tags/v1'],
    ['pull/7/merge', 'refs/pull/7/merge'],
    ['release/1.x', 'refs/heads/release/1.x'],
  ])('spells %s as %s', (ref, full) => {
    expect(fullRef(ref)).toBe(full);
  });

  it('splits a full ref into ref_name and ref_type', () => {
    expect(refParts('refs/heads/main')).toEqual({ refName: 'main', refType: 'branch' });
    expect(refParts('refs/tags/v1.2.3')).toEqual({ refName: 'v1.2.3', refType: 'tag' });
    expect(refParts('refs/pull/7/merge')).toEqual({ refName: '7/merge', refType: 'branch' });
    expect(refParts('refs/other/x')).toEqual({ refName: 'other/x', refType: 'branch' });
  });
});

describe('parseScenario', () => {
  it('resolves a push without a ref to the default branch', () => {
    const s = parseScenario({ event: 'push' });
    expect(s).toMatchObject({
      id: 'push:main',
      event: 'push',
      ref: 'refs/heads/main',
      refName: 'main',
      refType: 'branch',
      defaultBranch: 'main',
      actor: { fork: false, bot: false },
      inputs: {},
      vars: {},
      secrets: [],
      platform: 'dotcom',
    });
    expect(s.baseRef).toBeUndefined();
  });

  it('resolves branch and tag shorthands', () => {
    expect(parseScenario({ event: 'push', branch: 'release/1.x' }).ref).toBe('refs/heads/release/1.x');
    expect(parseScenario({ event: 'push', tag: 'v1.2.3' })).toMatchObject({
      id: 'push:v1.2.3',
      ref: 'refs/tags/v1.2.3',
      refType: 'tag',
    });
    expect(parseScenario({ event: 'push', ref: 'refs/tags/v2' }).refType).toBe('tag');
  });

  it('refuses more than one of ref, branch and tag', () => {
    expect(() => parseScenario({ event: 'push', branch: 'main', tag: 'v1' })).toThrow(ScenarioError);
  });

  it('gives a pull request the merge ref and the base branch', () => {
    const s = parseScenario({ event: 'pull_request', action: 'opened', head: 'feature', number: 42 });
    expect(s).toMatchObject({
      id: 'pull_request.opened:42/merge',
      ref: 'refs/pull/42/merge',
      refName: '42/merge',
      refType: 'branch',
      baseRef: 'main',
      headRef: 'feature',
      number: 42,
    });
    expect(parseScenario({ event: 'pull_request', base: 'develop' }).baseRef).toBe('develop');
    expect(parseScenario({ event: 'pull_request' }).ref).toBe('refs/pull/1/merge');
  });

  it('runs pull_request_target on the base branch', () => {
    const s = parseScenario({ event: 'pull_request_target', base: 'develop', actor: { fork: true } });
    expect(s).toMatchObject({
      id: 'pull_request_target:develop:fork',
      ref: 'refs/heads/develop',
      baseRef: 'develop',
    });
  });

  it('leaves the ref of a release unknown until a tag is given', () => {
    const untagged = parseScenario({ event: 'release', action: 'published' });
    expect(untagged.id).toBe('release.published:?');
    expect(untagged.ref).toBeUndefined();
    expect(parseScenario({ event: 'release', tag: 'v3' }).ref).toBe('refs/tags/v3');
    expect(parseScenario({ event: 'release', branch: 'main' }).ref).toBeUndefined();
  });

  it('runs scheduled and dispatched workflows on the default branch unless told otherwise', () => {
    expect(parseScenario({ event: 'schedule', cron: '0 6 * * 1', defaultBranch: 'trunk' })).toMatchObject({
      ref: 'refs/heads/trunk',
      cron: '0 6 * * 1',
    });
    expect(parseScenario({ event: 'workflow_dispatch', branch: 'topic' }).ref).toBe('refs/heads/topic');
    expect(parseScenario({ event: 'issues', action: 'labeled' }).ref).toBe('refs/heads/main');
  });

  it('normalizes changed files and keeps typed inputs', () => {
    const s = parseScenario({
      event: 'push',
      changed: [
        'docs/intro.md',
        { path: 'src/a.ts', status: 'added' },
        { path: 'b.ts', status: 'renamed', from: 'a.ts' },
      ],
      inputs: { dry: true, count: 3, name: 'x' },
      vars: { DEPLOY: 'true' },
      secrets: ['NPM_TOKEN'],
      sha: 'abc1234',
      repository: 'ciatlas/simulci',
      message: 'docs: typo [skip ci]',
      environments: ['production'],
      workflow_run: { name: 'CI' },
    });
    expect(s.changed).toEqual([
      { path: 'docs/intro.md', status: 'modified' },
      { path: 'src/a.ts', status: 'added' },
      { path: 'b.ts', status: 'renamed', from: 'a.ts' },
    ]);
    expect(s).toMatchObject({
      inputs: { dry: true, count: 3, name: 'x' },
      vars: { DEPLOY: 'true' },
      secrets: ['NPM_TOKEN'],
      sha: 'abc1234',
      repository: 'ciatlas/simulci',
      message: 'docs: typo [skip ci]',
      environments: ['production'],
      workflow_run: { name: 'CI', conclusion: 'success' },
    });
  });

  it('rejects unknown keys and malformed values with every problem listed', () => {
    expect(() => parseScenario({ event: 'push', branches: ['main'], sha: 'xyz' })).toThrow(
      /Unrecognized key[\s\S]*sha/i,
    );
    expect(() => parseScenario({})).toThrow(ScenarioError);
  });

  it('exposes the input schema for the test DSL and the JSON schemas', () => {
    expect(ScenarioInputSchema.safeParse({ event: 'push' }).success).toBe(true);
    const s = normalizeScenario(ScenarioInputSchema.parse({ event: 'merge_group', base: 'main' }));
    expect(s.ref).toBe('refs/heads/gh-readonly-queue/main');
    expect(s.baseRef).toBe('main');
  });
});
