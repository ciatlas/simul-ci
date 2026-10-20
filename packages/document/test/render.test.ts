import { describe, expect, it } from 'vitest';
import { WorkflowDocument, type Style } from '@simulci/document';
import { applyEdits } from '../src/edits';
import { renderItem, renderPair, renderValue } from '../src/fragment';
import { blockOf, inlineScalar, readsBack, writeScalar, type Scalar } from '../src/scalar';
import { ownStart } from '../src/spans';
import { isFlow, locate } from '../src/tree';
import type { YamlPath } from '../src/types';

const open = (text: string) => WorkflowDocument.open(text, { path: 'ci.yml', kind: 'workflow' });
const style = (more: Partial<Style> = {}): Style => ({ ...open('a: 1\n').style, ...more });

describe('the typed scalar writer (§ 2.7)', () => {
  it('quotes a string the core schema would read as another type, and nothing else', () => {
    const s = style();
    for (const text of ['24', '3.10', 'true', 'null', '~', '0x1f', '1e3', '.inf', '', 'False', '0o7'])
      expect(inlineScalar(text, 'value', s)).toBe(`'${text}'`);
    for (const text of ['ubuntu-latest', 'a b', "github.ref == 'refs/heads/main'", '${{ matrix.os }}', 'é'])
      expect(inlineScalar(text, 'value', s)).toBe(text);
  });

  it('quotes indicators and comment or key markers', () => {
    const s = style();
    for (const text of [
      '!cancelled()',
      '*star',
      '&amp',
      '#x',
      '@at',
      '`tick',
      '- dash',
      '? q',
      'a: b',
      'a #b',
      '%x',
      '|x',
      '>x',
    ])
      expect(inlineScalar(text, 'value', s), text).toBe(`'${text}'`);
    expect(inlineScalar('a, b', 'flow', s)).toBe("'a, b'");
    expect(inlineScalar('a, b', 'value', s)).toBe('a, b');
  });

  it("quotes with the file's quote, double when the value holds a single quote, escaping what must be", () => {
    expect(inlineScalar('24', 'value', style({ quote: '"' }))).toBe('"24"');
    expect(inlineScalar("it's: x", 'value', style())).toBe('"it\'s: x"');
    expect(inlineScalar('tab\there: x', 'value', style())).toBe("'tab\there: x'");
    expect(inlineScalar('bell\u0007', 'value', style())).toBe('"bell\\u0007"');
    expect(inlineScalar('del\u007f', 'value', style())).toBe('"del\\u007f"');
    expect(inlineScalar('two\nlines', 'value', style())).toBe('"two\\nlines"');
  });

  it('keeps a token’s own quotes first', () => {
    expect(inlineScalar('plain', 'value', style(), "'")).toBe("'plain'");
    expect(inlineScalar('plain', 'value', style(), '"')).toBe('"plain"');
    expect(inlineScalar("it's", 'value', style(), "'")).toBe("'it''s'");
  });

  it('writes numbers, booleans and null plain, and keys as keys', () => {
    expect(inlineScalar(30, 'value', style())).toBe('30');
    expect(inlineScalar(1.5, 'item', style())).toBe('1.5');
    expect(inlineScalar(false, 'flow', style())).toBe('false');
    expect(inlineScalar(null, 'value', style())).toBe('null');
    expect(inlineScalar('on', 'key', style())).toBe('on');
    expect(inlineScalar('a: b', 'key', style())).toBe("'a: b'");
    expect(inlineScalar('true', 'key', style())).toBe("'true'");
    expect(inlineScalar('<<', 'key', style())).toBe("'<<'");
    expect(inlineScalar('a,b', 'flowKey', style())).toBe("'a,b'");
  });

  it('reads back only what parses to the value', () => {
    expect(readsBack('24', '24', 'value')).toBe(false);
    expect(readsBack("'24'", '24', 'value')).toBe(true);
    expect(readsBack('*x', '*x', 'value')).toBe(false);
    expect(readsBack('!x y', 'x y', 'value')).toBe(false);
  });

  it('chomps a block scalar as its trailing line breaks say, refusing what a block cannot hold', () => {
    expect(blockOf('a\nb')).toEqual({ header: '|-', lines: ['a', 'b'] });
    expect(blockOf('a\nb\n')).toEqual({ header: '|', lines: ['a', 'b'] });
    expect(blockOf('a\n\n', false, true)).toEqual({ header: '|+', lines: ['a', ''] });
    expect(blockOf('a\n\n')).toBeUndefined();
    expect(blockOf(' leading\nx')).toBeUndefined();
    expect(blockOf('\ttab first\nx')).toBeUndefined();
    expect(blockOf('cr\r\nlf')).toBeUndefined();
    expect(blockOf('folded', true)).toEqual({ header: '>-', lines: ['folded'] });
    expect(blockOf('two\nlines', true)).toEqual({ header: '>-', lines: ['two', '', 'lines'] });
  });
});

