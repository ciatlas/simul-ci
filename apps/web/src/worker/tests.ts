/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import { testFileFailures } from '@simulci/engine';
import type { Outline, OutlineFile } from './protocol';

/**
 * The route tests a load carries, as the Outline lists them (synthesis § 4.9): never loaded into the project, each
 * checked as `simulci test` checks a file before it runs a case (its YAML, its schema, its case names), the failures
 * at their lines in the CLI's words.
 */
function testFilesOf(tests: Readonly<Record<string, string>>): OutlineFile[] {
  return Object.entries(tests).map(([path, text]) => ({
    path,
    kind: 'test',
    errors: testFileFailures(text).map((f) => ({
      line: f.at.line,
      column: f.at.col,
      message: f.headline,
      source: 'test',
    })),
  }));
}

/** The Outline with the route tests among its files, all by path. */
export function withTests(outline: Outline, tests: Readonly<Record<string, string>> | undefined): Outline {
  if (!tests || Object.keys(tests).length === 0) return outline;
  const files = [...outline.files, ...testFilesOf(tests)].sort((a, b) => a.path.localeCompare(b.path));
  return { ...outline, files };
}
