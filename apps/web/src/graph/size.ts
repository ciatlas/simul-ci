import type { GridGeometry, JobModel, Metrics, Point, Size } from './types';

/** Card sizes from labels and counts, never from verdicts, so a recolour never moves a card. */

/** The leg grid of a job with `count` legs. */
export function legGrid(_count: number): GridGeometry {
  throw new Error('not built yet');
}

/** A job card's size; a call job's wraps its callee's laid-out size. */
export function cardSize(_job: JobModel, _metrics: Metrics, _callee?: Size): Size {
  throw new Error('not built yet');
}

/** Where a call job's callee sits inside its card, relative to the card's top-left corner. */
export function calleeOffset(_job: JobModel): Point {
  throw new Error('not built yet');
}
