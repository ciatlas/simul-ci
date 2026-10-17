import type { JobPlan, LegPlan, Result, RunPlan, Tri, Value, WorkflowPlan } from './types';

export interface CheckVerdict {
  name: string;
  /** The node that reports it. */
  node: string;
  runs: Tri;
  result: Value<Result>;
  certain: boolean;
}

/** Every check run the plan predicts, in plan order, with the leg (or skipped job) that reports it. */
export function checksOf(plan: RunPlan): CheckVerdict[] {
  return plan.workflows.flatMap(workflowChecks);
}

function workflowChecks(wf: WorkflowPlan): CheckVerdict[] {
  return wf.jobs.flatMap(jobChecks);
}

function jobChecks(job: JobPlan): CheckVerdict[] {
  if (job.runs.verdict === 'no') {
    return [
      {
        name: job.check.skippedName,
        node: job.id,
        runs: 'no',
        result: job.result,
        certain: job.check.certain,
      },
    ];
  }
  return job.legs.flatMap(legChecks);
}

function legChecks(leg: LegPlan): CheckVerdict[] {
  if (leg.call) return workflowChecks(leg.call);
  if (!leg.check) return [];
  return [
    {
      name: leg.check.name,
      node: leg.id,
      runs: leg.runs.verdict,
      result: leg.result,
      certain: leg.check.certain,
    },
  ];
}
