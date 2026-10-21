/**
 * The palette's entries (synthesis § 4.8): this repository's actions by directory, then the workflows that may be
 * called but the one being edited; every remote `uses:` the repository has with its count and the ref it uses most,
 * commonest first; the bundled catalog's actions in its order, but those used here, whose ref wins; a typed
 * `owner/repo@ref` as written; Run a script last. Typed text narrows each section and keeps their order; changing a
 * step's action offers actions alone.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogAction } from '../src/edit/catalog';
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

/** A catalog of three: two the outline uses (by another ref, in another case), one it does not, then another. */
const CATALOG: CatalogAction[] = [
  action('Actions/Checkout', 'v7', 'Checkout'),
  action('actions/upload-artifact', 'v7', 'Upload a Build Artifact', [
    { id: 'name', required: false, default: 'artifact' },
    { id: 'path', required: true },
    { id: 'retention-days', required: true, default: '0' },
  ]),
  action('actions/setup-node', 'v7', 'Setup Node.js environment'),
  action('docker/login-action', 'v4', 'Docker Login'),
];

function action(
  uses: string,
  ref: string,
  name: string,
  inputs: CatalogAction['inputs'] = [],
): CatalogAction {
  return { uses, ref, sha: 'a'.repeat(40), name, inputs, outputs: [], license: 'MIT' };
}

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

  it('lists the catalog’s actions after Used here, in its order, but those the repository uses, whose ref wins', () => {
    const listed = paletteEntries(OUTLINE, CI, '', 'add', CATALOG)
      .filter((e) => e.section === SECTIONS.used || e.section === SECTIONS.common)
      .map((e) => [e.section, e.label, e.detail ?? '']);
    expect(listed).toEqual([
      [SECTIONS.used, 'actions/checkout@v4', 'Checkout · 3 uses here, 2 refs'],
      [SECTIONS.used, 'actions/setup-node@v4', 'Setup Node.js environment · 2 uses here'],
      [SECTIONS.used, 'actions/cache@v3', '1 use here'],
      [SECTIONS.used, 'docker://alpine:3.20', '1 use here'],
      [SECTIONS.used, 'org/shared/.github/workflows/release.yml@v2', '1 use here'],
      [SECTIONS.common, 'actions/upload-artifact@v7', 'Upload a Build Artifact · 1 required input'],
      [SECTIONS.common, 'docker/login-action@v4', 'Docker Login'],
    ]);
    const sections = paletteEntries(OUTLINE, CI, '', 'add', CATALOG).map((e) => e.section);
    expect([...new Set(sections)]).toEqual([SECTIONS.here, SECTIONS.used, SECTIONS.common, SECTIONS.write]);
  });

  it('narrows the catalog by name too, and offers it when a step’s action changes', () => {
    expect(
      paletteEntries(OUTLINE, CI, 'artifact', 'add', CATALOG).map((e) => ('uses' in e ? e.uses : e.label)),
    ).toEqual(['actions/upload-artifact@v7']);
    expect(paletteEntries(OUTLINE, CI, 'login', 'change', CATALOG).map((e) => e.label)).toEqual([
      'docker/login-action@v4',
    ]);
  });

  it('offers a typed owner/repo@ref under Other, as written, unless an entry writes it', () => {
    const typed = (query: string, mode: 'add' | 'change' = 'add') =>
      paletteEntries(OUTLINE, CI, query, mode, CATALOG)
        .filter((e) => e.section === SECTIONS.other)
        .map((e) => [e.kind, 'uses' in e ? e.uses : undefined, 'id' in e ? e.id : undefined]);
    expect(typed('  octo/tool/sub@v1.2 ')).toEqual([['step', 'octo/tool/sub@v1.2', undefined]]);
    expect(typed('octo/tool@main', 'change')).toEqual([['step', 'octo/tool@main', undefined]]);
    expect(typed('octo/ci/.github/workflows/lint.yml@v1')).toEqual([
      ['call', 'octo/ci/.github/workflows/lint.yml@v1', 'lint'],
    ]);
    expect(typed('octo/ci/.github/workflows/lint.yml@v1', 'change')).toEqual([]);
    expect(typed('actions/checkout@v4')).toEqual([]);
    expect(typed('actions/upload-artifact@v7')).toEqual([]);
    expect(typed('octo/tool')).toEqual([]);
    expect(typed('not a ref@v1')).toEqual([]);
    const other = paletteEntries(OUTLINE, CI, 'octo/run@v1', 'add', CATALOG);
    expect(other.map((e) => e.section)).toEqual([SECTIONS.other]);
    expect(other[0]!.detail).toBe(
      'no interface known; inputs are free-form; remote interfaces arrive with M4',
    );
  });

  it('names a local action’s uses by its directory, and a calling job by the file it calls', () => {
    expect(localUses('.github/actions/setup/')).toBe('./.github/actions/setup');
    expect(localUses('')).toBe('./');
    expect(callId('.github/workflows/release.yml')).toBe('release');
    expect(callId('.github/workflows/2nd pass.yaml')).toBe('nd-pass');
    expect(callId('.github/workflows/123.yml')).toBe('call');
  });
});