describe('fragments in the file’s style', () => {
  it('renders lists in flow by family, and in block when an item holds an expression', () => {
    const s = style({
      flow: {
        needs: true,
        filters: false,
        types: undefined,
        matrix: undefined,
        'runs-on': undefined,
        other: undefined,
      },
    });
    expect(renderValue(['a', 'b'], 4, ['jobs', 'x', 'needs'], 'value', { style: s })).toEqual({
      head: '[a, b]',
      rest: [],
    });
    expect(renderValue(['a'], 4, ['on', 'push', 'branches'], 'value', { style: s })).toEqual({
      head: '',
      rest: ['      - a'],
    });
    expect(renderValue(['${{ a }}'], 4, ['jobs', 'x', 'needs'], 'value', { style: s })?.rest).toEqual([
      '      - ${{ a }}',
    ]);
    expect(renderValue([1, 2, 3, 4, 5], 4, ['x', 'types'], 'value', { style: s })?.head).toBe('');
    expect(
      renderValue([1, 2], 4, ['x', 'types'], 'value', { style: style({ flowPadding: true }) })?.head,
    ).toBe('[ 1, 2 ]');
  });

  it('renders maps, items, empty collections and nulls', () => {
    const s = style();
    expect(renderPair('with', { a: 1, b: null }, 6, ['with'], { style: s })).toEqual([
      '      with:',
      '        a: 1',
      '        b:',
    ]);
    expect(renderItem({ name: 'x', run: 'y' }, 6, [], { style: s, itemKeyOffset: 4 })).toEqual([
      '      -   name: x',
      '          run: y',
    ]);
    expect(renderItem(null, 2, [], { style: s })).toEqual(['  -']);
    expect(renderItem([1], 2, [], { style: s })).toEqual(['  -', '    - 1']);
    expect(renderValue({}, 0, ['x'], 'value', { style: s })).toEqual({ head: '{}', rest: [] });
    expect(renderValue([], 0, ['x'], 'value', { style: s })).toEqual({ head: '[]', rest: [] });
  });

  it('writes a multi-line string on one line when a comment below is as deep as its block would be', () => {
    expect(renderValue('a\nb\n', 2, ['run'], 'value', { style: style(), blockLimit: 4 })).toEqual({
      head: '"a\\nb\\n"',
      rest: [],
    });
    expect(renderValue('a\nb\n', 2, ['run'], 'value', { style: style(), blockLimit: 3 })).toEqual({
      head: '|',
      rest: ['    a', '    b'],
    });
  });
});

/** A scalar written in place where a path points, as the primitives' `set` does (§ 2.7). */
function write(text: string, path: YamlPath, value: Scalar): string | undefined {
  const doc = open(text);
  const hop = locate(doc.tree, path)!.hops.at(-1)!;
  const flow = isFlow(hop.parent);
  const column = flow ? 0 : doc.tree.lines.column(ownStart(hop.parent, hop.index));
  const place = flow ? 'flow' : hop.pair ? 'value' : 'item';
  const site = {
    node: hop.node!,
    lines: doc.tree.lines,
    style: doc.style,
    place,
    column,
    bodyColumn: column + doc.style.indent,
  } as const;
  const edits = writeScalar(site, value);
  return edits && applyEdits(text, edits).text;
}

describe('the in-place scalar writer', () => {
  it.each<[string, string, YamlPath, Scalar, string]>([
    ['keeps the comment after the token', 'a: x # c\n', ['a'], 'y', 'a: y # c\n'],
    ["keeps the token's quotes", "a: 'x'\n", ['a'], 'y', "a: 'y'\n"],
    ['writes a number plain', 'a: x\n', ['a'], 30, 'a: 30\n'],
    ['writes null as an empty value', 'a: x # c\n', ['a'], null, 'a: # c\n'],
    ['turns a token into a block', 'a: x\nb: 1\n', ['a'], 'l1\nl2\n', 'a: |\n  l1\n  l2\nb: 1\n'],
    [
      'rewrites a block and its chomping',
      'a: |\n  old\nb: 1\n',
      ['a'],
      'n1\nn2',
      'a: |-\n  n1\n  n2\nb: 1\n',
    ],
    ['turns a block into a token', 'a: |\n  old\nb: 1\n', ['a'], 'one', 'a: one\nb: 1\n'],
    ['empties a block', 'a: |\n  old\nb: 1\n', ['a'], null, 'a:\nb: 1\n'],
    ['keeps a folded header for one line', 'if: >-\n  x\n', ['if'], 'y', 'if: >-\n  y\n'],
    ['spaces a comment touching a quoted token', 'a: "5"# m\n', ['a'], 6, 'a: 6 # m\n'],
    ['strips a block ending a file with no final break', 'a: x', ['a'], 'l1\nl2', 'a: |-\n  l1\n  l2'],
    ['gives a clipped block its final break', 'a: x', ['a'], 'l1\nl2\n', 'a: |\n  l1\n  l2\n'],
    ['rewrites a block ending the file', 'a: |-\n  old', ['a'], 'n1\nn2', 'a: |-\n  n1\n  n2'],
    ['fills an empty header on the last line', 'a: |', ['a'], 'x\ny\n', 'a: |\n  x\n  y\n'],
    ['drops an indentation indicator', 'a: |2\n    x\n', ['a'], 'p\nq\n', 'a: |\n  p\n  q\n'],
    [
      'writes one line above a comment as deep as the block',
      'a: x\n  # deep\nb: 1\n',
      ['a'],
      'l1\nl2\n',
      'a: "l1\\nl2\\n"\n  # deep\nb: 1\n',
    ],
    ['writes an item', '- x\n', [0], 'y', '- y\n'],
    ['writes a flow item on one line', 'a: [x, y]\n', ['a', 0], 'l1\nl2', 'a: ["l1\\nl2", y]\n'],
    [
      "writes the file's line breaks",
      'a: x\r\nb: 1\r\n',
      ['a'],
      'l1\nl2\n',
      'a: |\r\n  l1\r\n  l2\r\nb: 1\r\n',
    ],
  ])('%s', (_, text, path, value, out) => {
    expect(write(text, path, value)).toBe(out);
  });

  it('writes nothing for the value already there', () => {
    expect(write('a: 1\n', ['a'], 1)).toBe('a: 1\n');
  });
});
