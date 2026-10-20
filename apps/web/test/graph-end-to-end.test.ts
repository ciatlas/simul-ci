import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { NodeId, ScenarioInput } from '@simulci/engine';
import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { toFlow } from '../src/graph/flow';
import { tableMetrics } from '../src/graph/metrics';
import { createGraphSession } from '../src/graph/session';
import { calleeOffset } from '../src/graph/size';
import type { GraphLayout, GraphState, Point, ScopeModel, Size } from '../src/graph/types';
import { sampleByName } from '../src/input/samples';
import { createSessionStore, type SessionStore } from '../src/state/store';
import type { WorkerLike } from '../src/worker/client';
import { handle, initialState, type WorkerState } from '../src/worker/handle';
import { createLayoutClient } from '../src/worker/layout-client';
import { answerLayout, type LayoutRequest } from '../src/worker/layout-protocol';

/**
 * The graph from files to the canvas, with nothing faked: the engine worker's own `handle` simulates, the store
 * takes the plan, the graph session builds the real model and sizes it with the width table, and the layout client
 * talks to a worker that runs the layout worker's code over the real ELK.
 */

const labRepo = join(import.meta.dirname, '../../../fixtures/routes-lab/repo');
const lab: Record<string, string> = {};
for (const entry of readdirSync(labRepo, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  lab[relative(labRepo, path)] = readFileSync(path, 'utf8');
}

/** A worker in this thread: each request goes through `answerLayout` and ELK, the answer comes back as a message. */
class ElkWorker implements WorkerLike {
  sent: LayoutRequest[] = [];
  private readonly elk = new ELK();
  private readonly listeners: ((event: { data: unknown }) => void)[] = [];
  postMessage(message: unknown): void {
    const request = message as LayoutRequest;
    this.sent.push(request);
    void answerLayout(this.elk, request).then((data) => {
      for (const l of this.listeners) l({ data });
    });
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.push(listener);
  }
  terminate(): void {}
}

/** A page over one repository: the engine's state, the store and the graph session, as boot.ts wires them. */
function page(files: Record<string, string>) {
  let engine: WorkerState = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' }).state;
  let id = 1;
  const store = createSessionStore();
  store.getState().setFiles(files, { kind: 'sample', name: 'test' });
  const worker = new ElkWorker();
  const layout = createLayoutClient({ spawn: () => worker });
  const session = createGraphSession({ store, layout, metrics: tableMetrics });
  const simulate = (scenario: ScenarioInput): void => {
    const step = handle(engine, {
      id: ++id,
      type: 'simulate',
      project: 1,
      scenario,
      assume: [],
      detail: 'steps',
    });
    engine = step.state;
    const r = step.response;
    if (r.type !== 'plan') throw new Error(JSON.stringify(r));
    const { plan, derived, text, ms } = r;
    store
      .getState()
      .planReceived({ plan, derived, text, ms, for: { files: 1, epoch: 1, project: r.project } });
  };
  return { store, worker, session, simulate };
}

/** The next picture the session commits after `previous`. */
function committed(store: SessionStore, previous?: GraphState): Promise<GraphState> {
  return new Promise((resolve) => {
    const now = store.getState().graph;
    if (now && now !== previous) return resolve(now);
    const stop = store.subscribe((s) => {
      if (s.graph && s.graph !== previous) {
        stop();
        resolve(s.graph);
      }
    });
  });
}

const inside = (at: Point, size: Size, box: Size): boolean =>
  at.x >= 0 && at.y >= 0 && at.x + size.width <= box.width && at.y + size.height <= box.height;

const overlap = (a: Point & Size, b: Point & Size): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Everything the canvas needs is there, and nothing sits on anything else. */
function expectPlaced({ model, layout }: GraphState): void {
  for (const id of model.roots) expect(layout.roots[id], id).toBeDefined();
  for (const scope of Object.values(model.scopes))
    if (scope.collapsed) expect(scope.jobs, scope.id).toEqual([]);
    else expectScopePlaced(scope, layout);
  for (const job of Object.values(model.jobs)) {
    const callee = job.callee === undefined ? undefined : model.scopes[job.callee];
    if (!callee || callee.collapsed) continue;
    expect(inside(calleeOffset(job), layout.scopes[callee.id]!, layout.cards[job.id]!), job.id).toBe(true);
  }
}

/** Each job of an open scope has a position and a card, inside the scope and clear of the others. */
function expectScopePlaced(scope: ScopeModel, layout: GraphLayout): void {
  const laid = layout.scopes[scope.id];
  expect(laid, scope.id).toBeDefined();
  const boxes = scope.jobs.map((job) => {
    const box = { ...laid!.positions[job]!, ...layout.cards[job]! };
    expect(box, job).toMatchObject({ x: expect.any(Number), width: expect.any(Number) });
    expect(inside(box, box, laid!), job).toBe(true);
    return box;
  });
  for (const [i, box] of boxes.entries())
    for (const other of boxes.slice(i + 1)) expect(overlap(box, other), scope.jobs[i]).toBe(false);
}

/** Every workflow instance and job card is a canvas node, each after its parent. */
function expectDrawn(graph: GraphState, selected?: NodeId): void {
  const { nodes } = toFlow(graph.model, graph.layout, { selected });
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  expect(new Set(at.keys())).toEqual(
    new Set([...Object.keys(graph.model.scopes), ...Object.keys(graph.model.jobs)]),
  );
  for (const n of nodes) if (n.parentId !== undefined) expect(at.get(n.parentId)).toBeLessThan(at.get(n.id)!);
}

const pr: ScenarioInput = { event: 'pull_request', base: 'main', head: 'topic', number: 1 };

describe('the graph from a sample to the canvas', () => {
  it('commits a picture of the starter push whose every job has a position and a card', async () => {
    const p = page(sampleByName('starter')!.files);
    p.simulate({ event: 'push', branch: 'main' });
    const graph = await committed(p.store);
    expect(graph.for).toBe(p.store.getState().plan!.for);
    expect(Object.keys(graph.model.jobs).length).toBeGreaterThan(0);
    expectPlaced(graph);
    expectDrawn(graph, `${graph.model.roots[0]}#deploy`);
    expect(p.worker.sent).toHaveLength(1);
    expect(graph.ms).toBeGreaterThan(0);
    p.session.dispose();
  });

  it('recolours a new scenario of the same shape without asking the worker again', async () => {
    const p = page(sampleByName('starter')!.files);
    p.simulate({ event: 'push', branch: 'main' });
    const first = await committed(p.store);
    p.simulate({ event: 'push', branch: 'main', changed: ['src/a.ts'] });
    const second = await committed(p.store, first);
    const build = `${first.model.roots[0]}#build`;
    expect([first.model.jobs[build]!.verdict, second.model.jobs[build]!.verdict]).toEqual(['maybe', 'yes']);
    expect(p.worker.sent).toHaveLength(1);
    expect(second.layout.scopes).toEqual(first.layout.scopes);
    expect(second.ms).toBeUndefined();
    p.session.dispose();
  });

  it('keeps every card in place when a scenario turns a job skipped and another one might run', async () => {
    const p = page(sampleByName('starter')!.files);
    p.simulate({ event: 'push', branch: 'main', changed: ['src/a.ts'] });
    const first = await committed(p.store);
    p.simulate({ ...pr, changed: ['src/a.ts'] });
    const second = await committed(p.store, first);
    const ci = first.model.roots[0]!;
    const verdicts = (g: GraphState) => ['deploy', 'preview'].map((j) => g.model.jobs[`${ci}#${j}`]!.verdict);
    expect([verdicts(first), verdicts(second)]).toEqual([
      ['yes', 'no'],
      ['no', 'maybe'],
    ]);
    expect(p.worker.sent).toHaveLength(1);
    expect(second.layout).toEqual(first.layout);
    p.session.dispose();
  });

  it('lays out again only the workflow whose card opens its step list', async () => {
    const p = page(sampleByName('starter')!.files);
    p.simulate({ event: 'push', branch: 'main' });
    const first = await committed(p.store);
    const job = Object.values(first.model.jobs).find((j) => j.steps.length > 1)!;
    p.store.getState().toggleExpanded(job.id);
    const second = await committed(p.store, first);
    expect(p.worker.sent.map((r) => r.scopes.map((s) => s.id))).toEqual([
      expect.arrayContaining([job.scope]),
      [job.scope],
    ]);
    expect(second.layout.cards[job.id]!.height).toBeGreaterThan(first.layout.cards[job.id]!.height);
    expectPlaced(second);
    p.session.dispose();
  });

  it('places every workflow of the monorepo sample and the routes lab, callees inside their call cards', async () => {
    const cases: [Record<string, string>, ScenarioInput][] = [
      [sampleByName('monorepo')!.files, { ...pr, changed: ['apps/web/a.ts'] }],
      [lab, { event: 'push', branch: 'main' }],
      [lab, { ...pr, action: 'labeled' }],
    ];
    for (const [files, scenario] of cases) {
      const p = page(files);
      p.simulate(scenario);
      const graph = await committed(p.store);
      expectPlaced(graph);
      expectDrawn(graph);
      p.session.dispose();
    }
  });
});
