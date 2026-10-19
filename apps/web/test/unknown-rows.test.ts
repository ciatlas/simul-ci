import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { sampleByName } from '../src/input/samples';
import {
  affectsText,
  appliedText,
  type EditorForm,
  entryOf,
  envAllowed,
  focusAfter,
  formOf,
  formProblems,
  listed,
  outcomeOptions,
  pinTarget,
  type UnknownRows,
  unitFacts,
  unknownRows,
  withoutPair,
  withPair,
  withPairEdit,
  withPreset,
  withValue,
} from '../src/panels/unknown-rows';
import { planIndex } from '../src/plan/index';
import { handle, initialState } from '../src/worker/handle';
import type { PlanResponse } from '../src/worker/protocol';

/** The worker's answer for one repository under one scenario. */
function simulated(files: Record<string, string>, scenario: ScenarioInput): PlanResponse {
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  return step.response;
}

const rowsOf = (r: PlanResponse, affecting?: string): UnknownRows =>
  unknownRows(r.plan, r.derived, planIndex(r), affecting === undefined ? {} : { affecting });
const ids = (rows: { unknown: { id: string } }[]): string[] => rows.map((row) => row.unknown.id);

const ci = '.github/workflows/ci.yml';

/**
 * A step output read by a step's and a job's `if:`, a `hashFiles` only the run knows, `github.sha` (a scenario pin),
 * and an output only an env value reads, which decides no verdict.
 */
const inline = {
  [ci]: `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      sha: \${{ steps.meta.outputs.sha }}
    steps:
      - id: meta
        uses: some/meta@v1
      - run: echo hi
        if: steps.meta.outputs.sha == 'abc'
      - run: echo
        env:
          REF: \${{ steps.meta.outputs.ref }}
  deploy:
    needs: build
    if: github.sha == 'abc' && needs.build.outputs.sha != ''
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
  hash:
    runs-on: ubuntu-latest
    steps:
      - run: echo
        if: hashFiles('x') != ''
`,
};

const starterPush = simulated(sampleByName('starter')!.files, { event: 'push', branch: 'main' });
const monorepoPr = simulated(sampleByName('monorepo')!.files, {
  event: 'pull_request',
  base: 'main',
  head: 'topic',
  number: 1,
});
const inlinePush = simulated(inline, { event: 'push', branch: 'main' });

