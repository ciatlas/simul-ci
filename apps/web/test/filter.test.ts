import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readWorkflowFiles } from '@simulci/node';
import { afterAll, describe, expect, it } from 'vitest';
import { filterFiles, isProjectFile, mayHoldProjectFiles, normalizePath } from '../src/input/filter';
import { LIMITS, overLimit } from '../src/input/limits';

/** Every file under a directory, as a browser walk would hand them over: relative path → text. */
function everyFile(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, everyFile(join(dir, entry.name), rel));
    else out[rel] = readFileSync(join(dir, entry.name), 'utf8');
  }
  return out;
}

const SYNTHETIC = [
  '.github/workflows/ci.yml',
  '.github/workflows/Release.YAML',
  '.github/workflows/nested/not-a-workflow.yml',
  '.github/workflows/README.md',
  '.github/actions/setup/action.yml',
  '.github/actions/deep/er/action.yaml',
  '.github/actions/setup/README.md',
  '.github/actions/setup/scripts/action.sh',
  '.github/actions/ACTION.YML',
  '.github/dependabot.yml',
  '.github/simulci/tests/ci.test.yml',
  'action.yml',
  'node_modules/x/action.yml',
  'packages/a/action.yaml',
  'src/index.ts',
];

const tmp = mkdtempSync(join(tmpdir(), 'simulci-filter-'));
for (const path of SYNTHETIC) {
  mkdirSync(dirname(join(tmp, path)), { recursive: true });
  writeFileSync(join(tmp, path), `# ${path}\n`);
}
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the browser file filter', () => {
  it('keeps exactly what @simulci/node reads from the routes lab', () => {
    const root = join(import.meta.dirname, '../../../fixtures/routes-lab/repo');
    expect(filterFiles(everyFile(root))).toEqual(readWorkflowFiles(root));
  });

  it('keeps exactly what @simulci/node reads from a tree with every edge', () => {
    const node = readWorkflowFiles(tmp);
    expect(Object.keys(node).sort()).toEqual([
      '.github/actions/ACTION.YML',
      '.github/actions/deep/er/action.yaml',
      '.github/actions/setup/action.yml',
      '.github/workflows/Release.YAML',
      '.github/workflows/ci.yml',
      'action.yml',
    ]);
    expect(filterFiles(everyFile(tmp))).toEqual(node);
  });

  it('normalizes the paths a picker or a drop hands over', () => {
    expect(normalizePath('./.github\\workflows\\ci.yml')).toBe('.github/workflows/ci.yml');
    expect(normalizePath('/action.yml')).toBe('action.yml');
    expect(isProjectFile('repo/.github/workflows/ci.yml')).toBe(false);
    expect(isProjectFile('Action.yml')).toBe(false);
  });

  it('knows which directories a walk may skip', () => {
    expect(mayHoldProjectFiles('')).toBe(true);
    expect(mayHoldProjectFiles('.github')).toBe(true);
    expect(mayHoldProjectFiles('.github/actions/setup/deep')).toBe(true);
    expect(mayHoldProjectFiles('.github/workflows')).toBe(true);
    expect(mayHoldProjectFiles('node_modules')).toBe(false);
    expect(mayHoldProjectFiles('.github/simulci')).toBe(false);
    expect(mayHoldProjectFiles('.github/workflowsx')).toBe(false);
  });

  it('refuses sources over the limits with the reason', () => {
    expect(overLimit({ 'action.yml': 'x' })).toBeUndefined();
    expect(overLimit({ 'action.yml': 'x'.repeat(LIMITS.fileBytes + 1) })).toMatch(/action\.yml is 2\.0 MB/);
    const many: Record<string, string> = {};
    for (let i = 0; i <= LIMITS.files; i++) many[`f${i}`] = '';
    expect(overLimit(many)).toMatch(/2001 files/);
    const big: Record<string, string> = {};
    for (let i = 0; i < 11; i++) big[`f${i}`] = 'x'.repeat(LIMITS.fileBytes);
    expect(overLimit(big)).toMatch(/22 MB in all/);
  });
});
