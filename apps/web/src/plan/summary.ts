import type { JobPlan, RunPlan, Tri, WorkflowPlan } from '@simulci/engine';

/** What the status bar says about a plan, one sentence, for the eye and for the screen reader. */
export interface Summary {
  scenario: string;
  workflows: Record<Tri, number>;
  jobs: Record<Tri, number>;
  unknowns: number;
  errors: number;
  sentence: string;
}

export function summarize(plan: RunPlan): Summary {
  const workflows: Record<Tri, number> = { yes: 0, no: 0, maybe: 0 };
  const jobs: Record<Tri, number> = { yes: 0, no: 0, maybe: 0 };
  for (const wf of plan.workflows) {
    if (wf.depth !== 0) continue;
    workflows[wf.triggered.verdict]++;
    for (const job of jobsOf(wf)) jobs[job.runs.verdict]++;
  }
  const errors = plan.diagnostics.filter((d) => d.severity === 'error').length;
  const scenario = scenarioLabel(plan);
  const total = workflows.yes + workflows.no + workflows.maybe;
  const parts = [`${workflows.yes} of ${total} ${plural(total, 'workflow')} triggered`];
  if (workflows.maybe) parts.push(`${workflows.maybe} might`);
  parts.push(
    `${jobs.yes} ${plural(jobs.yes, 'job')} run, ${jobs.no} skipped${jobs.maybe ? `, ${jobs.maybe} might` : ''}`,
  );
  if (plan.unknowns.length) parts.push(`${plan.unknowns.length} ${plural(plan.unknowns.length, 'unknown')}`);
  if (errors) parts.push(`${errors} ${plural(errors, 'error')}`);
  return {
    scenario,
    workflows,
    jobs,
    unknowns: plan.unknowns.length,
    errors,
    sentence: `${scenario}: ${parts.join('; ')}`,
  };
}

/** Every job of a workflow and of the workflows it calls. */
function* jobsOf(wf: WorkflowPlan): Generator<JobPlan> {
  for (const job of wf.jobs) {
    yield job;
    for (const leg of job.legs) if (leg.call) yield* jobsOf(leg.call);
  }
}

/** `push to main`, `pull_request (labeled) to main`, `workflow_dispatch`, `schedule 0 6 * * 1`. */
export function scenarioLabel(plan: RunPlan): string {
  const s = plan.scenario;
  const action = s.action ? ` (${s.action})` : '';
  if (s.event === 'schedule') return `schedule${s.cron ? ` ${s.cron}` : ''}`;
  if (s.baseRef) return `${s.event}${action} to ${s.baseRef}`;
  if (s.refName) return `${s.event}${action} ${s.refType === 'tag' ? 'of tag' : 'to'} ${s.refName}`;
  return `${s.event}${action}`;
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);
