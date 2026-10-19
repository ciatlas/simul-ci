import type { Diagnostic, NodeId, RunPlan } from '@simulci/engine';
import type { Outline } from '../worker/protocol';

/**
 * The Problems tab as rows (synthesis § 10): a file that could not be read (`outline.files[].errors`, one row per
 * error with its line and column), a workflow file that is no workflow (no `on:` and no `jobs:`), and the plan's
 * diagnostics that are not an assumption's (those show on the entry in the Unknowns tab). Errors first, then
 * warnings, then info; within a severity by file and line.
 */

export interface ProblemRow {
  severity: Diagnostic['severity'];
  /** `parse` for a file that could not be read, `workflow` for one that is no workflow, else the diagnostic's code. */
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** The node the diagnostic is about, which a click selects. */
  node?: NodeId;
}

export function problemRows(_outline: Outline | undefined, _plan: RunPlan | undefined): ProblemRow[] {
  throw new Error('panels/problems.ts: problemRows is not built yet');
}
