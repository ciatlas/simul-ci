import * as fc from 'fast-check';
import { LineCounter, parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { Lines } from '../src/lines';
import { runs } from './runs';

describe('Lines', () => {
  it('ends a line after its \\n, as yaml counts them; a lone \\r is not a break', () => {
    const lines = new Lines('a: 1\r\nb: 2\rc\n\nd');
    expect(lines.starts).toEqual([0, 6, 13, 14]);
    expect([0, 1, 2, 3].map((l) => lines.textOf(l))).toEqual(['a: 1', 'b: 2\rc', '', 'd']);
    expect(lines.breakAt(0)).toBe(4);
    expect(lines.breakAt(3)).toBe(15);
    expect(lines.end(3)).toBe(15);
  });

  it('puts a line break on the line it ends', () => {
    const lines = new Lines('ab\r\ncd\n');
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((o) => lines.lineAt(o))).toEqual([0, 0, 0, 0, 1, 1, 1, 2]);
    expect(lines.count).toBe(3);
    expect(lines.textOf(2)).toBe('');
    // The last line has no break of its own: the text's final one ends the line before it.
    expect(lines.breakAt(2)).toBe(7);
    expect(lines.breakAt(1)).toBe(6);
  });

  it('agrees with yaml’s LineCounter on what yaml parses', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', ' ', '\n', '\r', '\r\n', '#', ': ', '- ') }),
        (text) => {
          const lines = new Lines(text);
          expect(lines.starts).toEqual([0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)]);
          // After an error yaml's lexer may stop reporting line breaks; core only reads positions in files that parse.
          const counter = new LineCounter();
          if (parseDocument(text, { lineCounter: counter, strict: false }).errors.length > 0) return;
          expect(lines.starts).toEqual(counter.lineStarts);
          for (let at = 0; at <= text.length; at++) {
            const { line, col } = counter.linePos(at);
            expect(lines.position(at)).toEqual({ line, column: col });
            expect(lines.offsetOf(line, col)).toBe(at);
          }
        },
      ),
      { numRuns: runs(300) },
    );
  });

  it('tells blank, comment and content lines apart, with their indentation', () => {
    const lines = new Lines('  \n  # c\n\tx: 1\n');
    expect([0, 1, 2, 3].map((l) => lines.kind(l))).toEqual([
      { kind: 'blank', indent: 2 },
      { kind: 'comment', indent: 2 },
      { kind: 'content', indent: 1 },
      { kind: 'blank', indent: 0 },
    ]);
  });

  it('knows whether only indentation comes before an offset', () => {
    const lines = new Lines('  - name: x\n');
    expect(lines.startsLine(2)).toBe(true);
    expect(lines.startsLine(4)).toBe(false);
    expect(lines.column(4)).toBe(4);
  });

  it('clamps 1-based positions to the text', () => {
    const lines = new Lines('ab\ncd');
    expect(lines.offsetOf(0, 0)).toBe(0);
    expect(lines.offsetOf(9, 1)).toBe(3);
    expect(lines.offsetOf(2, 9)).toBe(5);
  });
});
