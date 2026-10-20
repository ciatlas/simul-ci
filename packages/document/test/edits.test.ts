import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyEdits, mapOffset, regionEdit, touched, type TextEdit } from '@simulci/document/edits';

type Range = { from: number; to: number };

/**
 * Whole characters that matter to offsets in a workflow file: CRLF, a tab, a combining accent, and pairs that share a
 * high surrogate (😀 😁 🙂) or a low one (😀 and U+1D200), so that a common prefix or suffix can end inside a pair.
 */
const char = fc.constantFrom('a', 'b', ' ', '\t', '\n', '\r\n', '#', 'é', '😀', '😁', '🙂', '\u{1D200}');
const wellFormed = fc.string({ unit: char, maxLength: 30 });
/** Any UTF-16 text, lone surrogates included: edits split pairs, and applying them must not care. */
const anyText = fc.oneof(
  wellFormed,
  fc.string({ unit: 'binary', maxLength: 30 }),
  fc.string({ unit: fc.constantFrom('\uD83D', '\uDE00', 'x'), maxLength: 30 }),
);

/** A text and sorted, non-overlapping edits of it: endpoints drawn from the text, sorted, then paired. */
const edited = anyText.chain((text) =>
  fc
    .array(fc.tuple(fc.nat({ max: text.length }), fc.nat({ max: text.length }), anyText), { maxLength: 6 })
    .map((raw) => ({ text, edits: editsOf(raw) })),
);

function editsOf(raw: [number, number, string][]): TextEdit[] {
  const points = raw.flatMap(([a, b]) => [a, b]).sort((a, b) => a - b);
  return raw.map(([, , insert], i) => ({ from: points[2 * i]!, to: points[2 * i + 1]!, insert }));
}

/** The text between and around the ranges. */
function gaps(text: string, ranges: readonly Range[]): string[] {
  let at = 0;
  const between = ranges.map(({ from, to }) => {
    const gap = text.slice(at, from);
    at = to;
    return gap;
  });
  return [...between, text.slice(at)];
}

/** Offsets of the text whose character no edit replaces, the end of the text included. */
function kept(text: string, edits: readonly TextEdit[]): number[] {
  const offsets = Array.from({ length: text.length + 1 }, (_, i) => i);
  return offsets.filter((x) => !edits.some(({ from, to }) => from <= x && x < to));
}

/** Code points, for comparing characters rather than UTF-16 units. */
const codePoints = (text: string) => Array.from(text);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('applyEdits', () => {
  it('reads every offset in the text before the edits', () => {
    const { text, inverse } = applyEdits('abcdef', [
      { from: 0, to: 1, insert: 'X' },
      { from: 3, to: 5, insert: '' },
      { from: 6, to: 6, insert: '!' },
    ]);
    expect(text).toBe('Xbcf!');
    expect(inverse).toEqual([
      { from: 0, to: 1, insert: 'a' },
      { from: 3, to: 3, insert: 'de' },
      { from: 4, to: 5, insert: '' },
    ]);
  });

  it('lands insertions at one offset in the order given, before a replacement that starts there', () => {
    expect(
      applyEdits('ab', [
        { from: 1, to: 1, insert: 'x' },
        { from: 1, to: 1, insert: 'y' },
      ]).text,
    ).toBe('axyb');
    expect(
      applyEdits('ab', [
        { from: 1, to: 1, insert: 'x' },
        { from: 1, to: 2, insert: 'Y' },
      ]).text,
    ).toBe('axY');
    expect(applyEdits('ab', [])).toEqual({ text: 'ab', inverse: [] });
  });

  it('is undone by its inverse, and the inverse of the inverse is the edits', () => {
    fc.assert(
      fc.property(edited, ({ text, edits }) => {
        const done = applyEdits(text, edits);
        const undone = applyEdits(done.text, done.inverse);
        expect(undone.text).toBe(text);
        expect(undone.inverse).toEqual(edits);
      }),
    );
  });

  it('keeps every unit outside what the edits wrote', () => {
    fc.assert(
      fc.property(edited, ({ text, edits }) => {
        expect(gaps(applyEdits(text, edits).text, touched(edits))).toEqual(gaps(text, edits));
      }),
    );
  });

  it('throws when an edit starts before the one before it ends', () => {
    const overlapping = fc.tuple(fc.nat(20), fc.nat(20), fc.nat(20), fc.nat(20)).map(([a, b, c, d]) => {
      const [from, to] = [Math.min(a, b), Math.max(a, b) + 1];
      const second = Math.min(c, to - 1);
      return [
        { from, to, insert: 'x' },
        { from: second, to: second + d, insert: '' },
      ];
    });
    fc.assert(
      fc.property(overlapping, (edits) => {
        const text = 'z'.repeat(50);
        expect(() => applyEdits(text, edits)).toThrow(RangeError);
        expect(() => mapOffset(edits, 0)).toThrow(RangeError);
        expect(() => touched(edits)).toThrow(RangeError);
      }),
    );
  });

  it('throws on an edit that is not a range of the text', () => {
    for (const edit of [
      { from: 2, to: 1, insert: '' },
      { from: -1, to: 0, insert: '' },
      { from: 0, to: 4, insert: '' },
      { from: 0.5, to: 1, insert: '' },
      { from: Number.NaN, to: 1, insert: '' },
    ]) {
      expect(() => applyEdits('abc', [edit])).toThrow(RangeError);
    }
    expect(() => applyEdits('abc', [{ from: 3, to: 3, insert: 'd' }])).not.toThrow();
  });
});

