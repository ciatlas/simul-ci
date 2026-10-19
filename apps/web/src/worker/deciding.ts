/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import {
  decidingReason,
  evaluateFromReads,
  type IfReason,
  type JobPlan,
  jobStatusFunctions,
  known,
  type NodeId,
  type Result,
  type Tri,
  type Value,
  type WorkflowPlan,
} from '@simulci/engine';

/**
 * The needs that decided a job through its `if:` (the canvas draws their edges as deciding). The job's deciding
 * reason is its `if:`, whose answer is not true, and the answer's verdict would differ had every need succeeded, or
 * had the needs only the run knows failed: the condition is evaluated again from its reads with those results, in
 * the status functions (`success()` however it is written) and in `needs.<id>.result`. The needs that decided are
 * the ones known not to succeed, which keep `success()` false whatever the others do; while none is known, the ones
 * only the run knows.
 */
export function decidingNeeds(job: JobPlan, wf: WorkflowPlan): NodeId[] {
  const reason = decidingReason(job.runs.chain, job.runs.verdict);
  if (reason?.kind !== 'if' || isTrue(reason.value) || isSuccess(reason.status)) return [];
  const needs = wf.jobs.filter((j) => job.needs.includes(j.id));
  const open = needs.filter((n) => !isSuccess(n.result));
  if (!open.length || !decided(reason, needs)) return [];
  const failed = open.filter((n) => n.result.known);
  return (failed.length ? failed : open).map((n) => n.id);
}

/** Whether the needs' results move the verdict: every need a success, or the ones only the run knows a failure. */
function decided(reason: IfReason, needs: readonly JobPlan[]): boolean {
  const now = verdictWith(reason, needs, (r) => r);
  return (
    verdictWith(reason, needs, () => known('success')) !== now ||
    verdictWith(reason, needs, (r) => (r.known ? r : known('failure'))) !== now
  );
}

/** The `if:`'s verdict with each need's result replaced as `as` says. */
function verdictWith(
  reason: IfReason,
  needs: readonly JobPlan[],
  as: (result: Value<Result>) => Value<Result>,
): Tri {
  const results = new Map(needs.map((n) => [n.jobId.toLowerCase(), as(n.result)]));
  const reads = reason.reads.map((r) => {
    const result = results.get(resultRead(r.ref) ?? '');
    return result ? { ...r, value: result } : r;
  });
  const value = evaluateFromReads(reason.evaluated, reads, jobStatusFunctions([...results.values()]));
  return value.known ? (value.value ? 'yes' : 'no') : 'maybe';
}

/** The job a `needs.<id>.result` read names, in lower case as GitHub matches job ids. */
function resultRead(ref: string): string | undefined {
  const [context, id, field, ...rest] = ref.split('.');
  return context === 'needs' && field?.toLowerCase() === 'result' && !rest.length
    ? id?.toLowerCase()
    : undefined;
}

const isTrue = (v: Value<boolean>): boolean => v.known && v.value;
const isSuccess = (v: Value<Result>): boolean => v.known && v.value === 'success';
