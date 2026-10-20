import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffLines, type Hunk, hunksOf, type LineChange, linesOf, statsOf } from '../src/lib/line-diff';

/** `a` with the changes applied: what the diff says `b` is. */
function applied(a: readonly string[], b: readonly string[], changes: readonly LineChange[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const c of changes) {
    out.push(...a.slice(at, c.aFrom), ...b.slice(c.bFrom, c.bTo));
    at = c.aTo;
  }
  return [...out, ...a.slice(at)];
}

/** `a` with the hunks applied, each checked against the lines it says it removes and keeps. */
function patched(a: readonly string[], hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    out.push(...a.slice(at, h.aStart));
    let i = h.aStart;
    for (const line of h.lines) {
      if (line.kind !== '+') expect(a[i++]).toBe(line.text);
      if (line.kind !== '-') out.push(line.text);
    }
    expect(i - h.aStart).toBe(h.aCount);
    at = i;
  }
  return [...out, ...a.slice(at)];
}

/** The longest common subsequence's length, by the textbook table: the size any shortest script has to match. */
function lcs(a: readonly string[], b: readonly string[]): number {
  let row = Array.from({ length: b.length + 1 }, () => 0);
  for (const line of a) {
    const next = [0];
    for (let j = 0; j < b.length; j++)
      next.push(line === b[j] ? row[j]! + 1 : Math.max(row[j + 1]!, next[j]!));
    row = next;
  }
  return row[b.length]!;
}

// Few distinct lines, so the lists share many and the search has real work to do.
const lines = fc.array(fc.constantFrom('a\n', 'b\n', 'c\n', 'd\r\n', 'e'), { maxLength: 40 });

describe('linesOf', () => {
  it('keeps each line break, CRLF whole, and a last line without one', () => {
    expect(linesOf('')).toEqual([]);
    expect(linesOf('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(linesOf('a\n')).toEqual(['a\n']);
    expect(linesOf('a\rb')).toEqual(['a\rb']);
  });

  it('gives the text back joined', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(linesOf(text).join('')).toBe(text);
      }),
    );
  });
});

describe('diffLines', () => {
  it("applying a's diff to a gives b", () => {
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        expect(applied(a, b, diffLines(a, b))).toEqual(b);
      }),
      { numRuns: 500 },
    );
  });

  it('removes and adds as few lines as possible', () => {
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        const { added, removed } = statsOf(diffLines(a, b));
        const common = lcs(a, b);
        expect(removed).toBe(a.length - common);
        expect(added).toBe(b.length - common);
      }),
      { numRuns: 500 },
    );
  });

  it('gives changes in order that never touch', () => {
    fc.assert(
      fc.property(lines, lines, (a, b) => {
        const changes = diffLines(a, b);
        for (const [i, c] of changes.entries()) {
          expect(c.aTo - c.aFrom + (c.bTo - c.bFrom)).toBeGreaterThan(0);
          const next = changes[i + 1];
          if (next) expect(next.aFrom > c.aTo && next.bFrom > c.bTo).toBe(true);
        }
      }),
    );
  });

  it('says nothing of equal lists, and replaces lists that share no line', () => {
    expect(diffLines(['a\n', 'b\n'], ['a\n', 'b\n'])).toEqual([]);
    expect(diffLines(['a\n'], ['b\n', 'c\n'])).toEqual([{ aFrom: 0, aTo: 1, bFrom: 0, bTo: 2 }]);
    expect(diffLines([], ['a\n'])).toEqual([{ aFrom: 0, aTo: 0, bFrom: 0, bTo: 1 }]);
  });

  it('keeps a long file with one line changed to that line', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`);
    const b = a.with(2500, 'changed\n');
    expect(diffLines(a, b)).toEqual([{ aFrom: 2500, aTo: 2501, bFrom: 2500, bTo: 2501 }]);
  });
});

describe('hunksOf', () => {
  it('applies to a and gives b, whatever the context', () => {
    fc.assert(
      fc.property(lines, lines, fc.integer({ min: 0, max: 4 }), (a, b, context) => {
        expect(patched(a, hunksOf(a, b, diffLines(a, b), context))).toEqual(b);
      }),
      { numRuns: 500 },
    );
  });

  it('shares a hunk between changes whose context meets', () => {
    const a = linesOf('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n');
    const near = linesOf('1\nX\n3\n4\n5\n6\n7\n8\nY\n10\n11\n12\n');
    const far = linesOf('X\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\nY\n');
    expect(hunksOf(a, near, diffLines(a, near))).toHaveLength(1);
    expect(hunksOf(a, far, diffLines(a, far)).map((h) => [h.aStart, h.aCount, h.bStart, h.bCount])).toEqual([
      [0, 4, 0, 4],
      [8, 4, 8, 4],
    ]);
  });
});
