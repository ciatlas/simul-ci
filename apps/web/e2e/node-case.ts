/**
 * A test file the page wrote, checked against the test file schema and run as `simulci test --ci` runs it, in Node
 * by the engine's root entry and `@simulci/node` and not by the page's worker: the browser pass checks that the case
 * the dialog copies is one the CLI takes and passes. The starter sample is written into a fresh checkout, at the
 * paths the page gives its files (src/input/samples.ts), and the text where the dialog says it belongs; the checkout
 * goes once the run is over. The browser pass runs it as `node --conditions=source --import tsx e2e/node-case.ts`
 * with the test file's text on stdin, and reads the one JSON object it prints.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadFiles, runTests, TestFileSchema } from '@simulci/engine';
import { discoverTests, readTests, readWorkflowFiles, TESTS_DIR } from '@simulci/node';
import { parse } from 'yaml';

const sample = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../src/samples/starter', name), 'utf8');

const text = readFileSync(0, 'utf8');

const files: Record<string, string> = {
  '.github/workflows/ci.yml': sample('ci.yml'),
  '.github/workflows/release.yml': sample('release.yml'),
  '.github/actions/setup/action.yml': sample('setup-action.yml'),
  [`${TESTS_DIR}/ci.test.yml`]: text,
};

const root = mkdtempSync(join(tmpdir(), 'simulci-case-'));
try {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  // What `simulci test` does (packages/cli/src/test.ts), with CI's options: no snapshot is written or read.
  const result = runTests(loadFiles(readWorkflowFiles(root)), readTests(root, discoverTests(root)), {
    ci: true,
  });
  const schema = TestFileSchema.safeParse(parse(text));
  const issues = schema.success
    ? []
    : schema.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }));
  const cases = result.files.flatMap((f) =>
    f.cases.map((c) => ({ name: c.name, status: c.status, failures: c.failures.map((x) => x.headline) })),
  );
  process.stdout.write(
    JSON.stringify({
      schema: { success: schema.success, issues },
      exitCode: result.exitCode,
      summary: result.summary,
      cases,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
