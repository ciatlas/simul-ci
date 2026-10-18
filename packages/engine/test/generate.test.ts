import { caseFromPlan, fileFromPlan, loadFiles, runTests, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const ci = `
on:
  push:
    branches: [main]
    paths: ['src/**']
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: t
        run: npm test
  deploy:
    needs: build
    if: vars.DEPLOY == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: ./deploy }]
`;
const project = loadFiles({ '.github/workflows/ci.yml': ci });

describe('caseFromPlan', () => {
  it('records what the plan holds, with a comment and allowMaybe for every maybe', () => {
    const scenario = { event: 'push' as const, branch: 'main' };
    const plan = simulate({ project, scenario });
    const c = caseFromPlan({ plan, workflow: 'ci.yml', scenario, detail: 'steps' });
    expect(c.name).toBe('push main');
    expect(c.when).toEqual(scenario);
    expect(c.allowMaybe).toBe(true);
    // build is maybe because the workflow is; deploy's if: reads vars.DEPLOY, absent, so it skips either way.
    expect(c.then).toEqual({
      triggered: true,
      skip: ['deploy'],
      maybe: ['build'],
      conclusion: 'success',
      units: { 'build.t': { runs: 'maybe' } },
    });
    expect(c.comments).toEqual(['ci.yml: maybe — scenario.changed → pin: when: {"changed":["src/**"]}']);
  });

  it('names the deciding reason for an untriggered workflow and lists run and skip otherwise', () => {
    const topic = { event: 'push', branch: 'topic', changed: ['docs/a.md'] };
    const docs = caseFromPlan({
      plan: simulate({ project, scenario: topic }),
      workflow: 'ci.yml',
      scenario: topic,
    });
    expect(docs.then).toEqual({ triggered: false, because: 'branches' });
    expect(docs.name).toBe('push topic (1 changed file)');
    const scenario = { event: 'push', branch: 'main', changed: ['src/a.ts'], vars: { DEPLOY: 'true' } };
    const assume = [{ step: 'build.t', outcome: 'failure' as const }];
    const plan = simulate({ project, scenario, assume });
    const main = caseFromPlan({ plan, workflow: 'ci.yml', scenario, assume });
    expect(main.then).toEqual({ run: ['build'], skip: ['deploy'], conclusion: 'failure' });
    expect(main.name).toBe('push main (1 changed file) with 1 assumption');
    expect(main.when.assume).toEqual(assume);
  });

  it('writes a test file that the runner accepts and passes', () => {
    const scenario = { event: 'push', branch: 'main' };
    const text = fileFromPlan({
      plan: simulate({ project, scenario }),
      workflow: '.github/workflows/ci.yml',
      scenario,
    });
    expect(text).toBe(`workflow: ci.yml
cases:
  # ci.yml: maybe — scenario.changed → pin: when: {"changed":["src/**"]}
  - name: push main
    when: { event: push, branch: main }
    allowMaybe: true
    then:
      triggered: true
      skip:
        - deploy
      maybe:
        - build
      conclusion: success
`);
    const result = runTests(project, [{ path: 'generated.test.yml', text }]);
    expect(result.files[0]!.cases[0]!.status).toBe('passed');
    expect(result.exitCode).toBe(0);
  });
});
