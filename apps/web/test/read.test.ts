import { describe, expect, it } from 'vitest';
import { classifyEol, readExact, textMeta } from '../src/input/read';
import { createSessionStore } from '../src/state/store';

const BOM = [0xef, 0xbb, 0xbf];
const bytes = (...parts: (string | number[])[]): Blob =>
  new Blob(parts.map((p) => (typeof p === 'string' ? p : new Uint8Array(p))));

describe('readExact', () => {
  it('flags a BOM and strips it from the text, as Blob.text() does, so offsets stay as they were', async () => {
    const blob = bytes(BOM, 'a\r\n');
    expect(await readExact(blob)).toEqual({ text: 'a\r\n', meta: { bom: true, eol: 'crlf', utf8: true } });
    expect(await blob.text()).toBe('a\r\n');
    expect(await readExact(bytes('on: push\n'))).toMatchObject({ meta: { bom: false } });
  });

  it('keeps a U+FEFF that is not at the start, and reads a lone BOM as an empty file with a BOM', async () => {
    expect(await readExact(bytes('a', BOM, 'b'))).toEqual({
      text: 'a﻿b',
      meta: { bom: false, eol: 'none', utf8: true },
    });
    expect(await readExact(bytes(BOM))).toEqual({ text: '', meta: { bom: true, eol: 'none', utf8: true } });
  });

  it('classifies the line endings it read', async () => {
    const eol = async (text: string) => (await readExact(bytes(text))).meta.eol;
    expect(await eol('on: push\r\njobs: {}\r\n')).toBe('crlf');
    expect(await eol('on: push\njobs: {}\n')).toBe('lf');
    expect(await eol('on: push\r\njobs: {}\n')).toBe('mixed');
    expect(await eol('on: push\rjobs: {}')).toBe('mixed');
    expect(await eol('on: push')).toBe('none');
  });

  it('reads an empty file as valid UTF-8 with no BOM and no line break', async () => {
    expect(await readExact(new Blob([]))).toEqual({
      text: '',
      meta: { bom: false, eol: 'none', utf8: true },
    });
  });

  it('reads bytes that are not UTF-8 with U+FFFD in their place, and says so', async () => {
    // Latin-1 é, then a truncated three-byte sequence.
    expect(await readExact(bytes('caf', [0xe9], '\n', [0xe2, 0x82]))).toEqual({
      text: 'caf�\n�',
      meta: { bom: false, eol: 'lf', utf8: false },
    });
    expect(await readExact(bytes(BOM, 'a', [0xff], '\r\n'))).toEqual({
      text: 'a�\r\n',
      meta: { bom: true, eol: 'crlf', utf8: false },
    });
    // UTF-16 LE, BOM and all, is not UTF-8.
    expect((await readExact(bytes([0xff, 0xfe, 0x61, 0x00]))).meta).toEqual({
      bom: false,
      eol: 'none',
      utf8: false,
    });
  });
});

describe('classifyEol', () => {
  it('says crlf only when every \\n follows a \\r and every \\r comes before one', () => {
    expect(classifyEol('a\r\nb\r\n')).toBe('crlf');
    expect(classifyEol('a\r\n')).toBe('crlf');
    expect(classifyEol('a\r\r\n')).toBe('mixed');
    expect(classifyEol('a\n\r\n')).toBe('mixed');
    expect(classifyEol('a\r\nb\r')).toBe('mixed');
  });

  it('says lf with no \\r, none with no break at all, mixed for a lone \\r', () => {
    expect(classifyEol('a\nb')).toBe('lf');
    expect(classifyEol('\n')).toBe('lf');
    expect(classifyEol('')).toBe('none');
    expect(classifyEol('a b')).toBe('none');
    expect(classifyEol('a\rb')).toBe('mixed');
    expect(classifyEol('\r')).toBe('mixed');
  });

  it('gives a string no file was read for no BOM, its own line endings and valid UTF-8', () => {
    expect(textMeta('on: push\r\n')).toEqual({ bom: false, eol: 'crlf', utf8: true });
    expect(textMeta('')).toEqual({ bom: false, eol: 'none', utf8: true });
  });
});

describe('the files’ meta in the store', () => {
  const CI = '.github/workflows/ci.yml';
  const PASTED = '.github/workflows/pasted.yml';
  const read = { bom: true, eol: 'crlf', utf8: false } as const;

  it('keeps the meta the reader gave and gives every other file the meta of its string', () => {
    const store = createSessionStore();
    expect(store.getState().files.meta).toEqual({});
    store.getState().setFiles(
      { [CI]: 'on: push\r\n', [PASTED]: 'on: push\n' },
      { kind: 'folder', name: 'repo', readAt: 0 },
      {
        [CI]: read,
        '.github/workflows/gone.yml': read,
      },
    );
    expect(store.getState().files.meta).toEqual({
      [CI]: read,
      [PASTED]: { bom: false, eol: 'lf', utf8: true },
    });
    store.getState().setFiles({ [CI]: 'on: push' }, { kind: 'sample', name: 'starter' });
    expect(store.getState().files.meta).toEqual({ [CI]: { bom: false, eol: 'none', utf8: true } });
  });

  it('forgets the meta with the files', () => {
    const store = createSessionStore();
    store
      .getState()
      .setFiles({ [CI]: 'on: push' }, { kind: 'folder', name: 'repo', readAt: 0 }, { [CI]: read });
    store.getState().forgetSource();
    expect(store.getState().files).toMatchObject({ byPath: {}, meta: {} });
  });
});
