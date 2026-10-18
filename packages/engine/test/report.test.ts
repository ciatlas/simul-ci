import {
  annotationsOf,
  loadFiles,
  renderAnnotations,
  renderJUnit,
  renderMarkdownReport,
  renderTextReport,
  runTests,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const ci = `
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: npm test }]
  deploy:
    needs: build
    if: vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: ./deploy }]
`;

describe('reports', () => {
  const project = loadFiles({ '.github/workflows/ci.yml': ci });
  const result = runTests(project, [
    {
      path: 't.test.yml',
      text: 'workflow: ci.yml\ncases:\n  - { name: a, when: { event: push, branch: main }, then: { run: [deploy] } }\n  - { name: b, when: { event: push, branch: main }, then: { run: [nope] } }\n  - { name: c, when: { event: push }, then: { run: [build] }, skip: later }\n',
    },
    { path: 'bad.test.yml', text: 'workflow: ci.yml\ncases: [\n' },
  ]);

  it('renders text, annotations, JUnit and Markdown from one result', () => {
    const text = renderTextReport(result);
    expect(text).toContain('t.test.yml → ci.yml\n  ✗ a\n      run[0]: expected deploy to run; it skips\n');
    expect(text).toContain("  ! b\n      run[0]: no job 'nope' in ci.yml (jobs: build, deploy)\n");
    expect(text).toContain('  - c (later)\n');
    expect(text).toContain('bad.test.yml\n  T001 ');
    expect(text).toMatch(/\n0 passed · 1 failed · 1 invalid · 1 skipped · exit 2\n$/);

    const annotations = annotationsOf(result);
    expect(annotations.map((a) => [a.level, a.file, a.line, a.title])).toEqual([
      ['error', 't.test.yml', 3, 'simulci: a'],
      ['error', 't.test.yml', 4, 'simulci: b'],
      ['error', 'bad.test.yml', 3, 'simulci: bad.test.yml'],
      ['notice', '.github/workflows/ci.yml', 11, 'simulci: decided here'],
    ]);
    const lines = renderAnnotations(result);
    expect(lines[0]).toMatch(
      /^::error file=t\.test\.yml,line=3,col=\d+,title=simulci%3A a::run\[0\]: expected deploy to run; it skips%0A/,
    );
    expect(lines.filter((l) => l.startsWith('::notice'))).toHaveLength(1);

    const junit = renderJUnit(result);
    expect(junit).toContain('<testsuites name="simulci" tests="4" failures="1" errors="2" skipped="1">');
    expect(junit).toContain('<skipped message="later"/>');
    expect(junit).toMatch(
      /<testcase classname="bad\.test\.yml" name="\(file\)" time="0">\n {6}<error type="T001" message="T001 /,
    );

    const markdown = renderMarkdownReport(result);
    expect(markdown).toContain(
      '## simulci test: 0 passed · 1 failed · 1 invalid · 1 skipped\n\n| | Case | File |\n|---|---|---|\n',
    );
    expect(markdown).toContain(
      '| ❌ | a | t.test.yml |\n| ⚠️ | b | t.test.yml |\n| ⏭️ | c (later) | t.test.yml |\n',
    );
    expect(markdown).toContain('<details><summary>❌ a — run[0]: expected deploy to run; it skips</summary>');
    expect(renderMarkdownReport(result, { title: 'Route tests', maxFailures: 1 })).toContain(
      '2 more failed cases are in the log.',
    );
  });

  it('caps annotations at ten per severity', () => {
    const many = runTests(project, [
      {
        path: 'many.test.yml',
        text: `workflow: ci.yml\ncases:\n${Array.from({ length: 12 }, (_, i) => `  - { name: c${i}, when: { event: push, branch: main }, then: { run: [deploy] } }`).join('\n')}\n`,
      },
    ]);
    const lines = renderAnnotations(many);
    expect(lines.filter((l) => l.startsWith('::error file=')).length).toBe(9);
    expect(lines).toContain('::error::3 more failures not shown; see the log');
  });
});
