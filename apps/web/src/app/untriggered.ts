import type { Scenario, ScenarioInput } from '@simulci/engine';
import type { PlanState } from '../state/store';
import type { Outline } from '../worker/protocol';

/**
 * What the banner over an untriggered workflow being edited says (synthesis § 4.12): the scenario it is not triggered
 * by, the clause that decided it as the CLI words it, and another of its events to simulate instead.
 */
export interface UntriggeredNote {
  /** The scenario in words: `push to main`, `pull_request.opened to main`, `schedule`. */
  by: string;
  /** The workflow's deciding clause (`branches [release/**] ← main: false`); absent when the plan has none. */
  clause?: string;
  /** The first event of the workflow's `on:` the scenario does not simulate: "Simulate <event> instead". */
  instead?: string;
}

/**
 * The note for the focused workflow when it is untriggered and its plan holds the jobs edit mode had the engine plan
 * anyway, which the canvas draws dimmed (graph/model.ts); nothing for any other plan.
 */
export function untriggeredNote(
  plan: PlanState | undefined,
  focus: string | undefined,
  outline: Outline | undefined,
  scenario: ScenarioInput,
): UntriggeredNote | undefined {
  const wf = plan?.plan.workflows.find((w) => w.depth === 0 && w.path === focus);
  if (!plan || !wf || wf.triggered.verdict !== 'no' || wf.jobs.length === 0) return undefined;
  const note: UntriggeredNote = { by: scenarioWords(plan.plan.scenario) };
  const clause = plan.derived.clauses[wf.id];
  if (clause) note.clause = clause;
  const events = outline?.workflows.find((w) => w.path === wf.path)?.events ?? [];
  const instead = events.find((e) => e.event !== scenario.event)?.event;
  if (instead !== undefined) note.instead = instead;
  return note;
}

/** The event and, where one decides it, the branch it goes to: a pull request's base, a push's ref. */
function scenarioWords(s: Scenario): string {
  const event = s.action === undefined ? s.event : `${s.event}.${s.action}`;
  const to = s.baseRef ?? (s.event === 'push' ? s.refName : undefined);
  return to === undefined ? event : `${event} to ${to}`;
}
