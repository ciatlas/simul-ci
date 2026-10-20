import { describe, expect, it, vi } from 'vitest';

import { WorkflowDocument, type Style } from '@simulci/document';
import { BOM, crlf, fixture, fixtures, workflows } from './corpus';

// The corpus-wide checks run over every file and its CRLF variants; under coverage they take seconds.
vi.setConfig({ testTimeout: 60_000 });

const styleOf = (text: string): Style =>
  WorkflowDocument.open(text, { path: 'x.yml', kind: 'workflow' }).style;

describe('inferStyle', () => {
  it('reads a four-space file with double quotes, block lists, wrapped ifs and blank separators', () => {
    expect(styleOf(fixture('indent4.yml'))).toEqual({
      indent: 4,
      indentSeq: true,
      quote: '"',
      flowPadding: false,
      flow: { needs: false, filters: false, types: false, matrix: false, 'runs-on': false, other: false },
      ifStyle: 'wrapped',
      eol: '\n',
      finalNewline: true,
      blank: { jobs: true, steps: true },
      commentGap: 2,
    } satisfies Style);
  });

  it('reads flush sequences and padded flow lists', () => {
    expect(styleOf(fixture('flush.yml'))).toMatchObject({
      indentSeq: false,
      flowPadding: true,
      ifStyle: 'wrapped',
    });
  });

  it('keeps flow or block per list family, the file’s majority for the rest', () => {
    expect(styleOf(fixture('families.yml')).flow).toEqual({
      needs: false,
      filters: true,
      types: true,
      // os is flow and node block: a tie, so the file's majority (4 flow lists against 3 block ones).
      matrix: true,
      'runs-on': true,
      other: true,
    });
  });

  it('leaves the flow of a file with no short list to the renderer', () => {
    expect(Object.values(styleOf(fixture('no-lists.yml')).flow)).toEqual(Array(6).fill(undefined));
  });

  it('reads line breaks, the final newline and packed collections off the text', () => {
    const text = fixture('packed-no-final-newline.yml');
    expect(styleOf(text)).toMatchObject({
      eol: '\n',
      finalNewline: false,
      blank: { jobs: false, steps: false },
    });
    expect(styleOf(crlf(text)).eol).toBe('\r\n');
    // One LF among CRLFs: not a CRLF file (the store keeps mixed files away from ops).
    expect(styleOf('a: 1\r\nb: 2\n').eol).toBe('\n');
    expect(styleOf('').eol).toBe('\n');
  });

  it('does not count double quotes that need their escapes', () => {
    expect(styleOf('a: "\\t"\nb: "\\n"\nc: \'x\'\n').quote).toBe("'");
    expect(styleOf('a: "x"\nb: "y"\nc: \'z\'\n').quote).toBe('"');
  });

  it('measures the gap before inline comments only after content', () => {
    expect(styleOf('a: 1   # three\nb: 2   # three\n# own line\nc: 3 # one\n').commentGap).toBe(3);
  });

  it('is the same whatever the line breaks, apart from the line breaks', () => {
    for (const { name, text } of [...fixtures(), ...workflows()]) {
      const lf = styleOf(text);
      expect({ ...styleOf(crlf(text)), eol: '\n' }, name).toEqual(lf);
      expect({ ...styleOf(`${BOM}${crlf(text)}`), eol: '\n' }, name).toEqual(lf);
    }
  });

  it('matches the goldens over the fixtures, the samples, the routes lab and flowpact', async () => {
    // This repository's own workflows change with CI; their style is checked above, not kept as a golden.
    const files = [...fixtures(), ...workflows()].filter((f) => !f.name.startsWith('.github/'));
    const styles = Object.fromEntries(files.map((f) => [f.name, styleOf(f.text)]));
    // `null`: no list says (`undefined` in the Style).
    const json = JSON.stringify(styles, (_, value: unknown) => (value === undefined ? null : value), 2);
    await expect(`${json}\n`).toMatchFileSnapshot('golden/style.json');
  });
});