describe('the unknowns as rows', () => {
  it('lists every unknown of a push to main in plan order, each with its unit path and what it affects', () => {
    const { gating, idle } = rowsOf(starterPush);
    expect(ids(gating)).toEqual(starterPush.plan.unknowns.map((u) => u.id));
    expect(idle).toEqual([]);
    expect(gating.map((row) => [row.path, row.kind, row.affects.map((a) => a.label)])).toEqual([
      ['build.detect.outputs.changed', 'step-output', ['~npm-run-build']],
      ['scenario.changed', 'changed-files', ['CI']],
    ]);
    expect(gating[0]!.affects).toEqual([{ id: `${ci}#build/~npm-run-build`, label: '~npm-run-build' }]);
    expect(gating[0]!.unknown.pin).toMatchObject({ layer: 'assume', fragment: { step: 'build.detect' } });
    expect(gating[1]!.unknown.pin).toMatchObject({ layer: 'scenario', fragment: { changed: ['docs/**'] } });
    for (const row of gating) expect(row.reads).toBe(row.unknown.reads);
  });

  it('names the jobs a pull request’s changed files decide in the monorepo', () => {
    const { gating, idle } = rowsOf(monorepoPr);
    expect(gating.map((row) => [row.path, row.affects])).toEqual([
      [
        'scenario.changed',
        [
          { id: `${ci}#web`, label: 'web' },
          { id: `${ci}#api`, label: 'api' },
        ],
      ],
    ]);
    expect(idle).toEqual([]);
  });

  it('keeps the unknowns that decide no verdict apart, in plan order', () => {
    const { plan } = inlinePush;
    const { gating, idle } = rowsOf(inlinePush);
    expect(ids(gating)).toEqual([
      `${ci}#build/steps.meta.outputs.sha`,
      "expression:success() && (hashFiles('x') != '')",
      'github.sha',
    ]);
    expect(idle.map((row) => [row.path, row.kind, row.affects])).toEqual([
      ['build.meta.outputs.ref', 'step-output', []],
    ]);
    // Each group in the engine's rank.
    const rank = (id: string): number => plan.unknowns.findIndex((u) => u.id === id);
    for (const group of [gating, idle]) {
      const order = ids(group).map(rank);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
    expect(gating.every((row) => row.affects.length > 0)).toBe(true);
  });

  it('keeps, affecting a node, the unknowns that affect it or a node under it', () => {
    const sha = `${ci}#build/steps.meta.outputs.sha`;
    expect(ids(rowsOf(inlinePush, `${ci}#deploy`).gating)).toEqual([sha, 'github.sha']);
    // The step output affects a step of build: build is affected through it.
    expect(ids(rowsOf(inlinePush, `${ci}#build`).gating)).toEqual([sha]);
    expect(ids(rowsOf(inlinePush, `${ci}#build/~echo-hi`).gating)).toEqual([sha]);
    expect(ids(rowsOf(inlinePush, `${ci}#build/~echo`).gating)).toEqual([]);
    // Everything that decides a verdict is under the workflow; what decides none affects nothing.
    const all = rowsOf(inlinePush, ci);
    expect(ids(all.gating)).toEqual(ids(rowsOf(inlinePush).gating));
    expect(all.idle).toEqual([]);
  });

  it('walks matrix legs and called workflows up to the node asked about', () => {
    const success = rowsOf(starterPush, `${ci}#build`);
    expect(ids(success.gating)).toEqual([`${ci}#build/steps.detect.outputs.changed`]);
    expect(ids(rowsOf(starterPush, `${ci}#test`).gating)).toEqual([]);
    expect(ids(rowsOf(starterPush, `${ci}#test[node=22]`).gating)).toEqual([]);
    // The changed files affect the job that calls package.yml, not the jobs inside it.
    expect(ids(rowsOf(monorepoPr, `${ci}#web`).gating)).toEqual(['scenario.changed']);
    expect(ids(rowsOf(monorepoPr, `${ci}#web>.github/workflows/package.yml#test`).gating)).toEqual([]);
    expect(ids(rowsOf(monorepoPr, `${ci}#gate`).gating)).toEqual([]);
    // A node the plan does not have affects nothing.
    expect(ids(rowsOf(monorepoPr, `${ci}#gone`).gating)).toEqual([]);
  });

  it('falls back to the unknown’s id and a node’s unit path when the tables lack them', () => {
    const { plan, derived } = inlinePush;
    const bare = { ...derived, unknownPaths: {} };
    const rows = unknownRows(
      { ...plan, unknowns: [{ id: 'x.y', kind: 'unsupported', reads: [], affects: [`${ci}#gone`] }] },
      { ...bare, unitPaths: { ...derived.unitPaths, [`${ci}#gone`]: 'gone' } },
      planIndex(inlinePush),
    );
    expect(rows.gating.map((row) => [row.path, row.affects])).toEqual([
      ['x.y', [{ id: `${ci}#gone`, label: 'gone' }]],
    ]);
    const unnamed = unknownRows(
      { ...plan, unknowns: [{ id: 'x.y', kind: 'unsupported', reads: [], affects: ['nowhere'] }] },
      bare,
      planIndex(inlinePush),
    );
    expect(unnamed.gating[0]!.affects).toEqual([{ id: 'nowhere', label: 'nowhere' }]);
  });
});

describe('the words of a row', () => {
  it('counts what an unknown affects and names it', () => {
    expect(affectsText([{ id: 'a', label: 'build' }])).toEqual({ text: 'affects 1', names: 'build' });
    expect(
      affectsText([
        { id: 'a', label: 'build' },
        { id: 'b', label: 'deploy' },
        { id: 'c', label: 'CI' },
      ]),
    ).toEqual({ text: 'affects 3', names: 'build, deploy and CI' });
    expect(listed([])).toBe('');
    expect(listed(['a', 'b'])).toBe('a and b');
  });

  it('says where an entry applied, the fields it provided grouped', () => {
    expect(appliedText([])).toBe('applied nowhere');
    expect(appliedText([{ at: 'build.detect', provides: ['outcome', 'outputs.sha'] }])).toBe(
      'applied at build.detect, provides outcome, outputs.sha',
    );
    expect(
      appliedText([
        { at: 'test[node=22]', provides: ['outcome'] },
        { at: 'test[node=24]', provides: ['outcome'] },
        { at: 'deploy', provides: [] },
      ]),
    ).toBe('applied at test[node=22] and test[node=24], provides outcome; applied at deploy');
  });
});

describe('the focus after a pin', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('goes to the next row the new plan still has', () => {
    expect(focusAfter(order, 'b', new Set(['a', 'c', 'd']))).toBe('c');
    // The pin settled the next row too.
    expect(focusAfter(order, 'b', new Set(['a', 'd']))).toBe('d');
  });

  it('goes back to the nearest row before when none follows, and to the heading when none is left', () => {
    expect(focusAfter(order, 'd', new Set(['a', 'b']))).toBe('b');
    expect(focusAfter(order, 'c', new Set(['a']))).toBe('a');
    expect(focusAfter(order, 'b', new Set())).toBeUndefined();
    expect(focusAfter(order, 'gone', new Set(['c', 'd']))).toBe('c');
  });
});