describe('regionEdit', () => {
  it('turns one text into the other', () => {
    fc.assert(
      fc.property(anyText, anyText, (before, after) => {
        expect(applyEdits(before, [regionEdit(before, after)]).text).toBe(after);
      }),
    );
  });

  it('turns a text into an edited copy of itself', () => {
    fc.assert(
      fc.property(edited, ({ text, edits }) => {
        const after = applyEdits(text, edits).text;
        expect(applyEdits(text, [regionEdit(text, after)]).text).toBe(after);
      }),
    );
  });

  it('covers only what differs, in whole characters', () => {
    const around = fc.tuple(wellFormed, wellFormed, wellFormed, wellFormed);
    fc.assert(
      fc.property(around, ([prefix, x, y, suffix]) => {
        const before = prefix + x + suffix;
        const after = prefix + y + suffix;
        const edit = regionEdit(before, after);
        const removed = before.slice(edit.from, edit.to);
        expect(removed).not.toMatch(LONE_SURROGATE);
        expect(edit.insert).not.toMatch(LONE_SURROGATE);
        expect(removed.length + edit.insert.length).toBeLessThanOrEqual(x.length + y.length);
        if (removed && edit.insert) {
          expect(codePoints(removed)[0]).not.toBe(codePoints(edit.insert)[0]);
          expect(codePoints(removed).at(-1)).not.toBe(codePoints(edit.insert).at(-1));
        }
      }),
    );
  });

  it('keeps a surrogate pair whole when only one half differs', () => {
    expect(regionEdit('a😀b', 'a😁b')).toEqual({ from: 1, to: 3, insert: '😁' });
    expect(regionEdit('x😀', 'x\u{1D200}')).toEqual({ from: 1, to: 3, insert: '\u{1D200}' });
    expect(regionEdit('a\r\nb', 'a\nb')).toEqual({ from: 1, to: 2, insert: '' });
  });

  it('is empty between equal texts', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const edit = regionEdit(text, text);
        expect(edit.from).toBe(edit.to);
        expect(edit.insert).toBe('');
      }),
    );
  });
});

describe('mapOffset', () => {
  // 'abcdef' → 'aXYbcZf': XY inserted at 1, 'de' (3..5) replaced by Z.
  const example: TextEdit[] = [
    { from: 1, to: 1, insert: 'XY' },
    { from: 3, to: 5, insert: 'Z' },
  ];

  it.each([
    [0, 0, 0],
    [1, 1, 3],
    [2, 4, 4],
    [3, 5, 5],
    [4, 5, 6],
    [5, 6, 6],
    [6, 7, 7],
  ])('maps %i to %i before and %i after', (offset, before, after) => {
    expect(mapOffset(example, offset)).toBe(before);
    expect(mapOffset(example, offset, -1)).toBe(before);
    expect(mapOffset(example, offset, 1)).toBe(after);
  });

  it('moves a kept character with it', () => {
    fc.assert(
      fc.property(edited, ({ text, edits }) => {
        const after = applyEdits(text, edits).text;
        for (const x of kept(text, edits).filter((offset) => offset < text.length)) {
          expect(after[mapOffset(edits, x, 1)]).toBe(text[x]);
        }
      }),
    );
  });

  it('maps a kept offset back through the inverse', () => {
    fc.assert(
      fc.property(edited, ({ text, edits }) => {
        const { inverse } = applyEdits(text, edits);
        for (const x of kept(text, edits)) expect(mapOffset(inverse, mapOffset(edits, x, 1), 1)).toBe(x);
      }),
    );
  });

  it('never reorders offsets, and maps before (-1) no later than after (1)', () => {
    fc.assert(
      fc.property(edited, ({ text, edits }) => {
        const offsets = Array.from({ length: text.length + 1 }, (_, i) => i);
        for (const assoc of [-1, 1] as const) {
          const mapped = offsets.map((x) => mapOffset(edits, x, assoc));
          expect(mapped).toEqual(mapped.toSorted((a, b) => a - b));
        }
        for (const x of offsets) expect(mapOffset(edits, x, -1)).toBeLessThanOrEqual(mapOffset(edits, x, 1));
        expect(mapOffset(edits, 0, -1)).toBe(0);
        expect(mapOffset(edits, text.length, 1)).toBe(applyEdits(text, edits).text.length);
      }),
    );
  });

  it('maps a replaced range onto its replacement', () => {
    fc.assert(
      fc.property(edited, ({ edits }) => {
        const written = touched(edits);
        for (const [i, { from, to }] of edits.entries()) {
          if (from === to) continue;
          expect(mapOffset(edits, from, 1)).toBe(written[i]!.from);
          expect(mapOffset(edits, to, -1)).toBe(written[i]!.to);
          for (let x = from + 1; x < to; x++) {
            expect(mapOffset(edits, x, -1)).toBe(written[i]!.from);
            expect(mapOffset(edits, x, 1)).toBe(written[i]!.to);
          }
        }
      }),
    );
  });
});

describe('touched', () => {
  it('gives one range per edit, where the inverse reads', () => {
    fc.assert(
      fc.property(edited, ({ text, edits }) => {
        const written = touched(edits);
        expect(written).toEqual(applyEdits(text, edits).inverse.map(({ from, to }) => ({ from, to })));
        expect(written.map(({ from, to }) => to - from)).toEqual(edits.map(({ insert }) => insert.length));
      }),
    );
  });

  it('leaves an empty range where a deletion was', () => {
    expect(
      touched([
        { from: 1, to: 3, insert: '' },
        { from: 4, to: 4, insert: 'xy' },
        { from: 4, to: 6, insert: 'z' },
      ]),
    ).toEqual([
      { from: 1, to: 1 },
      { from: 2, to: 4 },
      { from: 4, to: 5 },
    ]);
  });
});
