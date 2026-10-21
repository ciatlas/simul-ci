/**
 * What a rename changes beside the text (synthesis § 4.10, § 7.4): NodeIds mapped at an id's boundary, maps composed
 * across a burst of edits, the canvas's open cards, and the unit paths of the selection and the assume entries; the
 * store applies them in the commit that renames, and undo and redo map back and forth.
 */
import { type AssumeEntry, loadFiles, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import {
  composeNodes,
  inverse,
  renamedAssume,
  renamedNode,
  renamedUi,
  renamedUnit,
  type Renames,
  type World,
} from '../src/state/renames';
import { createSessionStore } from '../src/state/store';

const CI = '.github/workflows/ci.yml';
const DEPLOY = '.github/workflows/deploy.yml';
const FOLDER = { kind: 'folder', name: 'repo', readAt: 0 } as const;
const job = { kind: 'job', file: CI, job: 'build', from: 'build', to: 'compile' } as const;
const step = { kind: 'step', file: CI, job: 'build', from: 'detect', to: 'probe' } as const;

describe('renamedNode', () => {
  const nodes = {
    [`${CI}#build`]: `${CI}#compile`,
    [`${CI}#build/steps.detect`]: `${CI}#compile/steps.probe`,
  };
  it('maps an id at its boundary, the longest prefix first', () => {
    expect(renamedNode(nodes, `${CI}#build`)).toBe(`${CI}#compile`);
    expect(renamedNode(nodes, `${CI}#build[os=a]/steps.x`)).toBe(`${CI}#compile[os=a]/steps.x`);
    expect(renamedNode(nodes, `${CI}#build/steps.detect>./a`)).toBe(`${CI}#compile/steps.probe>./a`);
    expect(renamedNode(nodes, `${CI}#build>${DEPLOY}#x`)).toBe(`${CI}#compile>${DEPLOY}#x`);
    expect(renamedNode(nodes, `${CI}#build-2`)).toBe(`${CI}#build-2`);
    expect(renamedNode(nodes, `${CI}#builder/steps.detect`)).toBe(`${CI}#builder/steps.detect`);
  });
});

describe('composeNodes', () => {
  it('keys the composed map by the oldest ids and maps them to the newest', () => {
    const a = { [`${CI}#build`]: `${CI}#compile` };
    expect(composeNodes(a, { [`${CI}#compile`]: `${CI}#make` })).toEqual({ [`${CI}#build`]: `${CI}#make` });
    expect(composeNodes(a, { [`${CI}#compile/steps.x`]: `${CI}#compile/steps.y` })).toEqual({
      [`${CI}#build`]: `${CI}#compile`,
      [`${CI}#build/steps.x`]: `${CI}#compile/steps.y`,
    });
    expect(composeNodes(a, { [`${CI}#lint`]: `${CI}#build` })).toEqual({
      [`${CI}#build`]: `${CI}#compile`,
      [`${CI}#lint`]: `${CI}#build`,
    });
  });

  it('drops the ids an undo brings back to themselves', () => {
    const a = { [`${CI}#build`]: `${CI}#compile` };
    expect(composeNodes(a, inverse({ nodes: a, ids: [] }).nodes)).toEqual({});
  });
});

describe('renamedUi', () => {
  it('opens the renamed cards under their new ids too, keeping the old ones for the picture on screen', () => {
    const ui = {
      expanded: [`${CI}#build`, `${CI}#lint`],
      representative: { [`${CI}#build`]: `${CI}#build[os=a]` },
      opened: [`${CI}#build>${DEPLOY}`],
    };
    expect(renamedUi(ui, { [`${CI}#build`]: `${CI}#compile` })).toEqual({
      expanded: [`${CI}#build`, `${CI}#lint`, `${CI}#compile`],
      representative: { [`${CI}#build`]: `${CI}#build[os=a]`, [`${CI}#compile`]: `${CI}#compile[os=a]` },
      opened: [`${CI}#build>${DEPLOY}`, `${CI}#compile>${DEPLOY}`],
    });
    expect(renamedUi(ui, { [`${CI}#test`]: `${CI}#check` })).toBe(ui);
  });
});

describe('renamedUnit', () => {
  it('follows a job renamed in every unit path that starts with it, as the engine matches ids: exactly', () => {
    expect(renamedUnit('build', job)).toBe('compile');
    expect(renamedUnit('build[os=a].#2', job)).toBe('compile[os=a].#2');
    expect(renamedUnit('Build', job)).toBe('Build');
    expect(renamedUnit('build.detect/inner', job)).toBe('compile.detect/inner');
    expect(renamedUnit('ci.yml:build.detect', job)).toBe('ci.yml:compile.detect');
    expect(renamedUnit('builder', job)).toBe('builder');
    expect(renamedUnit('caller/build', job)).toBe('caller/build');
  });

  it('follows a step id renamed in its job, whatever leg', () => {
    expect(renamedUnit('build.detect', step)).toBe('build.probe');
    expect(renamedUnit('build[os=a,node=22.x].detect/inner', step)).toBe('build[os=a,node=22.x].probe/inner');
    expect(renamedUnit('build.Detect', step)).toBe('build.Detect');
    expect(renamedUnit('build.#1', step)).toBe('build.#1');
    expect(renamedUnit('test.detect', step)).toBe('test.detect');
  });
});

describe('renamedAssume', () => {
  const world = (others: World['others'] = () => false): World => ({
    others,
    fileOf: () => undefined,
    callee: () => undefined,
  });
  const none = world();
  it('renames the job and step paths of the file’s entries, qualified or not', () => {
    const assume: AssumeEntry[] = [
      { job: 'build', outcome: 'failure' },
      { workflow: 'ci.yml', step: 'build.detect', outcome: 'success' },
      { step: 'deploy.yml:build.detect', outcome: 'success' },
      { uses: 'actions/cache', job: 'lint', as: 'hit' },
    ];
    expect(renamedAssume(assume, [job], none)).toEqual([
      { job: 'compile', outcome: 'failure' },
      { workflow: 'ci.yml', step: 'compile.detect', outcome: 'success' },
      { step: 'deploy.yml:build.detect', outcome: 'success' },
      { uses: 'actions/cache', job: 'lint', as: 'hit' },
    ]);
    expect(renamedAssume(assume, [step], none)[1]).toEqual({
      workflow: 'ci.yml',
      step: 'build.probe',
      outcome: 'success',
    });
  });

  it('keeps what an unqualified entry covers: qualified when another workflow has the new id, copied when the old', () => {
    const assume: AssumeEntry[] = [{ job: 'build', outcome: 'failure' }];
    const has = (id: string) => world((file, other) => file === CI && other === id);
    expect(renamedAssume(assume, [job], has('compile'))).toEqual([
      { job: 'compile', outcome: 'failure', workflow: 'ci.yml' },
    ]);
    expect(renamedAssume(assume, [job], has('build'))).toEqual([
      { job: 'build', outcome: 'failure' },
      { job: 'compile', outcome: 'failure', workflow: 'ci.yml' },
    ]);
    expect(renamedAssume(assume, [{ ...job, from: 'lint', job: 'lint' }], none)).toBe(assume);
  });
});

describe('the store and a rename', () => {
  const renames: Renames = { nodes: { [`${CI}#build`]: `${CI}#compile` }, ids: [job] };

  function opened() {
    const store = createSessionStore();
    const s = store.getState();
    s.setFiles({ [CI]: 'jobs:\n  build: {}\n' }, FOLDER);
    s.toggleExpanded(`${CI}#build`);
    s.setAssume([{ job: 'build', outcome: 'failure' }]);
    s.hoverUnknown('u1');
    return store;
  }

  const tx = { label: 'Renamed job build to compile', origin: 'op', renames } as const;
  const edits = [{ from: 8, to: 13, insert: 'compile' }];

  it('remaps the open cards and the assume entries in the commit that renames, and clears the hovered unknown', () => {
    const store = opened();
    expect(store.getState().transact({ ...tx, files: [{ path: CI, edits }] }).ok).toBe(true);
    const s = store.getState();
    expect(s.files.byPath[CI]).toBe('jobs:\n  compile: {}\n');
    expect(s.ui.expanded).toEqual([`${CI}#build`, `${CI}#compile`]);
    expect(s.assume).toEqual([{ job: 'compile', outcome: 'failure' }]);
    expect(s.hoveredUnknown).toBeUndefined();
    expect(s.edit.past.at(-1)?.renames).toEqual({
      ...renames,
      assume: {
        before: [{ job: 'build', outcome: 'failure' }],
        after: [{ job: 'compile', outcome: 'failure' }],
      },
    });
  });

  it('maps back on undo and forth on redo', () => {
    const store = opened();
    store.getState().transact({ ...tx, files: [{ path: CI, edits }] });
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().assume).toEqual([{ job: 'build', outcome: 'failure' }]);
    expect(store.getState().redo()).toBe(true);
    expect(store.getState().assume).toEqual([{ job: 'compile', outcome: 'failure' }]);
  });

  it('keeps the change it opens answerable by the plan of the renamed entries', () => {
    const store = opened();
    const s = store.getState();
    const plan = simulate({ project: loadFiles({}), scenario: { event: 'push' }, detail: 'steps' });
    const { version, epoch } = s.files;
    s.planReceived({
      plan,
      derived: {
        unitPaths: {},
        kinds: {},
        clauses: {},
        decidingIndex: {},
        decidingLoc: {},
        decidingNeeds: {},
        unknownPaths: {},
      },
      text: '',
      ms: { simulate: 0, derive: 0 },
      for: { files: version, epoch, project: 1, assume: s.assume, scenario: s.scenario },
    });
    store.getState().transact({ ...tx, files: [{ path: CI, edits }] });
    const change = store.getState().change;
    expect(change?.renames).toEqual(renames.nodes);
    expect(change?.before?.for.assume).toBe(store.getState().assume);
    // Undone in the same burst, the ids come back to themselves: nothing is renamed.
    store.getState().undo();
    expect(store.getState().change?.renames).toEqual({});
  });

  it('a commit without renames leaves the ids alone', () => {
    const store = opened();
    store.getState().transact({ label: 'Edited', origin: 'op', files: [{ path: CI, edits }] });
    expect(store.getState().assume).toEqual([{ job: 'build', outcome: 'failure' }]);
    expect(store.getState().hoveredUnknown).toBe('u1');
  });
});