describe('the PinEditor’s fields', () => {
  const draft: AssumeEntry = { step: 'build.detect', outputs: { changed: '' } };

  it('read an entry and state it back in a test file’s order', () => {
    const entry: AssumeEntry = {
      env: { NAME: 'x' },
      outputs: { count: 2, hit: true, gone: { unknown: true }, sha: 'abc' },
      outcome: 'failure',
      step: 'build.detect',
      matrix: { node: 22 },
      workflow: 'ci.yml',
    };
    const form = formOf(entry);
    expect(form).toEqual({
      outcome: 'failure',
      outputs: [
        { id: 0, name: 'count', value: '2', held: 2 },
        { id: 1, name: 'hit', value: 'true', held: true },
        { id: 2, name: 'gone', value: '', held: { unknown: true } },
        { id: 3, name: 'sha', value: 'abc' },
      ],
      env: [{ id: 4, name: 'NAME', value: 'x' }],
    });
    const back = entryOf(entry, form);
    expect(back).toEqual(entry);
    expect(Object.keys(back)).toEqual(['step', 'matrix', 'workflow', 'outcome', 'outputs', 'env']);
    expect(formOf({ job: 'deploy', as: 'hit' })).toEqual({
      outcome: 'none',
      outputs: [],
      env: [],
      as: 'hit',
    });
  });

  it('leave out what states nothing: no outcome, rows without a name', () => {
    const form: EditorForm = {
      outcome: 'none',
      outputs: [
        { id: 0, name: ' changed ', value: 'true' },
        { id: 1, name: '', value: '' },
      ],
      env: [{ id: 2, name: '', value: '' }],
    };
    expect(entryOf({ ...draft, outcome: 'success', as: 'x' }, form)).toEqual({
      step: 'build.detect',
      outputs: { changed: 'true' },
    });
    expect(entryOf(draft, { outcome: 'cancelled', outputs: [], env: [], as: 'miss' })).toEqual({
      step: 'build.detect',
      outcome: 'cancelled',
      as: 'miss',
    });
  });

  it('say what is wrong before the schema does, on the row it is about: a value without a name, a name given twice', () => {
    expect(formProblems(formOf(draft))).toEqual([]);
    const form: EditorForm = {
      outcome: 'none',
      outputs: [
        { id: 0, name: '', value: 'true' },
        { id: 1, name: 'a', value: '1' },
        { id: 2, name: 'a ', value: '2' },
        { id: 6, name: '', value: '' },
        { id: 7, name: 'a', value: '3' },
      ],
      env: [
        { id: 3, name: '', value: '', held: 3 },
        { id: 4, name: 'B', value: '' },
        { id: 5, name: 'B', value: '' },
      ],
    };
    expect(formProblems(form)).toEqual([
      { field: 'outputs', pair: 0, message: 'output 1 has a value but no name' },
      { field: 'outputs', pair: 2, message: 'outputs 2 and 3 are both named a' },
      { field: 'outputs', pair: 7, message: 'outputs 2 and 5 are both named a' },
      { field: 'env', pair: 3, message: 'env write 1 has a value but no name' },
      { field: 'env', pair: 5, message: 'env writes 2 and 3 are both named B' },
    ]);
  });

  it('add, edit and remove rows; typing a value drops the one it held', () => {
    let form = formOf({ step: 's', outputs: { n: 1 } });
    form = withPair(form, 'env');
    form = withPair(form, 'outputs');
    expect(form.env).toEqual([{ id: 1, name: '', value: '' }]);
    expect(form.outputs.at(-1)).toEqual({ id: 2, name: '', value: '' });
    form = withPairEdit(form, 'outputs', 0, { name: 'count' });
    expect(form.outputs[0]).toEqual({ id: 0, name: 'count', value: '1', held: 1 });
    form = withPairEdit(form, 'outputs', 0, { value: '2' });
    expect(form.outputs[0]).toEqual({ id: 0, name: 'count', value: '2' });
    form = withoutPair(form, 'outputs', 2);
    expect(form.outputs.map((p) => p.id)).toEqual([0]);
    expect(withPair(formOf({ step: 's', outcome: 'success' }), 'outputs').outputs).toEqual([
      { id: 0, name: '', value: '' },
    ]);
  });

  it('write a candidate into its row, or a new row for it', () => {
    const form = formOf(draft);
    expect(withValue(form, 'outputs', 'changed', 'true').outputs).toEqual([
      { id: 0, name: 'changed', value: 'true' },
    ]);
    expect(withValue(form, 'outputs', 'other', 'x').outputs).toEqual([
      { id: 0, name: 'changed', value: '' },
      { id: 1, name: 'other', value: 'x' },
    ]);
  });

  it('write a preset as as:, dropping the rows still empty, and clear it again', () => {
    const form: EditorForm = {
      outcome: 'none',
      outputs: [
        { id: 0, name: 'cache-hit', value: '' },
        { id: 1, name: 'key', value: 'k' },
        { id: 2, name: 'gone', value: '', held: { unknown: true } },
      ],
      env: [{ id: 3, name: 'X', value: '' }],
    };
    const hit = withPreset(form, 'hit');
    expect(hit).toEqual({
      outcome: 'none',
      outputs: [form.outputs[1], form.outputs[2]],
      env: [],
      as: 'hit',
    });
    expect(entryOf({ step: 'build.cache' }, hit)).toEqual({
      step: 'build.cache',
      outputs: { key: 'k', gone: { unknown: true } },
      as: 'hit',
    });
    const cleared = withPreset(hit, undefined, form);
    expect(cleared).not.toHaveProperty('as');
    expect(cleared.outputs).toBe(hit.outputs);
  });

  it('bring the draft’s fields back when clearing the preset leaves nothing stated', () => {
    const draftForm = formOf({ step: 'build.cache', outputs: { 'cache-hit': '' } });
    const hit = withPreset(draftForm, 'hit');
    expect(entryOf({ step: 'build.cache' }, hit)).toEqual({ step: 'build.cache', as: 'hit' });
    expect(withPreset(hit, undefined, draftForm)).toEqual(draftForm);
    expect(withPreset(hit, undefined)).toEqual({ outcome: 'none', outputs: [], env: [] });
    // An entry that was only a preset has nothing to bring back.
    const preset = formOf({ step: 'build.cache', as: 'miss' });
    expect(withPreset(preset, undefined, preset)).toEqual({ outcome: 'none', outputs: [], env: [] });
  });

  it('edit the entry that already states what a pin is about, instead of adding one that conflicts (SC103)', () => {
    const pin = {
      entry: { step: 'build.detect', outputs: { changed: '' } },
      about: { field: 'outputs' as const, name: 'changed' },
      outcomes: ['success' as const, 'failure' as const],
      candidates: [],
    };
    const stated: AssumeEntry = { step: 'build.detect', outputs: { changed: 'true' }, outcome: 'success' };
    const other: AssumeEntry = { job: 'build', outputs: { changed: 'x' } };
    const target = pinTarget([other, stated], pin);
    expect(target.replaces).toBe(stated);
    expect(target.draft).toEqual({ ...pin, entry: stated });
    // A preset may state the output: the editor adds the draft's row to it.
    const preset: AssumeEntry = { step: 'build.detect', as: 'hit' };
    expect(pinTarget([preset], pin)).toEqual({
      draft: { ...pin, entry: { step: 'build.detect', as: 'hit', outputs: { changed: '' } } },
      replaces: preset,
    });
    // Another output of the unit, another unit, another workflow: a new entry.
    const elsewhere: AssumeEntry[] = [
      { step: 'build.detect', outputs: { other: '1' } },
      other,
      { workflow: 'ci.yml', step: 'build.detect', outputs: { changed: 'true' } },
    ];
    expect(pinTarget(elsewhere, pin)).toEqual({ draft: pin });
  });

  it('edit the entry that states the outcome a pin is about, and give a preset entry the draft’s outcome', () => {
    const pin = {
      entry: { job: 'build', outcome: 'failure' as const },
      about: { field: 'outcome' as const },
      outcomes: ['success' as const, 'failure' as const, 'cancelled' as const],
      candidates: [],
    };
    const cancelled: AssumeEntry = { job: 'build', outcome: 'cancelled' };
    expect(pinTarget([cancelled], pin)).toEqual({ draft: { ...pin, entry: cancelled }, replaces: cancelled });
    const preset: AssumeEntry = { job: 'build', as: 'x' };
    expect(pinTarget([preset], pin).draft.entry).toEqual({ job: 'build', as: 'x', outcome: 'failure' });
    expect(pinTarget([{ job: 'build', outputs: { a: '1' } }], pin)).toEqual({ draft: pin });
  });

  it('offer the unit’s outcomes, the entry’s own and none', () => {
    expect(outcomeOptions(['success', 'failure'], 'failure')).toEqual(['success', 'failure', 'none']);
    expect(outcomeOptions(['success', 'failure'], 'cancelled')).toEqual([
      'success',
      'failure',
      'cancelled',
      'none',
    ]);
    expect(outcomeOptions(['success', 'failure', 'cancelled'], 'none')).toEqual([
      'success',
      'failure',
      'cancelled',
      'none',
    ]);
  });

  it('show the unit read-only and allow env writes where the schema does', () => {
    expect(
      unitFacts({ workflow: 'ci.yml', job: 'test', matrix: { node: 22, os: 'linux' }, outcome: 'failure' }),
    ).toEqual([
      ['workflow', 'ci.yml'],
      ['job', 'test'],
      ['matrix', 'node=22, os=linux'],
    ]);
    expect(unitFacts({ job: 'build', uses: 'actions/cache', as: 'hit' })).toEqual([
      ['job', 'build'],
      ['uses', 'actions/cache'],
    ]);
    expect(envAllowed({ step: 'build.detect', outcome: 'success' })).toBe(true);
    expect(envAllowed({ job: 'build', uses: 'actions/cache', as: 'hit' })).toBe(true);
    expect(envAllowed({ job: 'build', outcome: 'success' })).toBe(false);
  });
});
