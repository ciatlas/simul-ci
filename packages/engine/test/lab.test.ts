import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checksOf, type ScenarioInput, simulate } from '@simulci/engine';
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

const files = walk(join(lab, 'repo'));

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

const mockFree = (run: (typeof expected.runs)[number]) =>
  run.jobs.every((j) => j.conclusion === 'success' || j.conclusion === 'skipped');

describe('routes lab', () => {
  it('predicts every captured run as triggered', () => {
    const misses: string[] = [];
    for (const run of expected.runs) {
      const plan = simulate({ files, scenario: scenarioOf(run) });
      const wf = plan.workflows.find((w) => w.path === run.workflow)!;
      if (wf.triggered.verdict !== 'yes')
        misses.push(
          `${run.workflow} ${run.event} ${run.ref}: ${wf.triggered.verdict} ${JSON.stringify(wf.triggered.chain.at(-1))}`,
        );
    }
    expect(misses).toEqual([]);
  });

  it('predicts every check run and its conclusion for the runs without failing steps', () => {
    const misses: string[] = [];
    let compared = 0;
    for (const run of expected.runs.filter(mockFree)) {
      const plan = simulate({ files, scenario: scenarioOf(run) });
      const predicted = new Map(
        checksOf(plan)
          .filter((c) => c.node.startsWith(run.workflow))
          .map((c) => [c.name, c]),
      );
      for (const check of run.checks) {
        if (!check.name || !predicted.has(check.name)) continue;
        compared++;
        const p = predicted.get(check.name)!;
        const expectedRuns = check.conclusion === 'skipped' ? 'no' : 'yes';
        if (p.runs !== expectedRuns)
          misses.push(
            `${run.workflow} [${run.event} ${run.ref}] ${check.name}: predicted ${p.runs}, was ${check.conclusion}`,
          );
      }
    }
    expect(misses).toEqual([]);
    expect(compared).toBeGreaterThan(100);
  });
});
