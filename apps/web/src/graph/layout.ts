import type { NodeId } from '@simulci/engine';
import { fnv1a } from '../lib/hash';
import type { LayoutEdge, LayoutNode, LayoutRequest } from '../worker/layout-protocol';
import { callFrame, cardSize } from './size';
import {
  CARD,
  type GraphLayout,
  type GraphModel,
  type JobModel,
  type Metrics,
  type ScopeLayout,
  type ScopeModel,
  type Size,
} from './types';

/**
 * Where everything goes. Each open scope's positions are cached under its shape and the sizes its cards measure at,
 * so a scenario that only recolours finds every scope cached and asks the worker nothing, and a new job lays out
 * its own scope again (and the scopes that call it, whose call card grows) and nothing else. Collapsed scopes are
 * one line and never laid out. The root stack is not ELK: depth-0 workflows top to bottom at x 0, `rootGap` apart.
 */

/** One open scope: its cache key, its cards as the worker wants them, and its positions once they exist. */
export interface PlacedScope {
  scope: ScopeModel;
  key: string;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  layout?: ScopeLayout;
}

export interface LayoutPlan {
  /** Every open scope reachable from the roots, callees before their callers. */
  placed: PlacedScope[];
  /** The scopes without positions, for the layout worker; absent when the cache had them all. */
  request?: Omit<LayoutRequest, 'id' | 'type'>;
}

export interface LayoutCache {
  plan(model: GraphModel, metrics: Metrics): LayoutPlan;
  /** Keeps the worker's answer and returns the plan with those scopes placed. */
  keep(plan: LayoutPlan, scopes: Readonly<Record<NodeId, ScopeLayout>>): LayoutPlan;
}

/** `limit` scope layouts, least recently used out first: enough for every shape an author toggles between. */
export function createLayoutCache(limit = 256): LayoutCache {
  const entries = new Map<string, ScopeLayout>();
  const get = (key: string): ScopeLayout | undefined => {
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key);
      entries.set(key, hit);
    }
    return hit;
  };
  const set = (key: string, layout: ScopeLayout): void => {
    entries.delete(key);
    entries.set(key, layout);
    for (const old of entries.keys()) {
      if (entries.size <= limit) break;
      entries.delete(old);
    }
  };
  return {
    plan(model, metrics) {
      const placed = placeScopes(model, metrics).map((p) => withLayout(p, get(p.key)));
      return { placed, ...requestFor(placed) };
    },
    keep(plan, scopes) {
      const placed = plan.placed.map((p) => {
        const answer = p.layout ? undefined : scopes[p.scope.id];
        if (answer) set(p.key, answer);
        return withLayout(p, p.layout ?? answer);
      });
      return { placed };
    },
  };
}

const withLayout = (p: PlacedScope, layout: ScopeLayout | undefined): PlacedScope =>
  layout ? { ...p, layout } : p;

/** Open scopes depth first from the roots, each after the callees of its jobs. */
function placeScopes(model: GraphModel, metrics: Metrics): PlacedScope[] {
  const placed: PlacedScope[] = [];
  const keys = new Map<NodeId, string>();
  const visit = (id: NodeId): void => {
    const scope = model.scopes[id];
    if (!scope || scope.collapsed || keys.has(id)) return;
    const jobs = jobsOf(model, scope);
    for (const job of jobs) if (job.callee !== undefined) visit(job.callee);
    const nodes = jobs.map((job) => layoutNode(model, job, metrics));
    const ids = new Set(scope.jobs);
    // An edge to a job the scope does not hold has nothing to attach to.
    const edges = scope.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, source: e.source, target: e.target }));
    const key = keyOf(scope, nodes, edges, keys);
    keys.set(id, key);
    placed.push({ scope, key, nodes, edges });
  };
  for (const root of model.roots) visit(root);
  return placed;
}

