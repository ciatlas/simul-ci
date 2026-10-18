import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type AssumeEntry, checksOf, loadFiles, type ScenarioInput, simulate } from '@simulci/engine';
import { describe, expect, it } from 'vitest';

/**
 * Conformance against the routes lab: every captured run must be predicted as triggered, and for the runs whose jobs
 * only succeeded or were skipped (no failing steps to mock yet), every check run with its conclusion.
 */

const lab = join(import.meta.dirname, '../../../fixtures/routes-lab');
const expected = JSON.parse(readFileSync(join(lab, 'expected.json'), 'utf8')) as {
  runs: {
    runId: number;
    workflow: string;
    event: string;
    action: string | null;
    ref: string;
    sha: string;
    message: string;
    changed: string[] | null;
    conclusion: string;
    jobs: { name: string; conclusion: string }[];
    checks: { name: string; conclusion: string }[];
  }[];
};

function walk(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) Object.assign(out, walk(full, rel));
    else out[rel] = readFileSync(full, 'utf8');
  }
  return out;
}

const project = loadFiles(walk(join(lab, 'repo')), 'ciatlas/simulci-lab');

function scenarioOf(run: (typeof expected.runs)[number]): ScenarioInput {
  const s: ScenarioInput = {
    event: run.event,
    sha: run.sha.slice(0, 40),
    message: run.message,
    repository: 'ciatlas/simulci-lab',
  };
  if (run.changed) s.changed = run.changed;
  if (run.action) s.action = run.action;
  if (run.event === 'pull_request') {
    s.number = Number(/refs\/pull\/(\d+)\//.exec(run.ref)?.[1] ?? 1);
    s.base = 'main';
    s.head = 'probe/pr';
  } else s.ref = run.ref;
  return s;
}

/** What the runner knew and the simulator cannot: which scripted steps fail (cases.md). */
const ASSUME: Record<string, AssumeEntry[]> = {
  'case-continue-on-error-job.yml': [{ step: 'a.#1', outcome: 'failure' }],
  'case-continue-on-error-step.yml': [{ step: 'a.f', outcome: 'failure' }],
  'case-matrix-aggregate.yml': [
    { step: 'a[n=2].#1', outcome: 'failure' },
    { step: 'v[n=2].#1', outcome: 'failure' },
  ],
  'case-matrix-one-failed.yml': [{ step: 'a[n=2].#1', outcome: 'failure' }],
  'case-fail-fast-cancelled.yml': [{ step: 'a[n=2].#1', outcome: 'failure' }],
  'case-step-timeout.yml': [{ step: 'a.t', outcome: 'failure' }],
  'case-composite-action-status.yml': [{ step: 'a.u/#1', outcome: 'failure' }],
};
const assumeFor = (workflow: string) => ASSUME[workflow.replace(/^.*\//, '')] ?? [];

describe('routes lab', () => {
  it('predicts every captured run as triggered', { timeout: 30_000 }, () => {
    const misses: string[] = [];
    for (const run of expected.runs) {
      const plan = simulate({ project, scenario: scenarioOf(run) });
      const wf = plan.workflows.find((w) => w.path === run.workflow)!;
      if (wf.triggered.verdict !== 'yes')
        misses.push(
          `${run.workflow} ${run.event} ${run.ref}: ${wf.triggered.verdict} ${JSON.stringify(wf.triggered.chain.at(-1))}`,
        );
    }
    expect(misses).toEqual([]);
  });

  it('predicts every check run and its conclusion, given which steps fail', { timeout: 30_000 }, () => {
    const misses: string[] = [];
    let compared = 0;
    for (const run of expected.runs) {
      const plan = simulate({ project, scenario: scenarioOf(run), assume: assumeFor(run.workflow) });
      for (const d of plan.diagnostics)
        if (d.severity === 'error') misses.push(`${run.workflow}: ${d.code} ${d.message}`);
      compared += compareChecks(run, plan, misses);
    }
    expect(misses).toEqual([]);
    expect(compared).toBeGreaterThan(300);
  });
});

/** Compares the plan's check runs with the captured ones by name: run or skipped, and the conclusion when known. */
function compareChecks(
  run: (typeof expected.runs)[number],
  plan: ReturnType<typeof simulate>,
  misses: string[],
): number {
  const predicted = new Map(
    checksOf(plan)
      .filter((c) => c.node.startsWith(run.workflow))
      .map((c) => [c.name, c]),
  );
  let compared = 0;
  for (const check of run.checks) {
    const p = check.name ? predicted.get(check.name) : undefined;
    if (!p) continue;
    compared++;
    const where = `${run.workflow} [${run.event} ${run.ref}] ${check.name}`;
    const expectedRuns = check.conclusion === 'skipped' ? 'no' : 'yes';
    if (p.runs !== expectedRuns) misses.push(`${where}: predicted ${p.runs}, was ${check.conclusion}`);
    else if (p.result.known && p.result.value !== check.conclusion)
      misses.push(`${where}: predicted ${p.result.value}, was ${check.conclusion}`);
  }
  return compared;
}
