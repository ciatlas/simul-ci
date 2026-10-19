import type { AssumeEntry, Json, ScenarioInput, Unknown } from '@simulci/engine';
import type { PinContext, PinDraft } from '../panels/pin-draft';
import type { FieldFocus } from '../state/store';

/**
 * What an unknown's row offers (synthesis § 7's table), and the pure edits a pin makes: a scenario fragment merged
 * into the scenario, an assume entry added to or removed from the case layer. The UI never invents a fragment for a
 * scenario unknown: it applies whichever one the unknown carries.
 */

export type PinControl =
  /** A scenario field pins it (`pin.layer === 'scenario'`, or an input's expression default): Set … naming the field. */
  | { kind: 'scenario'; label: string; fragment: Record<string, Json>; focus: Omit<FieldFocus, 'seq'> }
  /** An assume entry the engine wrote pins it (the fail-fast race): Assume cancelled. */
  | { kind: 'assume'; label: string; entry: AssumeEntry }
  /** A step or job output, outcome or env write the engine has no pin for: Pin… opens the PinEditor, prefilled. */
  | { kind: 'editor'; label: string; draft: PinDraft }
  /** Nothing the author writes pins it: the unknown's `gap`, or "only the run decides it" (generate.ts's words). */
  | { kind: 'none'; text: string };

/** The control for an unknown's row. */
export function pinControl(_unknown: Unknown, _ctx: PinContext): PinControl {
  throw new Error('scenario/apply-pin.ts: pinControl is not built yet');
}

/**
 * The scenario with a pin's fragment merged as the test runner merges `when` over `given` (engine
 * test/runner.ts `mergeScenario`): `inputs`, `vars` and `actor` key by key, the ref group (`ref`, `branch`, `tag`)
 * replaced whole when the fragment names any of it, anything else replaced. `keys` are the top-level keys written,
 * for the assumed marks.
 */
export function applyScenarioPin(
  _scenario: ScenarioInput,
  _fragment: Record<string, Json>,
): { scenario: ScenarioInput; keys: string[] } {
  throw new Error('scenario/apply-pin.ts: applyScenarioPin is not built yet');
}

/**
 * The field a fragment writes, as an issue-style path the form resolves (`vars` with the variable as `entry`,
 * `inputs.<name>`, `actor.login`, `workflow_run.<key>`, `changed`, `action`, `tag`, `sha`, `repository`).
 */
export function pinFocus(_fragment: Record<string, Json>): Omit<FieldFocus, 'seq'> {
  throw new Error('scenario/apply-pin.ts: pinFocus is not built yet');
}

/** The case layer with an entry added at the end, or put in place of the entry at `at`. */
export function withEntry(_assume: readonly AssumeEntry[], _entry: AssumeEntry, _at?: number): AssumeEntry[] {
  throw new Error('scenario/apply-pin.ts: withEntry is not built yet');
}

/** The case layer without the entry at `at`. */
export function withoutEntry(_assume: readonly AssumeEntry[], _at: number): AssumeEntry[] {
  throw new Error('scenario/apply-pin.ts: withoutEntry is not built yet');
}
