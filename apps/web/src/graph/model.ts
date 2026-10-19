import type { RunPlan } from '@simulci/engine';
import type { Derived } from '../worker/protocol';
import type { GraphModel, GraphUi } from './types';

/** The canvas's model of a plan: scopes, job cards and `needs` edges (synthesis § 6). */
export function graphModel(_plan: RunPlan, _derived: Derived, _ui: GraphUi): GraphModel {
  throw new Error('not built yet');
}
