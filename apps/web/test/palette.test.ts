/**
 * The palette's entries (synthesis § 4.8, without the catalog): this repository's actions by directory, then the
 * workflows that may be called but the one being edited; every remote `uses:` the repository has with its count and
 * the ref it uses most, commonest first; Run a script last. Typed text narrows each section and keeps their order;
 * changing a step's action offers actions alone.
 */
import { describe, expect, it } from 'vitest';
import { callId, localUses, paletteEntries, SECTIONS, usedHere } from '../src/edit/palette/entries';
import type { Outline, OutlineJob } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';

const job = (id: string, uses: (string | undefined)[], jobUses?: string): OutlineJob => ({
  id,
  needs: [],
  matrix: false,
  line: 1,
  steps: uses.map((u, index) => ({ index, line: index + 2, ...(u === undefined ? {} : { uses: u }) })),
  ...(jobUses === undefined ? {} : { uses: jobUses }),
});

const OUTLINE: Outline = {
  files: [],
  events: {},
  workflows: [
    {
      path: CI,
      name: 'CI',
      callable: false,
      events: [],
      onLine: 1,
      jobs: [
        job('test', ['actions/checkout@v4', 'actions/setup-node@v4', undefined]),
        job('build', ['actions/checkout@v4', './.github/actions/setup', 'actions/cache@v3']),
        job('lint', ['actions/checkout@v5', 'actions/setup-node@v4', 'docker://alpine:3.20']),
        job('release', [], 'org/shared/.github/workflows/release.yml@v2'),
        job('dyn', ['${{ matrix.action }}']),
      ],
    },
    {
      path: '.github/workflows/reusable.yml',
      name: 'Reusable',
      callable: true,
      events: [],
      onLine: 1,
      jobs: [],
    },
    { path: '.github/workflows/deploy.yaml', callable: true, events: [], onLine: 1, jobs: [] },
  ],
  actions: [
    {
      dir: '.github/actions/setup',
      file: '.github/actions/setup/action.yml',
      name: 'Setup',
      inputs: [
        { name: 'token', required: true },
        { name: 'cache', required: false },
      ],
      outputs: [],
    },
    { dir: '', file: 'action.yml', name: 'Root', inputs: [], outputs: [] },
  ],
};

const rows = (query = '', mode: 'add' | 'change' = 'add') =>
  paletteEntries(OUTLINE, CI, query, mode).map((e) => [e.section, e.label, e.detail ?? '']);

describe('the palette', () => {
  it('lists this repository’s actions and callable workflows, what it uses, then Run a script', () => {
    expect(rows()).toEqual([
      [SECTIONS.here, './', 'Root'],
      [SECTIONS.here, './.github/actions/setup', 'Setup · 1 required input'],
      [SECTIONS.here, 'Call ./.github/workflows/deploy.yaml', 'adds a job that calls it'],
      [SECTIONS.here, 'Call ./.github/workflows/reusable.yml', 'Reusable · adds a job that calls it'],
      [SECTIONS.used, 'actions/checkout@v4', '3 uses here, 2 refs'],
      [SECTIONS.used, 'actions/setup-node@v4', '2 uses here'],
      [SECTIONS.used, 'actions/cache@v3', '1 use here'],
      [SECTIONS.used, 'docker://alpine:3.20', '1 use here'],
      [SECTIONS.used, 'org/shared/.github/workflows/release.yml@v2', '1 use here'],
      [SECTIONS.write, 'Run a script', 'a step with run: you write'],
    ]);
  });

  it('writes the ref used most, a reusable workflow as a job that calls it, and no expression', () => {
    const used = usedHere(OUTLINE);
    expect(used.find((e) => e.label.startsWith('actions/checkout'))).toMatchObject({
      kind: 'step',
      uses: 'actions/checkout@v4',
    });
    expect(used.find((e) => e.label.startsWith('org/shared'))).toMatchObject({
      kind: 'call',
      uses: 'org/shared/.github/workflows/release.yml@v2',
      id: 'release',
    });
    expect(used.some((e) => e.label.includes('${{'))).toBe(false);
  });

  it('narrows every section to the typed text, keeping their order', () => {
    expect(rows('setup')).toEqual([
      [SECTIONS.here, './.github/actions/setup', 'Setup · 1 required input'],
      [SECTIONS.used, 'actions/setup-node@v4', '2 uses here'],
    ]);
    expect(rows('RUN')).toEqual([[SECTIONS.write, 'Run a script', 'a step with run: you write']]);
    expect(rows('nothing like it')).toEqual([]);
  });

  it('offers actions alone when a step’s action changes', () => {
    expect(rows('', 'change').map(([, label]) => label)).toEqual([
      './',
      './.github/actions/setup',
      'actions/checkout@v4',
      'actions/setup-node@v4',
      'actions/cache@v3',
      'docker://alpine:3.20',
    ]);
  });

  it('has Run a script alone in a repository with nothing to list', () => {
    expect(paletteEntries(undefined, CI, '', 'add').map((e) => e.label)).toEqual(['Run a script']);
  });

  it('names a local action’s uses by its directory, and a calling job by the file it calls', () => {
    expect(localUses('.github/actions/setup/')).toBe('./.github/actions/setup');
    expect(localUses('')).toBe('./');
    expect(callId('.github/workflows/release.yml')).toBe('release');
    expect(callId('.github/workflows/2nd pass.yaml')).toBe('nd-pass');
    expect(callId('.github/workflows/123.yml')).toBe('call');
  });
});
