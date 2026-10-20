import type { RunPlan, Tri } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { tableMetrics } from '../src/graph/metrics';
import { createGraphSession } from '../src/graph/session';
import type { GraphModel, GraphUi, Metrics, ScopeLayout } from '../src/graph/types';
import { createSessionStore, type SessionStore } from '../src/state/store';
import type { LayoutClient, LayoutResult } from '../src/worker/layout-client';
import type { LayoutRequest } from '../src/worker/layout-protocol';

/** A plan as small as the fake model needs: one workflow's jobs and their verdicts. */
type FakePlan = { jobs: [string, Tri][] };

/** The model of a fake plan: one scope, a card per job with one step, open when the author opened it. */
function fakeModel(plan: RunPlan, _derived: unknown, ui: GraphUi): GraphModel {
  const { jobs } = plan as unknown as FakePlan;
  const ids = jobs.map(([id]) => `ci.yml#${id}`);
  const model: GraphModel = {
    roots: ['ci.yml'],
    scopes: {
      'ci.yml': {
        id: 'ci.yml',
        path: 'ci.yml',
        verdict: 'yes',
        clause: '',
        counts: { yes: 0, no: 0, maybe: 0 },
        depth: 0,
        collapsed: false,
        jobs: ids,
        edges: [],
        shape: [...ids, ...ui.expanded].join(','),
      },
    },
    jobs: {},
  };
  for (const [jobId, verdict] of jobs) {
    const id = `ci.yml#${jobId}`;
    const step = { id: `${id}.s`, label: 's', verdict, inner: [] };
    const expanded = ui.expanded.includes(id);
    model.jobs[id] = {
      id,
      scope: 'ci.yml',
      jobId,
      label: jobId,
      verdict,
      needs: [],
      steps: [step],
      expanded,
    };
  }
  return model;
}

/** A layout client the test answers: each request's scopes get their cards in one column. */
function fakeLayout() {
  const requests: { body: Omit<LayoutRequest, 'id' | 'type'>; resolve: (r: LayoutResult) => void }[] = [];
  const client: Pick<LayoutClient, 'layout'> = {
    layout: (body) => new Promise((resolve) => requests.push({ body, resolve })),
  };
  const answer = (index: number, ms = 5): void => {
    const { body, resolve } = requests[index]!;
    const scopes: Record<string, ScopeLayout> = {};
    for (const scope of body.scopes) {
      const positions = Object.fromEntries(scope.nodes.map((n, i) => [n.id, { x: 16, y: 40 + 100 * i }]));
      scopes[scope.id] = { width: 400, height: 40 + 100 * scope.nodes.length, positions };
    }
    resolve({ id: index + 1, type: 'layout', scopes, ms });
  };
  const fail = (index: number, message: string): void =>
    requests[index]!.resolve({ id: index + 1, type: 'error', message });
  return { client, requests, answer, fail };
}

let files = 0;
const receive = (store: SessionStore, jobs: FakePlan['jobs']): void =>
  store.getState().planReceived({
    plan: { jobs } as unknown as RunPlan,
    derived: {} as never,
    text: '',
    ms: { simulate: 1, derive: 0 },
    for: { files: ++files, epoch: 1, project: 1 },
  });

