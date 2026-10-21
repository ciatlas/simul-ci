/**
 * The catalog builder (scripts/build-catalog.mjs) without the network: how it reads `git ls-remote`, which ref it
 * picks for an action, what an entry keeps of an action.yml and under which licence, and how a failed refresh keeps
 * the committed entries. The committed catalog is checked against its list of actions too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble, cut, entryOf, newestRef, permissive, refsOf, specOf, TOP } from '../build-catalog.mjs';

const root = join(import.meta.dirname, '../..');

const LISTING = `
1111111111111111111111111111111111111111\trefs/heads/main
2222222222222222222222222222222222222222\trefs/heads/v1
3333333333333333333333333333333333333333\trefs/tags/v4
4444444444444444444444444444444444444444\trefs/tags/v4^{}
5555555555555555555555555555555555555555\trefs/tags/v4.2.1
6666666666666666666666666666666666666666\trefs/tags/v5
7777777777777777777777777777777777777777\trefs/tags/v5.0.0
8888888888888888888888888888888888888888\trefs/tags/v5.1.0-beta.1
9999999999999999999999999999999999999999\trefs/tags/codeql-bundle-v2.20.0
`;

describe('reading git ls-remote', () => {
  it('takes an annotated tag’s commit over the tag object, and lists branches apart', () => {
    const { tags, heads } = refsOf(LISTING);
    expect(tags.get('v4')).toBe('4'.repeat(40));
    expect(tags.get('v5')).toBe('6'.repeat(40));
    expect(heads.get('v1')).toBe('2'.repeat(40));
    expect(tags.has('main')).toBe(false);
  });

  it('picks the major ref of the newest release, else the release’s own tag', () => {
    const { tags, heads } = refsOf(LISTING);
    expect(newestRef(tags, heads)).toBe('v5');
    const without = new Map([...tags].filter(([t]) => t !== 'v5'));
    expect(newestRef(without, heads)).toBe('v5.0.0');
    // ruby/setup-ruby moves a branch, not a tag.
    expect(newestRef(new Map([['v1.331.0', 'x']]), new Map([['v1', 'y']]))).toBe('v1');
    expect(
      newestRef(
        new Map([
          ['v2.4.3', 'x'],
          ['v2.4.10', 'y'],
        ]),
      ),
    ).toBe('v2.4.10');
    expect(newestRef(new Map([['v3', 'x']]))).toBe('v3');
    expect(newestRef(new Map([['latest', 'x']]))).toBeUndefined();
  });

  it('splits an entry of TOP into its repository, path and given ref', () => {
    expect(specOf('github/codeql-action/init')).toEqual({
      uses: 'github/codeql-action/init',
      owner: 'github',
      repo: 'codeql-action',
      path: 'init',
    });
    expect(specOf('pypa/gh-action-pypi-publish@release/v1')).toMatchObject({
      uses: 'pypa/gh-action-pypi-publish',
      path: '',
      ref: 'release/v1',
    });
  });
});

const ACTION = `name: Upload
description: |
  Upload a build artifact
  that can be used by subsequent workflow steps
inputs:
  path:
    description: A file, directory or wildcard pattern
    required: true
  name:
    required: 'true'
    default: artifact
  retention-days:
    default: 0
  old:
    deprecationMessage: use name
    description: ${'x'.repeat(200)}
outputs:
  artifact-id:
    description: the id
runs: { using: node24, main: dist/index.js }
`;

describe('an entry of the catalog', () => {
  const resolved = { uses: 'actions/upload-artifact', ref: 'v7', sha: 'a'.repeat(40) };

  it('keeps the name, the first lines of the descriptions, the inputs and the output names', () => {
    expect(entryOf({ ...resolved, license: 'MIT' }, ACTION)).toEqual({
      ...resolved,
      name: 'Upload',
      description: 'Upload a build artifact',
      inputs: [
        { id: 'path', required: true, description: 'A file, directory or wildcard pattern' },
        { id: 'name', required: true, default: 'artifact' },
        { id: 'retention-days', required: false, default: '0' },
        { id: 'old', required: false, deprecated: true, description: `${'x'.repeat(139)}…` },
      ],
      outputs: ['artifact-id'],
      license: 'MIT',
    });
  });

  it('quotes no description under a licence that is not permissive', () => {
    const entry = entryOf({ ...resolved, license: 'LGPL-3.0' }, ACTION);
    expect(entry.description).toBeUndefined();
    expect(entry.inputs.map((i) => i.description)).toEqual([undefined, undefined, undefined, undefined]);
    expect(entry.inputs[1]).toEqual({ id: 'name', required: true, default: 'artifact' });
    expect(permissive(null)).toBe(false);
    expect(permissive('Apache-2.0')).toBe(true);
  });

  it('cuts a text to its first line, keeping an empty default', () => {
    expect(cut('')).toBe('');
    expect(cut('  one\ntwo')).toBe('one');
    expect(cut(true)).toBe('true');
  });
});

describe('a refresh that fails', () => {
  const kept = { uses: 'actions/cache', ref: 'v5' };
  const built = { uses: 'actions/checkout', ref: 'v7' };

  it('keeps the committed entry of an action it could not fetch, says so, and keeps the order', () => {
    const { entries, warnings } = assemble(
      ['actions/checkout', 'actions/cache', 'octo/new'],
      [{ entry: built }, { error: new Error('timed out') }, { error: new Error('no action.yml at abc') }],
      new Map([['actions/cache', kept]]),
    );
    expect(entries).toEqual([built, kept]);
    expect(warnings).toEqual([
      'actions/cache: timed out; its committed entry is kept',
      'octo/new: no action.yml at abc; it is left out',
    ]);
  });
});

describe('the committed catalog', () => {
  const catalog: { uses: string; ref: string }[] = JSON.parse(
    readFileSync(join(root, 'apps/web/src/catalog/catalog.json'), 'utf8'),
  );

  it('holds the actions of TOP, in its order, at the refs it gives', () => {
    expect(catalog.map((a) => a.uses)).toEqual(TOP.map((spec) => specOf(spec).uses));
    for (const spec of TOP) {
      const { uses, ref } = specOf(spec);
      if (ref) expect(catalog.find((a) => a.uses === uses)?.ref).toBe(ref);
    }
  });
});
