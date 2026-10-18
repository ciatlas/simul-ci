import {
  combine,
  type JobStatus,
  jobResult,
  jobStatusAfter,
  jobStatusFunctions,
  known,
  legResult,
  type Result,
  runConclusion,
  stepConclusion,
  stepStatusFunctions,
  unknown,
  type Value,
} from '@simulci/engine';
import { describe, expect, it } from 'vitest';

const result = (r: Result): Value<Result> => known(r);
const ok = result('success');
const fail = result('failure');
const skip = result('skipped');
const cancel = result('cancelled');

describe('combine', () => {
  it('applies the function to known inputs', () => {
    expect(combine([known(1), known(2)], (v) => v[0]! + v[1]!)).toEqual(known(3));
  });

  it('decides over finite candidates when every combination agrees, else lists the results', () => {
    const either = unknown<number>(['u1'], [1, 2]);
    expect(combine([either], (v) => v[0]! > 0)).toEqual(known(true));
    expect(combine([either, known(2)], (v) => v[0] === v[1])).toEqual(unknown(['u1'], [false, true]));
    expect(combine([either, unknown<number>(['u2'], [1, 2])], (v) => v[0] === v[1])).toEqual(
      unknown(['u1', 'u2'], [true, false]),
    );
  });

  it('stays open for open inputs', () => {
    expect(combine([unknown<number>(['u1'])], (v) => v[0])).toEqual(unknown(['u1']));
    expect(combine([known(1), unknown<number>(['u1'])], (v) => v[0]! + v[1]!)).toEqual(unknown(['u1']));
  });
});

describe('steps and legs', () => {
  it('remaps only failure through continue-on-error (lab 5, 13)', () => {
    expect(stepConclusion(fail, known(true))).toEqual(ok);
    expect(stepConclusion(fail, known(false))).toEqual(fail);
    expect(stepConclusion(skip, known(true))).toEqual(skip);
    expect(stepConclusion(cancel, known(true))).toEqual(cancel);
    expect(stepConclusion(fail, unknown<boolean>(['u'], [true, false]))).toEqual(
      unknown(['u'], ['success', 'failure']),
    );
  });

  it('turns the job status to failure at the first failed conclusion, and the status functions follow (lab 5, 15)', () => {
    expect(jobStatusAfter([ok, ok])).toEqual(ok);
    expect(jobStatusAfter([ok, fail, ok])).toEqual(fail);
    expect(jobStatusAfter([ok], true)).toEqual(cancel);
    expect(stepStatusFunctions(known<JobStatus>('success'))).toEqual({
      success: known(true),
      failure: known(false),
      cancelled: known(false),
      always: known(true),
    });
    expect(stepStatusFunctions(known<JobStatus>('failure'))).toEqual({
      success: known(false),
      failure: known(true),
      cancelled: known(false),
      always: known(true),
    });
    const maybe = unknown<'success' | 'failure' | 'cancelled'>(['u'], ['success', 'failure']);
    expect(stepStatusFunctions(maybe).success).toEqual(unknown(['u'], [true, false]));
    expect(stepStatusFunctions(maybe).cancelled).toEqual(known(false));
  });

  it('gives a leg the failure of any step, or the cancellation', () => {
    expect(legResult([ok, skip])).toEqual(ok);
    expect(legResult([ok, fail])).toEqual(fail);
    expect(legResult([ok], true)).toEqual(cancel);
  });
});

describe('jobs and the run', () => {
  it('answers a job-level if from the direct needs (lab 1, 4, 6, 14)', () => {
    expect(jobStatusFunctions([skip])).toMatchObject({ success: known(false), failure: known(false) });
    expect(jobStatusFunctions([ok, ok])).toMatchObject({ success: known(true), failure: known(false) });
    expect(jobStatusFunctions([ok, fail])).toMatchObject({ success: known(false), failure: known(true) });
    expect(jobStatusFunctions([])).toMatchObject({ success: known(true), failure: known(false) });
    expect(jobStatusFunctions([ok]).cancelled).toEqual(known(false));
    expect(jobStatusFunctions([ok], true).cancelled).toEqual(known(true));
    const maybe = unknown<'success' | 'failure' | 'cancelled' | 'skipped'>(['u'], ['success', 'failure']);
    expect(jobStatusFunctions([maybe]).success).toEqual(unknown(['u'], [true, false]));
  });

  it('aggregates legs into the result needs read (lab 4, 6, 7, 9, 14)', () => {
    const plain = { skipped: false, continueOnError: known(false) };
    expect(jobResult({ ...plain, legResults: [ok] })).toEqual(ok);
    expect(jobResult({ ...plain, legResults: [ok, fail] })).toEqual(fail);
    expect(jobResult({ ...plain, legResults: [cancel, fail, cancel] })).toEqual(fail);
    expect(jobResult({ ...plain, legResults: [skip, skip] })).toEqual(skip);
    expect(jobResult({ ...plain, legResults: [skip, ok] })).toEqual(ok);
    expect(jobResult({ skipped: true, continueOnError: known(false), legResults: [] })).toEqual(skip);
    expect(jobResult({ skipped: false, continueOnError: known(true), legResults: [fail] })).toEqual(ok);
    expect(jobResult({ skipped: false, continueOnError: known(true), legResults: [skip] })).toEqual(skip);
    const maybe = unknown<'success' | 'failure' | 'cancelled' | 'skipped'>(['u'], ['success', 'cancelled']);
    expect(jobResult({ ...plain, legResults: [maybe] })).toEqual(unknown(['u'], ['success', 'failure']));
  });

  it('concludes the run from the results, not the conclusions (lab 1, 4, 6)', () => {
    expect(runConclusion([ok, skip])).toEqual(ok);
    expect(runConclusion([ok, fail])).toEqual(fail);
    expect(runConclusion([])).toEqual(ok);
    expect(runConclusion([ok], true)).toEqual(cancel);
  });
});
