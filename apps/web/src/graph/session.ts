import type { SessionState, SessionStore } from '../state/store';
import type { LayoutClient } from '../worker/layout-client';
import { assembleLayout, createLayoutCache, type LayoutPlan } from './layout';
import { graphModel } from './model';
import type { GraphLayout, GraphModel, GraphUi, Metrics } from './types';

/**
 * The store's bridge to the layout worker. When the plan or the card state changes, and only then, it builds the
 * model, asks the worker for the scopes the cache has no positions for, and commits the model with its positions in
 * one `graphReady`, so the canvas keeps its previous picture until the new one is placed. The latest change wins: an
 * answer for an older one is kept in the cache and never committed. A recolour finds every scope cached and commits
 * without asking. A failure keeps the previous picture and says so once, until a picture is placed again.
 */

export interface GraphSessionOptions {
  store: SessionStore;
  layout: Pick<LayoutClient, 'layout'>;
  /** A promise in the browser: text is measured once the card faces have loaded. */
  metrics: Metrics | Promise<Metrics>;
  /** The model builder: graph/model.ts unless a test hands in its own. */
  model?: typeof graphModel;
}

export interface GraphSession {
  dispose(): void;
}

type Placed = { layout: GraphLayout; ms?: number } | { error: string } | undefined;

export function createGraphSession({
  store,
  layout,
  metrics,
  model = graphModel,
}: GraphSessionOptions): GraphSession {
  const cache = createLayoutCache();
  const measured = Promise.resolve(metrics);
  let generation = 0;
  let failing = false;

  const fail = (message: string): void => {
    if (failing) return;
    failing = true;
    const kept = store.getState().graph ? '; the canvas keeps the previous plan' : '';
    store.getState().notify(`the graph could not be laid out: ${message}${kept}`);
  };

  /** The positions for a model, from the cache or the worker; undefined when a newer change took over. */
  const place = async (graph: GraphModel, m: Metrics, run: number): Promise<Placed> => {
    let plan: LayoutPlan = cache.plan(graph, m);
    let ms: number | undefined;
    if (plan.request) {
      const r = await layout.layout(plan.request);
      if (r.type === 'superseded') return undefined;
      if (r.type === 'error') return run === generation ? { error: r.message } : undefined;
      plan = cache.keep(plan, r.scopes);
      ms = r.ms;
    }
    if (run !== generation) return undefined;
    const placed = assembleLayout(graph, plan, m);
    if (!placed) return { error: 'the layout worker left a workflow out' };
    return ms === undefined ? { layout: placed } : { layout: placed, ms };
  };

  const build = async (): Promise<void> => {
    const run = ++generation;
    try {
      const m = await measured;
      const s = store.getState();
      if (run !== generation || !s.plan) return;
      const graph = model(s.plan.plan, s.plan.derived, graphUi(s.ui));
      const placed = await place(graph, m, run);
      if (!placed) return;
      if ('error' in placed) return fail(placed.error);
      failing = false;
      store.getState().graphReady({ model: graph, ...placed, for: s.plan.for });
    } catch (e) {
      if (run === generation) fail(e instanceof Error ? e.message : String(e));
    }
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.plan !== prev.plan || uiChanged(s.ui, prev.ui)) void build();
  });
  if (store.getState().plan) void build();

  return {
    dispose: () => {
      unsubscribe();
      generation++;
    },
  };
}

const graphUi = (ui: SessionState['ui']): GraphUi => ({
  expanded: ui.expanded,
  representative: ui.representative,
  opened: ui.opened,
  hideUntriggered: ui.hideUntriggered,
});

/** The card state the picture depends on; the view, the prefs and the selection do not move a card. */
const uiChanged = (ui: SessionState['ui'], prev: SessionState['ui']): boolean =>
  ui.expanded !== prev.expanded ||
  ui.representative !== prev.representative ||
  ui.opened !== prev.opened ||
  ui.hideUntriggered !== prev.hideUntriggered;
