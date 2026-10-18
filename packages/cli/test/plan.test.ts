import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { renderMermaid, renderText, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { readWorkflowFiles } from '../src/files';
import { render, scenarioFromArgs } from '../src/plan';

const root = join(import.meta.dirname, '../../..');
const lab = join(root, 'fixtures/routes-lab/repo');

describe('scenarioFromArgs', () => {
  it('maps flags and key=value lists onto the scenario, typing dispatch inputs', () => {
    expect(
      scenarioFromArgs({
        dir: '.',
        event: 'workflow_dispatch',
        branch: 'main',
        changed: ['a.md', 'b.ts,c.ts'],
        input: ['dry=true', 'count=3', 'name=x'],
        var: 'DEPLOY=true',
        secret: ['NPM_TOKEN', 'OTHER'],
        actor: 'octocat',
        fork: true,
        format: 'text',
        detail: 'steps',
      }),
    ).toEqual({
      event: 'workflow_dispatch',
      branch: 'main',
      changed: ['a.md', 'b.ts', 'c.ts'],
      inputs: { dry: true, count: 3, name: 'x' },
      vars: { DEPLOY: 'true' },
      secrets: ['NPM_TOKEN', 'OTHER'],
      actor: { login: 'octocat', fork: true },
    });
    expect(
      scenarioFromArgs({ dir: '.', event: 'push', format: 'text', detail: 'steps', fork: false }),
    ).toEqual({ event: 'push' });
  });
});

describe('readWorkflowFiles', () => {
  it('reads the workflows and local actions of a checkout', () => {
    const files = readWorkflowFiles(lab);
    expect(Object.keys(files).filter((f) => f.startsWith('.github/workflows/')).length).toBeGreaterThan(20);
    expect(files['.github/actions/comp/action.yml']).toContain('composite');
  });
});

describe('render', () => {
  const plan = simulate({
    files: readWorkflowFiles(lab),
    scenario: { event: 'push', branch: 'main', changed: ['docs/x.md'] },
  });

  it('writes text with a mark per unit and the deciding clause', () => {
    const text = renderText(plan);
    expect(text).toMatch(/^push:main · \d+ of \d+ workflows triggered\n/);
    expect(text).toContain(
      '○ .github/workflows/case-filter-paths.yml — paths [src/**] ← ["docs/x.md"]: false',
    );
    expect(text).toContain('  ○ b — if: ');
    expect(render(plan, 'text')).toBe(text);
  });

  it('writes json and mermaid', () => {
    expect(JSON.parse(render(plan, 'json'))).toMatchObject({ schemaVersion: 1 });
    const mermaid = renderMermaid(plan);
    expect(mermaid).toMatch(/^flowchart LR\n/);
    expect(mermaid).toContain(':::no');
    expect(mermaid).toContain('classDef maybe');
  });
});

describe('simulci plan', () => {
  it('runs from source and prints the plan', () => {
    const tsx = join(root, 'node_modules/.bin/tsx');
    const result = spawnSync(
      tsx,
      [
        '--conditions=source',
        join(root, 'packages/cli/src/index.ts'),
        'plan',
        '--dir',
        lab,
        '--event',
        'push',
        '--branch',
        'main',
        '--changed',
        'src/main.txt',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('● .github/workflows/case-filter-paths.yml');
    const empty = spawnSync(
      tsx,
      [
        '--conditions=source',
        join(root, 'packages/cli/src/index.ts'),
        'plan',
        '--dir',
        join(root, 'packages'),
      ],
      { encoding: 'utf8' },
    );
    expect(empty.status).toBe(2);
  });
});
