import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Snapshot, SnapshotStore, TestInput } from '@simulci/engine';

/** Where route tests live in a repository. */
export const TESTS_DIR = '.github/simulci/tests';

/** The named files (relative to the checkout), else every `*.test.yml` under the tests directory. */
export function discoverTests(root: string, named: readonly string[] = []): string[] {
  if (named.length) return named.map((f) => relative(root, resolve(f)).split('\\').join('/'));
  const dir = join(root, TESTS_DIR);
  if (!existsSync(dir)) return [];
  return walk(dir)
    .filter((f) => /\.test\.ya?ml$/.test(f) && !f.includes('/__snapshots__/'))
    .map((f) => relative(root, f).split('\\').join('/'))
    .sort((x, y) => x.localeCompare(y));
}

export class TestsError extends Error {
  override name = 'TestsError';
}

/** The test files as the runner takes them: their checkout-relative path and text (T000 when one cannot be read). */
export function readTests(root: string, files: readonly string[]): TestInput[] {
  return files.map((path) => {
    try {
      return { path, text: readFileSync(join(root, path), 'utf8') };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new TestsError(`T000 ${path}: no such test file`);
      if (code === 'EISDIR') throw new TestsError(`T000 ${path}: is a directory, not a test file`);
      throw e;
    }
  });
}

/** Test files under `.github/workflows`, which GitHub would try to run. */
export const misplacedTests = (files: readonly string[]): string[] =>
  files.filter((f) => /(^|\/)\.github\/workflows\//.test(f));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** `<tests dir>/__snapshots__/<name>.test.snap.json` beside the tests. */
export function snapshotPath(testFile: string): string {
  const name = testFile.replace(/^.*\//, '').replace(/\.ya?ml$/, '');
  return `${dirname(testFile)}/__snapshots__/${name}.snap.json`;
}

/** Snapshots as files beside the tests. */
export function diskSnapshotStore(root: string): SnapshotStore {
  return {
    read(testFile) {
      const file = join(root, snapshotPath(testFile));
      if (!existsSync(file)) return undefined;
      return JSON.parse(readFileSync(file, 'utf8')) as Snapshot;
    },
    write(testFile, snapshot) {
      const file = join(root, snapshotPath(testFile));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    },
  };
}