/** Lets the session's promises run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(metrics: Metrics | Promise<Metrics> = tableMetrics) {
  const store = createSessionStore();
  const layout = fakeLayout();
  const session = createGraphSession({ store, layout: layout.client, metrics, model: fakeModel });
  return { store, layout, session };
}

describe('the graph session', () => {
  it('commits the model with its positions only once the worker has placed them', async () => {
    const { store, layout } = setup();
    receive(store, [['build', 'yes']]);
    await tick();
    expect(layout.requests).toHaveLength(1);
    expect(store.getState().graph).toBeUndefined();
    layout.answer(0, 12);
    await tick();
    const graph = store.getState().graph!;
    expect(graph.model.jobs['ci.yml#build']!.verdict).toBe('yes');
    expect(graph.layout.scopes['ci.yml']!.positions['ci.yml#build']).toEqual({ x: 16, y: 40 });
    expect(graph.layout.roots['ci.yml']).toEqual({ x: 0, y: 0, width: 400, height: 140 });
    expect(graph.for).toBe(store.getState().plan!.for);
    expect(graph.ms).toBe(12);
  });

  it('keeps the previous picture until the new shape is placed', async () => {
    const { store, layout } = setup();
    receive(store, [['build', 'yes']]);
    await tick();
    layout.answer(0);
    await tick();
    const before = store.getState().graph;
    receive(store, [
      ['build', 'yes'],
      ['test', 'yes'],
    ]);
    await tick();
    expect(layout.requests).toHaveLength(2);
    expect(store.getState().graph).toBe(before);
    layout.answer(1);
    await tick();
    expect(Object.keys(store.getState().graph!.model.jobs)).toEqual(['ci.yml#build', 'ci.yml#test']);
  });

  it('commits a recolour at once, without asking the worker', async () => {
    const { store, layout } = setup();
    receive(store, [['build', 'yes']]);
    await tick();
    layout.answer(0);
    await tick();
    const before = store.getState().graph!;
    receive(store, [['build', 'no']]);
    await tick();
    expect(layout.requests).toHaveLength(1);
    const after = store.getState().graph!;
    expect(after.model.jobs['ci.yml#build']!.verdict).toBe('no');
    expect(after.layout).toEqual(before.layout);
    expect(after.ms).toBeUndefined();
  });

  it('lets the latest change win, whatever order the answers come in', async () => {
    const { store, layout } = setup();
    receive(store, [['a', 'yes']]);
    await tick();
    receive(store, [['b', 'yes']]);
    await tick();
    layout.answer(1);
    await tick();
    expect(Object.keys(store.getState().graph!.model.jobs)).toEqual(['ci.yml#b']);
    layout.answer(0);
    await tick();
    expect(Object.keys(store.getState().graph!.model.jobs)).toEqual(['ci.yml#b']);
    // The late answer was still worth keeping: going back to that shape asks nothing.
    receive(store, [['a', 'no']]);
    await tick();
    expect(layout.requests).toHaveLength(2);
    expect(Object.keys(store.getState().graph!.model.jobs)).toEqual(['ci.yml#a']);
  });

  it('builds again for the card state and nothing else besides the plan', async () => {
    const { store, layout } = setup();
    receive(store, [['build', 'yes']]);
    await tick();
    layout.answer(0);
    await tick();
    const graph = store.getState().graph;
    const s = store.getState();
    s.select('ci.yml', 'build');
    s.setView('text');
    s.setPrefs({ theme: 'dark' });
    s.notify('hello');
    await tick();
    expect(layout.requests).toHaveLength(1);
    expect(store.getState().graph).toBe(graph);
    store.getState().toggleExpanded('ci.yml#build');
    await tick();
    expect(layout.requests).toHaveLength(2);
    layout.answer(1);
    await tick();
    const expanded = store.getState().graph;
    expect(expanded!.model.jobs['ci.yml#build']!.expanded).toBe(true);
    store.getState().setHideUntriggered(true);
    await tick();
    expect(layout.requests).toHaveLength(2);
    expect(store.getState().graph).not.toBe(expanded);
  });

  it('keeps the previous picture when the layout fails, and says so once until one is placed', async () => {
    const { store, layout } = setup();
    receive(store, [['build', 'yes']]);
    await tick();
    layout.answer(0);
    await tick();
    const graph = store.getState().graph;
    receive(store, [['x', 'yes']]);
    await tick();
    layout.fail(1, 'Referenced shape does not exist');
    await tick();
    receive(store, [['y', 'yes']]);
    await tick();
    layout.fail(2, 'Referenced shape does not exist');
    await tick();
    expect(store.getState().graph).toBe(graph);
    expect(store.getState().notices.map((n) => n.text)).toEqual([
      'the graph could not be laid out: Referenced shape does not exist; the canvas keeps the previous plan',
    ]);
    receive(store, [['z', 'yes']]);
    await tick();
    layout.answer(3);
    await tick();
    receive(store, [['w', 'yes']]);
    await tick();
    layout.fail(4, 'again');
    await tick();
    expect(store.getState().notices).toHaveLength(2);
  });

  it('reports a model that cannot be built the same way, and drops an answer for a plan that is gone', async () => {
    const store = createSessionStore();
    const layout = fakeLayout();
    const broken = (): GraphModel => {
      throw new Error('not built yet');
    };
    createGraphSession({ store, layout: layout.client, metrics: tableMetrics, model: broken });
    receive(store, [['build', 'yes']]);
    await tick();
    expect(store.getState().notices.map((n) => n.text)).toEqual([
      'the graph could not be laid out: not built yet',
    ]);

    const other = setup();
    receive(other.store, [['build', 'yes']]);
    await tick();
    other.store.getState().setFiles({}, { kind: 'none' });
    await tick();
    other.layout.answer(0);
    await tick();
    expect(other.store.getState().graph).toBeUndefined();
  });

  it('measures nothing until the metrics are ready, and nothing at all once disposed', async () => {
    let ready!: (m: Metrics) => void;
    const { store, layout, session } = setup(new Promise<Metrics>((resolve) => (ready = resolve)));
    receive(store, [['build', 'yes']]);
    await tick();
    expect(layout.requests).toHaveLength(0);
    ready(tableMetrics);
    await tick();
    expect(layout.requests).toHaveLength(1);
    session.dispose();
    layout.answer(0);
    await tick();
    expect(store.getState().graph).toBeUndefined();
    receive(store, [['test', 'yes']]);
    await tick();
    expect(layout.requests).toHaveLength(1);
  });

  it('builds the plan the store already holds when it starts', async () => {
    const store = createSessionStore();
    receive(store, [['build', 'yes']]);
    const layout = fakeLayout();
    createGraphSession({ store, layout: layout.client, metrics: tableMetrics, model: fakeModel });
    await tick();
    expect(layout.requests).toHaveLength(1);
  });
});
