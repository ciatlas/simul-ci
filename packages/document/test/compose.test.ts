import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEdits, type TextEdit } from '@simulci/document/edits';
import { composeEdits } from '../src/compose';
import { runs } from './runs';

const text = fc.string({ unit: fc.constantFrom('a', 'b', '\n', '\r\n', ' ', '#'), maxLength: 30 });

/** Sorted, non-overlapping edits of a text: endpoints drawn from it, sorted, then paired. */
const editsOf = (of: string) =>
  fc
    .array(fc.tuple(fc.nat({ max: of.length }), fc.nat({ max: of.length }), text), { maxLength: 5 })
    .map((raw) => {
      const points = raw.flatMap(([a, b]) => [a, b]).sort((a, b) => a - b);
      return raw.map(([, , insert], i): TextEdit => ({
        from: points[2 * i]!,
        to: points[2 * i + 1]!,
        insert,
      }));
    });

const twoSteps = text.chain((base) =>
  editsOf(base).chain((first) =>
    editsOf(applyEdits(base, first).text).map((second) => ({ base, first, second })),
  ),
);

describe('composeEdits', () => {
  it('gives what applying both edit lists in turn gives, as sorted, non-overlapping edits', () => {
    fc.assert(
      fc.property(twoSteps, ({ base, first, second }) => {
        const composed = composeEdits(base, first, second);
        const want = applyEdits(applyEdits(base, first).text, second).text;
        const { text: got, inverse } = applyEdits(base, composed);
        expect(got).toBe(want);
        expect(applyEdits(got, inverse).text).toBe(base);
      }),
      { numRuns: runs(2000) },
    );
  });

  it('merges a rewrite of what the first step wrote into one edit of the first text', () => {
    const first = [{ from: 2, to: 2, insert: 'XY' }];
    const second = [{ from: 3, to: 4, insert: 'z' }];
    expect(composeEdits('abcd', first, second)).toEqual([{ from: 2, to: 2, insert: 'Xz' }]);
    expect(composeEdits('abcd', [{ from: 0, to: 1, insert: '' }], [{ from: 2, to: 3, insert: 'Q' }])).toEqual(
      [
        { from: 0, to: 1, insert: '' },
        { from: 3, to: 4, insert: 'Q' },
      ],
    );
  });
});
