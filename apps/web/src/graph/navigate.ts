import type { NodeId } from '@simulci/engine';
import type { GraphLayout, GraphModel, JobModel, Point, ScopeModel, StepMark } from './types';

/**
 * The canvas keys (synthesis § 11), pure: ↓/↑ the next or previous sibling in layout order, →/← along a `needs` edge
 * (Alt cycles), Enter descends, Esc ascends then leaves, Space opens a job's step list, `.` centres, `f` fits, `0`
 * shows 100 %. React Flow's own arrow keys stay inert: nothing on the canvas is draggable.
 *
 * Layout order is the order the eye reads: a scope's jobs by x then y, a job's legs in grid order, a leg's steps in
 * strip order, the roots in stack order. Legs and steps are selectable though they are not canvas nodes; a node the
 * model leaves out (a step of a leg the card does not show) acts from its nearest ancestor the model has.
 */

export type NavAction =
  | { select: NodeId | undefined }
  | { toggle: NodeId }
  | { fit: true }
  | { centre: NodeId }
  | { actualSize: true }
  | { leave: true };

/** What the keys read of a KeyboardEvent, which passes as one; Ctrl and Meta combinations stay the browser's. */
export interface NavKey {
  key: string;
  altKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** The last `needs` edge →/← took, which Alt+→/Alt+← cycles on from. */
interface EdgeCursor {
  from: NodeId;
  to: NodeId;
  forward: boolean;
}

/** Where a selectable node sits: a leg or a step is told by the card that holds it. */
type Place =
  | { kind: 'scope'; scope: ScopeModel }
  | { kind: 'job'; job: JobModel }
  | { kind: 'leg'; job: JobModel; leg: NodeId }
  | { kind: 'step'; job: JobModel; list: readonly StepMark[]; step: StepMark; parent?: StepMark };

interface Here {
  id: NodeId;
  place: Place;
  model: GraphModel;
  layout: GraphLayout;
  alt: boolean;
  last: EdgeCursor | undefined;
}

interface Move {
  action?: NavAction;
  edge?: EdgeCursor;
}

/** The action for a key; Alt+→/Alt+← take the first edge, as →/← do, since nothing remembers the last one. */
export function navigate(
  key: NavKey,
  at: NodeId | undefined,
  model: GraphModel,
  layout: GraphLayout,
): NavAction | undefined {
  return move(key, at, model, layout, undefined).action;
}

/** `navigate` with the last edge taken remembered, so Alt+→/Alt+← cycle; the canvas holds one per mount. */
export function createNavigator(): typeof navigate {
  let last: EdgeCursor | undefined;
  return (key, at, model, layout) => {
    const result = move(key, at, model, layout, last);
    if (result.edge) last = result.edge;
    return result.action;
  };
}

/** The canvas node that shows a node: a leg or a step is in its job's card. */
export function cardOf(model: GraphModel, id: NodeId): NodeId | undefined {
  const found = locate(model, id);
  return found && cardOfPlace(found.place);
}

const VIEW = new Map<string, NavAction>([
  ['f', { fit: true }],
  ['0', { actualSize: true }],
]);

const KEYS = new Map<string, (here: Here) => Move>([
  ['ArrowDown', (h) => selected(neighbour(siblings(h), h.id, 1), h.id)],
  ['ArrowUp', (h) => selected(neighbour(siblings(h), h.id, -1), h.id)],
  ['ArrowRight', (h) => alongEdge(h, true)],
  ['ArrowLeft', (h) => alongEdge(h, false)],
  ['Enter', (h) => selected(descend(h), h.id)],
  ['Escape', (h) => ({ action: ascend(h.place) })],
  [' ', (h) => (h.place.kind === 'job' ? { action: { toggle: h.place.job.id } } : {})],
  ['.', (h) => ({ action: { centre: cardOfPlace(h.place) } })],
]);

function move(
  key: NavKey,
  at: NodeId | undefined,
  model: GraphModel,
  layout: GraphLayout,
  last: EdgeCursor | undefined,
): Move {
  if (key.ctrlKey || key.metaKey) return {};
  const view = VIEW.get(key.key);
  if (view) return { action: view };
  const found = at === undefined ? undefined : locate(model, at);
  if (!found) return { action: fromNothing(key.key, model) };
  // A node the model leaves out ascends to the ancestor it acts from.
  if (found.id !== at && key.key === 'Escape') return { action: { select: found.id } };
  const handler = KEYS.get(key.key);
  return handler ? handler({ ...found, model, layout, alt: key.altKey, last }) : {};
}

/** Nothing selected, or a selection the canvas does not show: the first root to start from, Esc leaves. */
function fromNothing(key: string, model: GraphModel): NavAction | undefined {
  if (key === 'Escape') return { leave: true };
  const first = model.roots[0];
  return first !== undefined && STARTS.has(key) ? { select: first } : undefined;
}

const STARTS = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter']);

const selected = (to: NodeId | undefined, from: NodeId): Move =>
  to === undefined || to === from ? {} : { action: { select: to } };

/** Ids that end a part of a node id: a job after `#`, a leg at `[`, a step after `/`, a callee or action after `>`. */
const BOUNDARY = new Set(['#', '[', '/', '>']);

const placesByModel = new WeakMap<GraphModel, Map<NodeId, Place>>();

function locate(model: GraphModel, at: NodeId): { id: NodeId; place: Place } | undefined {
  let places = placesByModel.get(model);
  if (!places) {
    places = placesOf(model);
    placesByModel.set(model, places);
  }
  const place = places.get(at);
  if (place) return { id: at, place };
  const id = nearestKnown(places, at);
  return id === undefined ? undefined : { id, place: places.get(id)! };
}

function nearestKnown(places: Map<NodeId, Place>, at: NodeId): NodeId | undefined {
  let best: NodeId | undefined;
  for (const id of places.keys()) {
    const prefix = at.startsWith(id) && BOUNDARY.has(at[id.length] ?? '');
    if (prefix && (best === undefined || id.length > best.length)) best = id;
  }
  return best;
}

function placesOf(model: GraphModel): Map<NodeId, Place> {
  const places = new Map<NodeId, Place>();
  for (const scope of Object.values(model.scopes)) places.set(scope.id, { kind: 'scope', scope });
  for (const job of Object.values(model.jobs)) {
    places.set(job.id, { kind: 'job', job });
    for (const cell of job.legs ?? [])
      if (cell.id !== job.id) places.set(cell.id, { kind: 'leg', job, leg: cell.id });
    addSteps(places, job, job.steps, undefined);
  }
  return places;
}

function addSteps(
  places: Map<NodeId, Place>,
  job: JobModel,
  list: readonly StepMark[],
  parent: StepMark | undefined,
): void {
  for (const step of list) {
    places.set(
      step.id,
      parent ? { kind: 'step', job, list, step, parent } : { kind: 'step', job, list, step },
    );
    addSteps(places, job, step.inner, step);
  }
}

function cardOfPlace(place: Place): NodeId {
  return place.kind === 'scope' ? place.scope.id : place.job.id;
}

const FAR: Point = { x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER };

/** A scope's jobs by x then y; a job the layout has not placed goes last, in declaration order. */
function jobsOf(scope: ScopeModel | undefined, layout: GraphLayout): NodeId[] {
  if (!scope) return [];
  const positions = layout.scopes[scope.id]?.positions;
  return scope.jobs
    .map((id, i) => ({ id, i, p: positions?.[id] ?? FAR }))
    .sort((a, b) => a.p.x - b.p.x || a.p.y - b.p.y || a.i - b.i)
    .map((e) => e.id);
}

function siblings(h: Here): readonly NodeId[] {
  const place = h.place;
  if (place.kind === 'scope') return place.scope.caller === undefined ? h.model.roots : [place.scope.id];
  if (place.kind === 'job') return jobsOf(h.model.scopes[place.job.scope], h.layout);
  if (place.kind === 'leg') return (place.job.legs ?? []).map((c) => c.id);
  return place.list.map((s) => s.id);
}

function neighbour(ids: readonly NodeId[], id: NodeId, by: number): NodeId | undefined {
  const i = ids.indexOf(id);
  return i === -1 ? undefined : ids[i + by];
}

/** →: the jobs that need this one; ←: the jobs it needs; each in layout order. */
function edgeEnds(job: JobModel | undefined, h: Here, forward: boolean): NodeId[] {
  const scope = job && h.model.scopes[job.scope];
  if (!job || !scope) return [];
  const ends = new Set(
    scope.edges
      .filter((e) => (forward ? e.source : e.target) === job.id)
      .map((e) => (forward ? e.target : e.source)),
  );
  return jobsOf(scope, h.layout).filter((id) => ends.has(id));
}

function alongEdge(h: Here, forward: boolean): Move {
  if (h.place.kind !== 'job') return {};
  const { from, after } = h.alt ? cycleFrom(h.id, forward, h.last) : { from: h.id, after: undefined };
  const ends = edgeEnds(h.model.jobs[from], h, forward);
  if (ends.length === 0) return {};
  const i = after === undefined ? -1 : ends.indexOf(after);
  const to = ends[(i + 1) % ends.length]!;
  return { ...selected(to, h.id), edge: { from, to, forward } };
}

/**
 * Where Alt cycles from: standing on the end of the last edge, the next edge of the node it left; back on that node,
 * the edge after the last one taken; anywhere else, the first edge of where it stands.
 */
function cycleFrom(
  at: NodeId,
  forward: boolean,
  last: EdgeCursor | undefined,
): { from: NodeId; after?: NodeId } {
  if (last?.forward !== forward) return { from: at };
  if (last.to === at) return { from: last.from, after: at };
  if (last.from === at) return { from: at, after: last.to };
  return { from: at };
}

function descend(h: Here): NodeId | undefined {
  const place = h.place;
  if (place.kind === 'scope') return place.scope.collapsed ? undefined : jobsOf(place.scope, h.layout)[0];
  if (place.kind === 'job') return place.job.legs ? representative(place.job) : legChild(place.job, h);
  if (place.kind === 'leg')
    return place.leg === representative(place.job) ? legChild(place.job, h) : undefined;
  return place.step.inner[0]?.id;
}

/** What the card shows under its representative leg: the callee's first job for a call, else the first step. */
function legChild(job: JobModel, h: Here): NodeId | undefined {
  if (job.callee === undefined) return job.steps[0]?.id;
  const callee = h.model.scopes[job.callee];
  if (!callee || callee.collapsed) return job.callee;
  return jobsOf(callee, h.layout)[0] ?? job.callee;
}

const representative = (job: JobModel): NodeId => job.representative ?? job.legs?.[0]?.id ?? job.id;

function ascend(place: Place): NavAction {
  if (place.kind === 'scope') return place.scope.caller ? { select: place.scope.caller } : { leave: true };
  if (place.kind === 'job') return { select: place.job.scope };
  if (place.kind === 'leg') return { select: place.job.id };
  if (place.parent) return { select: place.parent.id };
  return { select: place.job.legs ? representative(place.job) : place.job.id };
}
