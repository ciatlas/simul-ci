import { ChangeSet, EditorState, Text } from '@codemirror/state';
import { applyEdits } from '@simulci/document/edits';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { emptyHistory, typed, undo } from '../src/state/history';
import { type Eol, lineStarts, toChanges, toTextEdits } from '../src/yaml/bridge';
import { runs } from './runs';

/** A document as CodeMirror makes one of a text: lines split at CRLF, CR and LF. */
const docOf = (text: string): Text => EditorState.create({ doc: text }).doc;

describe('the CodeMirror bridge', () => {
  it('splits lines as CodeMirror does, a lone CR included', () => {
    expect(lineStarts('a\r\nb\nc\rd')).toEqual([0, 3, 5, 7]);
    expect(lineStarts('')).toEqual([0]);
    expect(lineStarts('x\r\n')).toEqual([0, 3]);
  });

  it('maps a CRLF document’s positions to the store’s offsets, and inserts line breaks in its ending', () => {
    const text = 'on: push\r\njobs:\r\n  a: 1\r\n';
    const doc = docOf(text);
    // CodeMirror counts each break as one: the doc is 3 positions shorter than the text.
    expect(doc.length).toBe(text.length - 3);
    // Enter at the end of `jobs:`, then two spaces: what a typed line break makes.
    const pos = doc.line(2).to;
    const changes = ChangeSet.of([{ from: pos, insert: '\n  ' }], doc.length);
    const edits = toTextEdits(doc, changes, text, '\r\n');
    expect(edits).toEqual([{ from: 15, to: 15, insert: '\r\n  ' }]);
    expect(applyEdits(text, edits).text).toBe('on: push\r\njobs:\r\n  \r\n  a: 1\r\n');
    // Deleting a line break deletes both its characters.
    const join = ChangeSet.of([{ from: doc.line(1).to, to: doc.line(2).from }], doc.length);
    expect(applyEdits(text, toTextEdits(doc, join, text, '\r\n')).text).toBe('on: pushjobs:\r\n  a: 1\r\n');
  });

  it('brings the store’s edits back as changes of the document', () => {
    const text = 'a\r\nbb\r\nccc';
    const doc = docOf(text);
    const edits = [
      { from: 3, to: 5, insert: 'X' },
      { from: 7, to: 7, insert: 'Y\r\n' },
    ];
    const changes = ChangeSet.of(toChanges(doc, text, edits), doc.length);
    expect(changes.apply(doc).sliceString(0, undefined, '\r\n')).toBe(applyEdits(text, edits).text);
  });
});

/** A text of lines with one line ending throughout. */
const textOf = (lines: string[], eol: Eol): string => lines.join(eol);

const line = fc.string({ unit: fc.constantFrom('a', ' ', ':', 'é', '😀', '-'), maxLength: 8 });

/** A random change set over a document: sorted, non-overlapping ranges, inserts of text with any line breaks. */
const changesOver = (doc: Text) =>
  fc
    .array(
      fc.tuple(
        fc.nat({ max: doc.length }),
        fc.nat({ max: 4 }),
        fc.string({ unit: fc.constantFrom('x', '\n', '\r\n', '\r', ' ', '😀'), maxLength: 5 }),
      ),
      { maxLength: 4 },
    )
    .map((parts) => {
      const sorted = parts.map(([from, len, insert]) => ({
        from,
        to: Math.min(doc.length, from + len),
        insert,
      }));
      sorted.sort((a, b) => a.from - b.from || a.to - b.to);
      const specs: { from: number; to: number; insert: string }[] = [];
      let end = 0;
      for (const s of sorted) {
        if (s.from < end) continue;
        specs.push(s);
        end = s.to;
      }
      return ChangeSet.of(specs, doc.length);
    });

describe('the CodeMirror bridge, over random changes', () => {
  for (const eol of ['\n', '\r\n'] as const)
    it(`gives the store the text CodeMirror shows, line endings ${JSON.stringify(eol)} kept, both ways`, () => {
      fc.assert(
        fc.property(
          fc.array(line, { minLength: 1, maxLength: 6 }).chain((lines) => {
            const text = textOf(lines, eol);
            const doc = docOf(text);
            return fc.tuple(fc.constant(text), fc.constant(doc), changesOver(doc));
          }),
          ([text, doc, changes]) => {
            const edits = toTextEdits(doc, changes, text, eol);
            const after = applyEdits(text, edits).text;
            const shown = changes.apply(doc);
            // Byte for byte what CodeMirror shows, written with the file's ending: never a bare LF in CRLF.
            expect(after).toBe(shown.sliceString(0, shown.length, eol));
            if (eol === '\r\n') expect(/\r(?!\n)|(?<!\r)\n/.test(after)).toBe(false);
            // The inverse, sent back as CodeMirror changes, gives the start document again.
            const { inverse } = applyEdits(text, edits);
            const back = ChangeSet.of(toChanges(shown, after, inverse), shown.length).apply(shown);
            expect(back.sliceString(0, back.length, eol)).toBe(text);
          },
        ),
        { numRuns: runs(300) },
      );
    });
});

describe('the bridge into the edit history, over random changes', () => {
  for (const eol of ['\n', '\r\n'] as const)
    it(`gives back the bytes it started from once every change typed through it is undone (${JSON.stringify(eol)})`, () => {
      fc.assert(
        fc.property(
          fc.array(line, { minLength: 1, maxLength: 6 }),
          fc.array(
            fc.tuple(
              fc.nat(),
              fc.nat({ max: 3 }),
              fc.string({ unit: fc.constantFrom('x', '\n', ' ', '😀'), maxLength: 3 }),
              fc.nat({ max: 400 }),
            ),
            {
              maxLength: 25,
            },
          ),
          (lines, keys) => {
            const path = '.github/workflows/ci.yml';
            const start = textOf(lines, eol);
            let text = start;
            let doc = docOf(start);
            let h = emptyHistory();
            let at = 0;
            for (const [pos, len, insert, dt] of keys) {
              const from = Math.min(pos, doc.length);
              const changes = ChangeSet.of(
                [{ from, to: Math.min(doc.length, from + len), insert }],
                doc.length,
              );
              const step = typed(h, { [path]: text }, path, toTextEdits(doc, changes, text, eol), {
                at: (at += dt),
                selection: {},
              });
              if ('refused' in step) throw new Error(step.refused);
              h = step.history;
              text = step.changes[path] ?? text;
              doc = changes.apply(doc);
              expect(text).toBe(doc.sliceString(0, doc.length, eol));
            }
            for (let step = undo(h, { [path]: text }); step; step = undo(h, { [path]: text })) {
              if ('refused' in step) throw new Error(step.refused);
              h = step.history;
              text = step.changes[path] ?? text;
            }
            expect(text).toBe(start);
          },
        ),
        { numRuns: runs(200) },
      );
    });
});
