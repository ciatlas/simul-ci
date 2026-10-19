import type { NodeId, RunPlan, UnknownId } from '@simulci/engine';
import type { Pin, PlanState } from '../state/store';
import { cardOf } from './navigate';
import type { GraphModel, GraphState } from './types';

/**
 * What the canvas lights up besides the selection (synthesis § 7 and § 11), as functions of the plan, the model, the
 * store and, for the flash, the author's motion preference (`prefers-reduced-motion`, read when it is asked): while
 * an unknown's "affects n" is hovered, the cards that show what it affects and the cards that hold those stay lit and
 * every other card fades; once a pin's plan is on the canvas, the cards it changed flash once. The flash is motion,
 * so an author who asked for less motion never gets it.
 */

/**
 * The cards an unknown lights while its "affects n" is hovered: each card that shows a node it affects (a leg or a
 * step is in its job's card), and every card that holds one of those, up to the root (a job's workflow, a called
 * workflow's calling job). Undefined while no unknown of the plan is hovered; empty for one that affects nothing,
 * which fades every card.
 */
export function litCards(
  model: GraphModel,
  plan: Pick<RunPlan, 'unknowns'> | undefined,
  hovered: UnknownId | undefined,
): ReadonlySet<NodeId> | undefined {
  if (hovered === undefined) return undefined;
  const unknown = plan?.unknowns.find((u) => u.id === hovered);
  if (!unknown) return undefined;
  const lit = new Set<NodeId>();
  for (const id of unknown.affects)
    // A card already lit has its holders lit too.
    for (let at = cardOf(model, id); at !== undefined && !lit.has(at); at = holderOf(model, at)) lit.add(at);
  return lit;
}

/** The card a card is drawn in: a job's workflow, a called workflow's calling job; a root is in none. */
const holderOf = (model: GraphModel, card: NodeId): NodeId | undefined =>
  model.jobs[card]?.scope ?? model.scopes[card]?.caller;

/** How long a card flashes; canvas.css's `sc-flash-a` and `sc-flash-b` keyframes run as long. */
export const FLASH_MS = 1000;

/** The cards a pin changed, which flash once. */
export interface Flash {
  /** The pin's `seq`. */
  seq: number;
  /**
   * `a` for an even pin, `b` for an odd one: the attribute's value changes from one pin to the next, so a card the
   * next pin changes again flashes again.
   */
  parity: 'a' | 'b';
  /** The cards that show a node whose verdict the pin changed. */
  cards: ReadonlySet<NodeId>;
}

/**
 * The flash of the last pin while the canvas shows the plan that answered it: not before that plan's picture is
 * committed (the cards would flash in their old colours), and not once a later plan came without a pin. None at all
 * when the author asked for less motion.
 */
export function flashOf(
  pin: Pin | undefined,
  plan: PlanState | undefined,
  graph: GraphState,
): Flash | undefined {
  if (!pin?.after || !showsPlan(graph, plan, pin.after.plan) || reducedMotion()) return undefined;
  const cards = new Set<NodeId>();
  for (const change of pin.after.changes) {
    const card = cardOf(graph.model, change.id);
    if (card !== undefined) cards.add(card);
  }
  return { seq: pin.seq, parity: pin.seq % 2 === 0 ? 'a' : 'b', cards };
}

/**
 * Whether the store's plan is `answer` and the picture is that plan's. The graph session commits a picture with the
 * `for` of the plan it was built from, the very object, so the two are one exactly when the picture is the plan's.
 */
const showsPlan = (graph: GraphState, plan: PlanState | undefined, answer: RunPlan): boolean =>
  plan?.plan === answer && graph.for === plan.for;

/** Whether the author asked for less motion: no flash, and no animated move of the viewport. */
export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
