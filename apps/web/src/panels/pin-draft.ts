import type { AssumeEntry, RunPlan, Unknown } from '@simulci/engine';
import type { Derived, ModelInfo } from '../worker/protocol';

/**
 * The PinEditor's model (synthesis § 7): an assume entry for a step or job unknown, derived from the unknown's id
 * grammar (`<node>.outputs.<name>`, `<node>.outcome`, `<node>.env.<NAME>`) and `derived.kinds`, never from a string
 * heuristic, with what the plan knows to offer beside it. When the engine later emits pins for these unknowns, the UI
 * prefers `pin.fragment` and this derivation becomes the fallback.
 */

/** What a pin is decided against: the plan, its derived tables, and the models the worker ships. */
export interface PinContext {
  plan: RunPlan;
  derived: Derived;
  models: ModelInfo[];
}

export type Outcome = 'success' | 'failure' | 'cancelled';

/** The part of the entry the unknown is about, which the editor puts first. */
export type DraftAbout = { field: 'outputs' | 'env'; name: string } | { field: 'outcome' };

export interface PinDraft {
  /**
   * The entry as it would be written: `step:` or `job:` by unit path (`build.detect`, `test[node=22]`,
   * `caller/job.step`), `workflow:` only when another depth-0 workflow has a job of the same id, and the field the
   * unknown is about prefilled (an output or env value `''`, the outcome `failure`).
   */
  entry: AssumeEntry;
  about: DraftAbout;
  /** The outcomes the unit can be given: success and failure for a step, cancelled too for a job (SC104). */
  outcomes: Outcome[];
  /** Finite candidates for the output, from the producer's `outputs[name]` when it is unknown with a `oneOf`. */
  candidates: string[];
  /** The model the producing step's `uses` matches (`actions/cache`), whose presets write `as:` instead. */
  model?: { id: string; presets: string[] };
}

/** The draft for a step or job unknown; undefined when the id names no step, leg or job of the plan. */
export function draftFor(_unknown: Unknown, _ctx: PinContext): PinDraft | undefined {
  throw new Error('panels/pin-draft.ts: draftFor is not built yet');
}

/** The draft for editing an entry the author already has: the same offers, about its first stated field. */
export function draftOfEntry(_entry: AssumeEntry, _ctx: PinContext): PinDraft {
  throw new Error('panels/pin-draft.ts: draftOfEntry is not built yet');
}

/** What the editor can say before the worker does: the schema's refinements, worded as the schema words them. */
export function entryProblems(_entry: AssumeEntry): string[] {
  throw new Error('panels/pin-draft.ts: entryProblems is not built yet');
}

/** The entry as a test file writes it under `assume:` (a `- ` item, two-space indents, scalars quoted as YAML needs). */
export function entryYaml(_entry: AssumeEntry): string {
  throw new Error('panels/pin-draft.ts: entryYaml is not built yet');
}
