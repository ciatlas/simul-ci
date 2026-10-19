import type { AssumeEntry, Diagnostic, RunPlan } from '@simulci/engine';
import type { Issue } from '../state/store';
import type { Derived } from '../worker/protocol';

/**
 * The Assumptions list (synthesis § 7): the case layer made visible, exactly the generated case's `assume` in order,
 * each entry with what the plan says of it: where it applied (`plan.mocks`, ref `assume[i]`) and the diagnostics
 * whose `mock` names it (SC100 a path that reads nothing, SC101 an undeclared output, SC102 matches nothing, SC103 a
 * conflict, SC105 an unknown preset: errors; SC108 info).
 */

export interface AssumptionRow {
  index: number;
  entry: AssumeEntry;
  /** `assume[i]`, as `plan.mocks[].ref` and `diagnostics[].mock` name it. */
  ref: string;
  /** Where it applied, as unit paths (`derived.unitPaths`, else the node id), and the fields it supplied there. */
  applied: { at: string; provides: string[] }[];
  /** The diagnostics naming it, errors first, then warnings, then info. */
  diagnostics: Diagnostic[];
  /** The worst diagnostic's severity, or `ok`: an error makes the plan invalid for tests. */
  status: 'error' | 'warning' | 'info' | 'ok';
}

export function assumptionRows(
  _assume: readonly AssumeEntry[],
  _plan: RunPlan,
  _derived: Derived,
): AssumptionRow[] {
  throw new Error('panels/assumptions.ts: assumptionRows is not built yet');
}

/** One line for an entry: its unit and what it states (`build.detect · outputs.changed = true`). */
export function entryLabel(_entry: AssumeEntry): string {
  throw new Error('panels/assumptions.ts: entryLabel is not built yet');
}

/**
 * The worker's refusal of the entry at `index` (an `invalid` reply with `what: 'assume'` and issue paths `[i, …]`),
 * as messages with the rest of the path in front.
 */
export function issuesOf(_issues: readonly Issue[], _index: number): string[] {
  throw new Error('panels/assumptions.ts: issuesOf is not built yet');
}
