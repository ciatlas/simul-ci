import type { Result, Value } from './plan/types';
import { combine, known } from './plan/values';

/**
 * How results propagate: from steps to a leg, from legs to a job, from needs to the status functions a job-level
 * `if:` reads, from jobs to the run. Every rule is backed by a routes-lab case (fixtures/routes-lab/cases.md).
 */

/** The job status the status functions read inside a job: `success` until a step's conclusion is `failure`. */
export type JobStatus = 'success' | 'failure' | 'cancelled';

/** The four status functions, answered for one point of the run. */
export type StatusAnswers = Record<'success' | 'failure' | 'cancelled' | 'always', Value<boolean>>;

/** A step's conclusion after `continue-on-error`: only `failure` is remapped, to `success` (lab 5, 13). */
export function stepConclusion(outcome: Value<Result>, continueOnError: Value<boolean>): Value<Result> {
  return combine([outcome, continueOnError] as Value<Result | boolean>[], ([o, c]) =>
    o === 'failure' && c === true ? 'success' : (o as Result),
  );
}

/** The job status after the steps so far: `failure` once a conclusion is `failure`, else `success` (lab 5). */
export function jobStatusAfter(conclusions: readonly Value<Result>[], cancelled = false): Value<JobStatus> {
  if (cancelled) return known('cancelled');
  return combine(conclusions, (cs) => (cs.includes('failure') ? 'failure' : 'success'));
}

/** Inside a job, the status functions read `job.status`; `always()` is always true (lab 5, 13, 15). */
export function stepStatusFunctions(status: Value<JobStatus>): StatusAnswers {
  const is = (s: JobStatus) => combine([status], ([v]) => v === s);
  return { success: is('success'), failure: is('failure'), cancelled: is('cancelled'), always: known(true) };
}

/**
 * At a job-level `if:`, `success()` is true when every direct need succeeded, `failure()` when any need's result is
 * `failure`; a skipped need satisfies neither (lab 1); a need that failed under `continue-on-error` reads as
 * `success` (lab 4); fail-fast cancelled legs read as `failure`, never `cancelled` (lab 6, 14). `cancelled()` is
 * true only when the run was cancelled, which the simulation never assumes.
 */
export function jobStatusFunctions(
  needResults: readonly Value<Result>[],
  runCancelled = false,
): StatusAnswers {
  return {
    success: combine(needResults, (rs) => rs.every((r) => r === 'success')),
    failure: combine(needResults, (rs) => rs.some((r) => r === 'failure')),
    cancelled: known(runCancelled),
    always: known(true),
  };
}

/** A leg's result from its steps' conclusions: `failure` once any is, `cancelled` when the leg was, else `success`. */
export function legResult(conclusions: readonly Value<Result>[], cancelled = false): Value<Result> {
  if (cancelled) return known('cancelled');
  return combine(conclusions, (cs) => (cs.includes('failure') ? 'failure' : 'success'));
}

/**
 * A job's result as `needs.<id>.result` and the run read it: `skipped` when it did not run; `success` whatever its
 * legs did when it has `continue-on-error: true` (lab 4); else `failure` when any leg is `failure` or `cancelled`
 * (lab 6, 7, 14), and `success` otherwise. A reusable call takes the result of the callee's jobs: `skipped` when every
 * one is (lab 9), `failure` when any is, else `success`.
 */
export function jobResult(opts: {
  skipped: boolean;
  continueOnError: Value<boolean>;
  legResults: readonly Value<Result>[];
}): Value<Result> {
  if (opts.skipped) return known('skipped');
  const aggregate = combine(opts.legResults, (rs) =>
    rs.length > 0 && rs.every((r) => r === 'skipped')
      ? 'skipped'
      : rs.some((r) => r === 'failure' || r === 'cancelled')
        ? 'failure'
        : 'success',
  );
  return combine([aggregate, opts.continueOnError] as Value<Result | boolean>[], ([r, c]) =>
    c === true && r === 'failure' ? 'success' : (r as Result),
  );
}

/**
 * The run's conclusion: `failure` when any job's result is `failure` (so a `continue-on-error` job and skipped jobs
 * leave it `success`; lab 1, 4, 6), `cancelled` when the run was, else `success`.
 */
export function runConclusion(jobResults: readonly Value<Result>[], cancelled = false): Value<Result> {
  if (cancelled) return known('cancelled');
  return combine(jobResults, (rs) => (rs.some((r) => r === 'failure') ? 'failure' : 'success'));
}