const jobsOf = (model: GraphModel, scope: ScopeModel): JobModel[] =>
  scope.jobs.flatMap((id) => model.jobs[id] ?? []);

/** A card the worker places: sized here, or around an open callee the worker sizes from its layout. */
function layoutNode(model: GraphModel, job: JobModel, metrics: Metrics): LayoutNode {
  const callee = job.callee === undefined ? undefined : model.scopes[job.callee];
  if (callee && !callee.collapsed) return { id: job.id, callee: callee.id, ...callFrame(job, metrics) };
  return { id: job.id, ...cardSize(job, metrics, callee ? CARD.collapsed : undefined) };
}

/**
 * The shape the model computed, refined by what the worker would be sent: two scopes with one key get the same
 * positions. A call card's line names its callee's key, so a callee that changes changes its caller's key too.
 */
function keyOf(
  scope: ScopeModel,
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  keys: ReadonlyMap<NodeId, string>,
): string {
  const lines = nodes.map((n) =>
    'callee' in n
      ? `${n.id} ${keys.get(n.callee)} ${n.min.width}x${n.min.height}+${n.extra.width}x${n.extra.height}`
      : `${n.id} ${n.width}x${n.height}`,
  );
  for (const e of edges) lines.push(`${e.source}->${e.target}`);
  return `${scope.id}\n${scope.shape}\n${fnv1a(lines.join('\n'))}`;
}

/** The scopes the cache lacks, and the sizes of the cached callees they call. */
function requestFor(placed: readonly PlacedScope[]): Pick<LayoutPlan, 'request'> {
  const missing = placed.filter((p) => !p.layout);
  if (missing.length === 0) return {};
  const cached = new Map(placed.flatMap((p) => (p.layout ? [[p.scope.id, p.layout] as const] : [])));
  const callees = missing.flatMap((p) => p.nodes.flatMap((n) => ('callee' in n ? [n.callee] : [])));
  const known: Record<NodeId, Size> = {};
  for (const id of callees) {
    const layout = cached.get(id);
    if (layout) known[id] = { width: layout.width, height: layout.height };
  }
  return {
    request: { scopes: missing.map(({ scope, nodes, edges }) => ({ id: scope.id, nodes, edges })), known },
  };
}

/** The whole picture, or undefined while a scope has no positions: the canvas keeps its previous one until then. */
export function assembleLayout(
  model: GraphModel,
  plan: LayoutPlan,
  metrics: Metrics,
): GraphLayout | undefined {
  const scopes: Record<NodeId, ScopeLayout> = {};
  for (const p of plan.placed) {
    if (!p.layout) return undefined;
    scopes[p.scope.id] = p.layout;
  }
  const cards: Record<NodeId, Size> = {};
  for (const p of plan.placed)
    for (const job of jobsOf(model, p.scope)) cards[job.id] = card(model, job, scopes, metrics);
  return { scopes, roots: rootStack(model, scopes), cards };
}

function card(
  model: GraphModel,
  job: JobModel,
  scopes: Readonly<Record<NodeId, ScopeLayout>>,
  metrics: Metrics,
): Size {
  const callee = job.callee === undefined ? undefined : model.scopes[job.callee];
  if (!callee) return cardSize(job, metrics);
  return cardSize(job, metrics, callee.collapsed ? CARD.collapsed : scopes[callee.id]);
}

/** Depth-0 workflows top to bottom in plan order; an untriggered one is a collapsed card in its slot. */
function rootStack(model: GraphModel, scopes: Readonly<Record<NodeId, ScopeLayout>>): GraphLayout['roots'] {
  const roots: GraphLayout['roots'] = {};
  let y = 0;
  for (const id of model.roots) {
    const scope = model.scopes[id];
    const size = scope?.collapsed ? CARD.collapsed : scopes[id];
    if (!size) continue;
    roots[id] = { x: 0, y, width: size.width, height: size.height };
    y += size.height + CARD.rootGap;
  }
  return roots;
}
