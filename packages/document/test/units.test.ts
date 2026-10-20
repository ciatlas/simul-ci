import { describe, expect, it } from 'vitest';
import { WorkflowDocument } from '@simulci/document';
import { dealiasAnchorDraft, dealiasDraft } from '../src/dealias';
import { flowText, simpleFlow } from '../src/flow';
import { entryEquivalents, equivalents } from '../src/guard';
import { insertDraft, moveDraft } from '../src/insert';
import { deleteIn, insertIn, moveIn, renameIn, setIn } from '../src/json';
import { convertEolDraft, renameKeyDraft, replaceAtDraft } from '../src/primitives';
import { removeDraft } from '../src/remove';
import { placement, setDraft } from '../src/set';
import { locate, type Collection } from '../src/tree';
import { difference } from '../src/verify';
import { fixture } from './corpus';

const open = (text: string) => WorkflowDocument.open(text, { path: 'ci.yml', kind: 'workflow' });

describe('key placement (§ 3.5, the prototype’s rule)', () => {
  const order = ['name', 'runs-on', 'needs', 'if', 'steps'];
  it('goes after the present key ranked highest below it', () => {
    expect(placement(['needs', 'runs-on', 'steps'], 'if', order)).toEqual({ anchor: 0 });
    expect(placement(['runs-on', 'steps'], 'needs', order)).toEqual({ anchor: 0 });
  });
  it('else before the first key ranked above it, else last; unknown keys go last', () => {
    expect(placement(['runs-on', 'steps'], 'name', order)).toEqual({ before: 0 });
    expect(placement(['x', 'y'], 'name', order)).toEqual({ anchor: 1 });
    expect(placement(['runs-on'], 'other', order)).toEqual({ anchor: 0 });
    expect(placement(['runs-on'], 'if', undefined)).toEqual({ anchor: 0 });
    expect(placement([], 'if', order)).toEqual({});
  });
});

describe('the drafts’ meanings, the second definition the check compares with', () => {
  const doc = open(fixture('events.yml'));
  const js = () => structuredClone(doc.tree.doc!.toJS()) as Record<string, unknown>;
  const meaning = (draft: unknown) => (draft as { expect: (v: unknown) => unknown }).expect(js());

  it('set, insert, move, remove, rename', () => {
    expect(
      meaning(setDraft(doc, ['jobs', 'build', 'timeout-minutes'], '45', { as: 'number' })),
    ).toMatchObject({ jobs: { build: { 'timeout-minutes': 45 } } });
    expect(
      meaning(setDraft(doc, ['jobs', 'build', 'continue-on-error'], 'true', { as: 'boolean' })),
    ).toMatchObject({ jobs: { build: { 'continue-on-error': true } } });
    expect(
      (meaning(insertDraft(doc, ['jobs', 'build', 'steps'], 0, 'x')) as never)['jobs']['build']['steps'][0],
    ).toBe('x');
    expect(
      (meaning(moveDraft(doc, ['jobs', 'build', 'steps'], 0, 2)) as never)['jobs']['build']['steps'][2],
    ).toMatchObject({ uses: 'actions/checkout@v4' });
    expect(meaning(removeDraft(doc, ['on', 'push', 'branches', 0]))).toMatchObject({
      on: { push: { branches: null } },
    });
    expect(meaning(renameKeyDraft(doc, ['jobs', 'build'], 'test'))).toMatchObject({ jobs: { test: {} } });
    expect(meaning(convertEolDraft(doc, '\r\n'))).toEqual(js());
    expect(replaceAtDraft(doc, { from: 0, to: 4 }, 'name', 'NAME')).not.toHaveProperty('expect');
  });

  it('dealias and dealiasAnchor mean no change', () => {
    const shared = open(fixture('shared.yml'));
    const value = shared.tree.doc!.toJS();
    expect(
      (dealiasDraft(shared, ['jobs', 'again']) as { expect: (v: unknown) => unknown }).expect(value),
    ).toBe(value);
    expect((dealiasAnchorDraft(shared, 'job') as { expect: (v: unknown) => unknown }).expect(value)).toBe(
      value,
    );
  });

  it('follow every use of an anchor when every use is changed', () => {
    const anchored = open(fixture('anchored-runs-on.yml'));
    expect(equivalents(anchored, ['jobs', 'build', 'runs-on'])).toEqual([
      ['jobs', 'build', 'runs-on'],
      ['jobs', 'deploy', 'runs-on'],
    ]);
    expect(entryEquivalents(anchored, ['jobs', 'build', 'runs-on'])).toEqual([['jobs', 'build', 'runs-on']]);
  });
});

describe('plain-JSON edits', () => {
  it('set, delete with emptied, insert, move, rename', () => {
    expect(setIn({ a: null }, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
    expect(setIn(null, [], 2)).toBe(2);
    expect(deleteIn({ a: { b: [1] } }, ['a', 'b', 0])).toEqual({ a: { b: null } });
    expect(deleteIn({ a: { b: [1] } }, ['a', 'b', 0], 'remove')).toEqual({ a: null });
    expect(deleteIn({ a: 1 }, ['x', 'y'])).toEqual({ a: 1 });
    expect(insertIn({ a: null }, ['a'], 0, 1)).toEqual({ a: [1] });
    expect(moveIn({ a: [1, 2, 3] }, ['a'], 0, 2)).toEqual({ a: [2, 3, 1] });
    expect(Object.keys(renameIn({ a: 1, b: 2 }, ['a'], 'c') as object)).toEqual(['c', 'b']);
  });

  it('tells where two values first differ, maps in any order', () => {
    expect(difference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }, '')).toBeUndefined();
    expect(difference({ a: 1, b: 2 }, { b: 2, a: 1 }, '')).toBeUndefined();
    expect(difference({ a: [1, 2] }, { a: [2, 1] }, '')).toBe('/a/0');
    expect(difference({ a: 1 }, { b: 1 }, '')).toBe('/a');
    expect(difference([1], [1, 2], '')).toBe('');
  });
});

describe('flow collections', () => {
  it('are spliced only on one line with nothing nested', () => {
    const doc = open('a: [x, y]\nb: [x,\n  y]\nc: [[x]]\n');
    const seq = (key: string) => locate(doc.tree, [key])!.node as Collection;
    expect(simpleFlow(doc, seq('a'), ['a'])).toBeUndefined();
    expect(simpleFlow(doc, seq('b'), ['b'])?.reason).toBe('flow-shape');
    expect(simpleFlow(doc, seq('c'), ['c'])?.reason).toBe('flow-shape');
    expect(flowText(doc, 'v', 'k: x')).toBe("'k: x': v");
  });
});
