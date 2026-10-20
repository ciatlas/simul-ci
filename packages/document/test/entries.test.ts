import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `@simulci/document/edits` is the part of the document model the page holds (the edit history, the CodeMirror bridge
 * and save-back). It imports nothing, so loading it never pulls the YAML parser behind the rest of the package into a
 * page chunk.
 */

const source = readFileSync(resolve(import.meta.dirname, '../src/edits.ts'), 'utf8');

describe('the edits entry', () => {
  it('imports nothing, not even types', () => {
    expect(source.match(/^\s*import\b.*$/gm) ?? []).toEqual([]);
    expect(source.match(/^\s*export\b[^;]*\bfrom\s*['"].*$/gm) ?? []).toEqual([]);
    expect(source.match(/\b(?:import|require)\s*\(.*$/gm) ?? []).toEqual([]);
  });
});
