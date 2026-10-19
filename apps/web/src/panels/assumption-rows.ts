import type { AssumeEntry, Diagnostic, MockValue, RunPlan } from '@simulci/engine';
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

const SEVERITY_RANK: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

/** One row per entry of the case layer, in order, with what the plan applied and said of it. */
export function assumptionRows(
  assume: readonly AssumeEntry[],
  plan: RunPlan,
  derived: Derived,
): AssumptionRow[] {
  return assume.map((entry, index) => {
    const ref = `assume[${index}]`;
    const applied = plan.mocks
      .filter((m) => m.ref === ref)
      .map((m) => ({ at: derived.unitPaths[m.at] ?? m.at, provides: [...m.provides] }));
    const diagnostics = plan.diagnostics
      .filter((d) => d.mock === ref)
      .toSorted((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    return { index, entry, ref, applied, diagnostics, status: diagnostics[0]?.severity ?? 'ok' };
  });
}

/** One line for an entry: its unit and what it states (`build.detect · outputs.changed = true`). */
export function entryLabel(entry: AssumeEntry): string {
  const stated = [
    ...(entry.as === undefined ? [] : [`as ${entry.as}`]),
    ...Object.entries(entry.outputs ?? {}).map(([k, v]) => `outputs.${k} = ${valueText(v)}`),
    ...Object.entries(entry.env ?? {}).map(([k, v]) => `env.${k} = ${valueText(v)}`),
    ...(entry.outcome === undefined ? [] : [`outcome ${entry.outcome}`]),
  ];
  const unit = unitText(entry);
  return stated.length ? `${unit} · ${stated.join(', ')}` : unit;
}

/** `ci.yml:test[node=22]`, `build uses actions/cache`: the unit path with its qualifier and matrix as written. */
function unitText(entry: AssumeEntry): string {
  const path = entry.step ?? entry.job;
  const matrix = Object.entries(entry.matrix ?? {}).map(([k, v]) => `${k}=${String(v)}`);
  const named = `${path ?? ''}${matrix.length ? `[${matrix.join(',')}]` : ''}`;
  const unit = entry.uses === undefined ? named : `${named ? `${named} ` : ''}uses ${entry.uses}`;
  return entry.workflow === undefined ? unit : `${entry.workflow}:${unit}`;
}

/** A stated value: `''` for the empty string so it shows, `unknown` for an un-pin. */
function valueText(v: MockValue): string {
  if (typeof v === 'object') return 'unknown';
  if (v === '') return "''";
  return String(v);
}

/**
 * The worker's refusal of the entry at `index` (an `invalid` reply with `what: 'assume'` and issue paths `[i, …]`),
 * as messages with the rest of the path in front.
 */
export function issuesOf(issues: readonly Issue[], index: number): string[] {
  return issues
    .filter((issue) => issue.path[0] === index)
    .map((issue) => {
      const rest = issue.path.slice(1);
      return rest.length ? `${rest.join('.')}: ${issue.message}` : issue.message;
    });
}
