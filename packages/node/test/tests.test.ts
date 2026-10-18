import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverTests, misplacedTests, readTests, snapshotPath, TestsError } from '../src/tests';

describe('test files', () => {
  it('discovers, reads, and names a missing or misplaced file', () => {
    const root = mkdtempSync(join(tmpdir(), 'simulci-node-'));
    mkdirSync(join(root, '.github/simulci/tests/nested'), { recursive: true });
    mkdirSync(join(root, '.github/simulci/tests/__snapshots__'), { recursive: true });
    writeFileSync(join(root, '.github/simulci/tests/b.test.yml'), 'workflow: ci.yml\n');
    writeFileSync(join(root, '.github/simulci/tests/nested/a.test.yaml'), 'workflow: ci.yml\n');
    writeFileSync(join(root, '.github/simulci/tests/__snapshots__/b.test.snap.json'), '{}');
    expect(discoverTests(root)).toEqual([
      '.github/simulci/tests/b.test.yml',
      '.github/simulci/tests/nested/a.test.yaml',
    ]);
    expect(readTests(root, ['.github/simulci/tests/b.test.yml'])).toEqual([
      { path: '.github/simulci/tests/b.test.yml', text: 'workflow: ci.yml\n' },
    ]);
    expect(() => readTests(root, ['.github/simulci/tests/missing.test.yml'])).toThrow(
      new TestsError('T000 .github/simulci/tests/missing.test.yml: no such test file'),
    );
    expect(() => readTests(root, ['.github/simulci/tests/nested'])).toThrow(/is a directory/);
    expect(misplacedTests(['.github/workflows/x.test.yml', '.github/simulci/tests/x.test.yml'])).toEqual([
      '.github/workflows/x.test.yml',
    ]);
    expect(snapshotPath('.github/simulci/tests/nested/a.test.yaml')).toBe(
      '.github/simulci/tests/nested/__snapshots__/a.test.snap.json',
    );
  });
});
