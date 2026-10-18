import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFiles, runTests } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

/** The route tests of the lab workflows (fixtures/routes-lab/tests) all pass against the lab repository. */

const lab = join(import.meta.dirname, '../../../fixtures/routes-lab');

function walk(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, walk(full, rel));
    else out[rel] = readFileSync(full, 'utf8');
  }
  return out;
}

describe('route tests of the lab', () => {
  const project = loadFiles(walk(join(lab, 'repo')), 'ciatlas/simulci-lab');
  const dir = join(lab, 'tests');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.test.yml'))
    .sort()
    .map((f) => ({ path: `.github/simulci/tests/${f}`, text: readFileSync(join(dir, f), 'utf8') }));

  it('every case passes', { timeout: 30_000 }, () => {
    const result = runTests(project, files, { ci: true });
    const problems = result.files.flatMap((f) => [
      ...f.failures.map((x) => `${f.path}: ${x.headline}`),
      ...f.cases.flatMap((c) =>
        c.failures.map((x) => `${f.path} › ${c.name}: ${x.headline}\n      ${x.detail.join('\n      ')}`),
      ),
    ]);
    expect(problems).toEqual([]);
    expect(result.summary).toEqual({ passed: 13, failed: 0, invalid: 0, skipped: 0 });
    expect(result.exitCode).toBe(0);
  });
});
