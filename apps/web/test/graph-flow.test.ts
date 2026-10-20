import { describe, expect, it } from 'vitest';
import {
  cardActions,
  cardAttrs,
  cellAt,
  cellChars,
  clip,
  countParts,
  countsText,
  deepCallee,
  edgeAttrs,
  histogram,
  jobLabel,
  legTitle,
  listRows,
  needsLabel,
  resultTone,
  scopeLabel,
  selectedNode,
  stripLayout,
  subline,
} from '../src/graph/card';
import {
  canvasKey,
  cardFocus,
  edgeIdOf,
  editKey,
  type FlowNode,
  keepUnchanged,
  keyAction,
  type NavEffects,
  nodeIdOf,
  outsideView,
  runNav,
  toFlow,
} from '../src/graph/flow';
import {
  CARD,
  type EdgeModel,
  type GraphLayout,
  type GraphModel,
  type GridGeometry,
  type JobModel,
  type ScopeModel,
  type StepMark,
} from '../src/graph/types';
import { createSessionStore, initialSessionState, type PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const CI = 'ci.yml';
const RELEASE = 'release.yml';
const SUB = 'ci.yml#build>build.yml';
const j = (name: string, wf = CI): string => `${wf}#${name}`;

function job(id: string, over: Partial<JobModel> = {}): JobModel {
  const [wf, jobId] = id.split('#') as [string, string];
  return {
    id,
    scope: wf,
    jobId,
    label: jobId,
    verdict: 'yes',
    needs: [],
    steps: [],
    expanded: false,
    ...over,
  };
}

function scope(id: string, over: Partial<ScopeModel> = {}): ScopeModel {
  return {
    id,
    path: id,
    verdict: 'yes',
    clause: 'on: push',
    counts: { yes: 0, no: 0, maybe: 0 },
    depth: 0,
    collapsed: false,
    jobs: [],
    edges: [],
    shape: '',
    ...over,
  };
}

const edge = (source: string, target: string, over: Partial<EdgeModel> = {}): EdgeModel => ({
  id: `${source}->${target}`,
  source,
  target,
  from: 'yes',
  deciding: false,
  ...over,
});

/**
 * ci.yml: build (calls build.yml) → test → deploy, and lint → docs; build.yml: compile → pack; release.yml is not
 * triggered and stays one line.
 */
function picture(): { model: GraphModel; layout: GraphLayout } {
  const jobs = [
    job(j('build'), { callee: SUB, uses: './build.yml' }),
    job(j('lint')),
    job(j('test'), { needs: [j('build')] }),
    job(j('deploy'), {
      needs: [j('test')],
      verdict: 'no',
      clause: "if: github.ref == 'refs/heads/main' → false",
    }),
    job(j('docs'), { needs: [j('lint')] }),
    job(j('compile', SUB), { scope: SUB }),
    job(j('pack', SUB), { scope: SUB, needs: [j('compile', SUB)] }),
    job(j('publish', RELEASE), { scope: RELEASE }),
  ];
  const model: GraphModel = {
    roots: [CI, RELEASE],
    scopes: {
      [CI]: scope(CI, {
        jobs: [j('build'), j('lint'), j('test'), j('deploy'), j('docs')],
        edges: [
          edge(j('build'), j('test')),
          edge(j('test'), j('deploy'), { deciding: true, label: 'result: failure' }),
          edge(j('lint'), j('docs')),
        ],
      }),
      [SUB]: scope(SUB, {
        path: 'build.yml',
        depth: 1,
        caller: j('build'),
        jobs: [j('compile', SUB), j('pack', SUB)],
        edges: [edge(j('compile', SUB), j('pack', SUB))],
      }),
      [RELEASE]: scope(RELEASE, {
        verdict: 'no',
        clause: 'no on: push',
        collapsed: true,
        jobs: [j('publish', RELEASE)],
      }),
    },
    jobs: Object.fromEntries(jobs.map((x) => [x.id, x])),
  };
  const layout: GraphLayout = {
    roots: {
      [CI]: { x: 0, y: 0, width: 900, height: 400 },
      [RELEASE]: { x: 0, y: 424, width: 320, height: 44 },
    },
    scopes: {
      [CI]: {
        width: 900,
        height: 400,
        positions: {
          [j('build')]: { x: 16, y: 40 },
          [j('lint')]: { x: 16, y: 260 },
          [j('test')]: { x: 380, y: 40 },
          [j('deploy')]: { x: 600, y: 40 },
          [j('docs')]: { x: 380, y: 260 },
        },
      },
      [SUB]: {
        width: 320,
        height: 120,
        positions: { [j('compile', SUB)]: { x: 16, y: 40 }, [j('pack', SUB)]: { x: 180, y: 40 } },
      },
    },
    cards: {
      [j('build')]: { width: 344, height: 200 },
      [j('lint')]: { width: 168, height: 64 },
      [j('test')]: { width: 168, height: 64 },
      [j('deploy')]: { width: 200, height: 64 },
      [j('docs')]: { width: 168, height: 64 },
      [j('compile', SUB)]: { width: 140, height: 64 },
      [j('pack', SUB)]: { width: 120, height: 64 },
    },
  };
  return { model, layout };
}

/** React Flow's element for a node, as far as the canvas glue reads it. */
const cardElement = (id: string) => ({
  classList: { contains: (name: string) => name === 'react-flow__node' },
  getAttribute: (name: string) => (name === 'data-id' ? id : null),
});

const byId = (nodes: FlowNode[], id: string): FlowNode => {
  const n = nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

describe('toFlow', () => {
  it('puts every parent before its children', () => {
    const { model, layout } = picture();
    const { nodes } = toFlow(model, layout, {});
    const at = new Map(nodes.map((n, i) => [n.id, i]));
    const children = nodes.filter((n) => n.parentId !== undefined);
    expect(children.length).toBe(8);
    for (const n of children) expect(at.get(n.parentId!)).toBeLessThan(at.get(n.id)!);
  });

  it('places a root in the stack, a job relative to its workflow and a callee inside its caller card', () => {
    const { model, layout } = picture();
    const { nodes } = toFlow(model, layout, {});
    expect(byId(nodes, RELEASE)).toMatchObject({
      type: 'workflow',
      position: { x: 0, y: 424 },
      width: 320,
      height: 44,
    });
    expect(byId(nodes, j('test'))).toMatchObject({
      type: 'job',
      parentId: CI,
      position: { x: 380, y: 40 },
      width: 168,
      height: 64,
    });
    // Below the build card's header and subline, inset by the call padding.
    expect(byId(nodes, SUB)).toMatchObject({
      parentId: j('build'),
      position: { x: 12, y: 50 },
      width: 320,
      height: 120,
    });
    expect(byId(nodes, j('pack', SUB))).toMatchObject({ parentId: SUB, position: { x: 180, y: 40 } });
    expect(nodes.every((n) => n.draggable === false)).toBe(true);
  });

  it('gives a collapsed workflow no job nodes and no edges', () => {
    const { model, layout } = picture();
    const { nodes, edges } = toFlow(model, layout, {});
    expect(nodes.some((n) => n.id === j('publish', RELEASE))).toBe(false);
    expect(nodes.filter((n) => n.parentId === RELEASE)).toEqual([]);
    expect(edges.map((e) => e.id).sort()).toEqual(
      [
        `${j('build')}->${j('test')}`,
        `${j('test')}->${j('deploy')}`,
        `${j('lint')}->${j('docs')}`,
        `${j('compile', SUB)}->${j('pack', SUB)}`,
      ].sort(),
    );
  });

  it('draws a closed callee as one line of the collapsed size, with nothing inside', () => {
    const { model, layout } = picture();
    model.scopes[SUB] = { ...model.scopes[SUB]!, depth: 3, collapsed: true };
    delete layout.scopes[SUB];
    const { nodes } = toFlow(model, layout, {});
    expect(byId(nodes, SUB)).toMatchObject({ width: CARD.collapsed.width, height: CARD.collapsed.height });
    expect(nodes.some((n) => n.parentId === SUB)).toBe(false);
  });

  it('leaves out a job the layout has not placed, and the edges that meet it', () => {
    const { model, layout } = picture();
    delete layout.scopes[CI]!.positions[j('docs')];
    const { nodes, edges } = toFlow(model, layout, {});
    expect(nodes.some((n) => n.id === j('docs'))).toBe(false);
    expect(edges.some((e) => e.target === j('docs'))).toBe(false);
  });

  it("marks the selected job's needs and dependents on its path and fades the rest of its workflow", () => {
    const { model, layout } = picture();
    const { nodes, edges } = toFlow(model, layout, { selected: j('test') });
    const path = (id: string) => (byId(nodes, id).data as { state: { path?: string } }).state.path;
    expect([j('build'), j('test'), j('deploy')].map(path)).toEqual(['on', 'on', 'on']);
    expect([j('lint'), j('docs')].map(path)).toEqual(['off', 'off']);
    expect(path(j('compile', SUB))).toBeUndefined();
    expect(byId(nodes, j('test')).selected).toBe(true);
    const data = Object.fromEntries(edges.map((e) => [e.id, e.data!]));
    expect(data[`${j('build')}->${j('test')}`]).toMatchObject({ onPath: true, faded: false });
    expect(data[`${j('test')}->${j('deploy')}`]).toMatchObject({
      onPath: true,
      deciding: true,
      label: 'result: failure',
      from: 'yes',
    });
    expect(data[`${j('lint')}->${j('docs')}`]).toMatchObject({ onPath: false, faded: true });
    expect(data[`${j('compile', SUB)}->${j('pack', SUB)}`]).toMatchObject({ onPath: false, faded: false });
  });

  it('fades the workflow a faded call job calls, its jobs and its edges', () => {
    const { model, layout } = picture();
    const { nodes, edges } = toFlow(model, layout, { selected: j('docs') });
    const path = (id: string) => (byId(nodes, id).data as { state: { path?: string } }).state.path;
    expect([j('build'), SUB, j('compile', SUB), j('pack', SUB)].map(path)).toEqual([
      'off',
      'off',
      'off',
      'off',
    ]);
    expect(edges.find((e) => e.source === j('compile', SUB))!.data).toMatchObject({
      faded: true,
      onPath: false,
    });
  });

  it('keeps an edge that skips the selected job off its path', () => {
    const { model, layout } = picture();
    const ci = model.scopes[CI]!;
    model.scopes[CI] = {
      ...ci,
      edges: [...ci.edges, edge(j('build'), j('deploy')), edge(j('lint'), j('test'))],
    };
    model.jobs[j('test')] = { ...model.jobs[j('test')]!, needs: [j('build'), j('lint')] };
    const { edges } = toFlow(model, layout, { selected: j('test') });
    const onPath = edges.filter((e) => e.data!.onPath).map((e) => e.id);
    expect(onPath.sort()).toEqual(
      [`${j('build')}->${j('test')}`, `${j('lint')}->${j('test')}`, `${j('test')}->${j('deploy')}`].sort(),
    );
  });

  it('shows no path while a workflow is selected, and outlines the workflow', () => {
    const { model, layout } = picture();
    const { nodes, edges } = toFlow(model, layout, { selected: CI });
    expect(byId(nodes, CI).selected).toBe(true);
    expect(nodes.every((n) => n.data.state.path === undefined)).toBe(true);
    expect(edges.every((e) => !e.data!.faded && !e.data!.onPath)).toBe(true);
  });

  it('gives the selection of a leg or a step to the card that holds it', () => {
    const { model, layout } = picture();
    const leg = `${j('test')}[node=22]`;
    const { nodes } = toFlow(model, layout, { selected: leg });
    expect(byId(nodes, j('test')).data.state).toMatchObject({ selected: true, inner: leg });
    const step = `${j('compile', SUB)}/steps.make`;
    const deep = toFlow(model, layout, { selected: step }).nodes;
    expect(byId(deep, j('compile', SUB)).data.state).toMatchObject({ selected: true, inner: step });
    expect(byId(deep, j('build')).selected).toBe(false);
  });

  it('outlines the workflow of a job its collapsed workflow does not draw', () => {
    const { model, layout } = picture();
    delete model.jobs[j('publish', RELEASE)];
    const { nodes } = toFlow(model, layout, { selected: j('publish', RELEASE) });
    expect(byId(nodes, RELEASE).selected).toBe(true);
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([RELEASE]);
  });

  it('marks only the hovered node as hovered', () => {
    const { model, layout } = picture();
    const { nodes } = toFlow(model, layout, { hovered: j('lint') });
    expect(nodes.filter((n) => n.data.state.hovered).map((n) => n.id)).toEqual([j('lint')]);
  });

  it("names each card for a screen reader and lists a job's needs by label", () => {
    const { model, layout } = picture();
    model.jobs[j('build')] = { ...model.jobs[j('build')]!, label: 'Build it' };
    const { nodes } = toFlow(model, layout, {});
    expect(byId(nodes, j('deploy')).ariaLabel).toBe(
      "skipped deploy — if: github.ref == 'refs/heads/main' → false, needs test",
    );
    expect(byId(nodes, j('test')).ariaLabel).toBe('runs test, needs Build it');
    expect(byId(nodes, SUB).ariaLabel).toBe('runs build.yml — on: push, called by Build it');
    expect((byId(nodes, j('test')).data as { needs: string[] }).needs).toEqual(['Build it']);
  });

  it('names each needs edge by who needs whom, the needed verdict and the result that decided', () => {
    const { model, layout } = picture();
    model.scopes[CI]!.edges.find((e) => e.source === j('test'))!.from = 'maybe';
    const names = Object.fromEntries(toFlow(model, layout, {}).edges.map((e) => [e.id, e.ariaLabel]));
    expect(names[`${j('build')}->${j('test')}`]).toBe('test needs build (runs)');
    expect(names[`${j('test')}->${j('deploy')}`]).toBe(
      'deploy needs test (might run); result: failure decided deploy',
    );
  });

  it('gives every node the size it is drawn at, and a job the handles JobNode draws', () => {
    const { model, layout } = picture();
    const { nodes } = toFlow(model, layout, {});
    for (const n of nodes) expect(n.measured).toEqual({ width: n.width, height: n.height });
    expect(byId(nodes, j('test')).handles).toEqual([
      { type: 'target', position: 'left', x: -2.5, y: CARD.header / 2 - 2.5, width: 5, height: 5 },
      { type: 'source', position: 'right', x: 168 - 2.5, y: CARD.header / 2 - 2.5, width: 5, height: 5 },
    ]);
    expect(byId(nodes, CI).handles).toBeUndefined();
  });

  it('makes the card that holds the selection the one tab stop, else the first workflow', () => {
    const { model, layout } = picture();
    const stops = (selected?: string) =>
      toFlow(model, layout, { selected })
        .nodes.filter((n) => n.domAttributes?.tabIndex === 0)
        .map((n) => n.id);
    expect(stops()).toEqual([CI]);
    expect(stops(j('test'))).toEqual([j('test')]);
    expect(stops(`${j('compile', SUB)}/steps.make`)).toEqual([j('compile', SUB)]);
    expect(stops('gone.yml')).toEqual([CI]);
    expect(toFlow(model, layout, {}).nodes.every((n) => n.domAttributes?.tabIndex !== undefined)).toBe(true);
  });

  it('keeps every node and edge a hover leaves alone as the object it was, and the lists when nothing changed', () => {
    const { model, layout } = picture();
    const before = toFlow(model, layout, {});
    const after = keepUnchanged(before, toFlow(model, layout, { hovered: j('lint') }));
    const changed = after.nodes.filter((n, i) => n !== before.nodes[i]).map((n) => n.id);
    expect(changed).toEqual([j('lint')]);
    expect(after.edges).toBe(before.edges);
    const again = keepUnchanged(after, toFlow(model, layout, { hovered: j('lint') }));
    expect(again.nodes).toBe(after.nodes);
    // A selection changes the path's cards and edges, and the tab stop.
    const picked = keepUnchanged(after, toFlow(model, layout, { selected: j('docs') }));
    expect(picked.nodes.find((n) => n.id === j('test'))).not.toBe(
      after.nodes.find((n) => n.id === j('test')),
    );
    expect(picked.edges.filter((e, i) => e !== after.edges[i]).length).toBeGreaterThan(0);
    expect(keepUnchanged(undefined, before)).toBe(before);
  });
});

describe('a hovered unknown and a pin on the canvas', () => {
  const pathOf = (nodes: FlowNode[], id: string) => byId(nodes, id).data.state.path;
  const edgeData = (edges: ReturnType<typeof toFlow>['edges']) =>
    Object.fromEntries(edges.map((e) => [e.id, e.data!]));

  it('lights the cards it names and fades every other, over the selected path, the selection keeping its outline', () => {
    const { model, layout } = picture();
    const lit = new Set([CI, j('lint'), j('docs')]);
    const { nodes, edges } = toFlow(model, layout, { selected: j('test'), lit });
    expect([CI, j('lint'), j('docs')].map((id) => pathOf(nodes, id))).toEqual(['on', 'on', 'on']);
    for (const id of [j('build'), j('test'), j('deploy'), SUB, j('compile', SUB), j('pack', SUB), RELEASE])
      expect(pathOf(nodes, id)).toBe('off');
    expect(byId(nodes, j('test')).selected).toBe(true);
    expect(byId(nodes, j('test')).data.state.selected).toBe(true);
    const data = edgeData(edges);
    expect(data[`${j('lint')}->${j('docs')}`]).toMatchObject({ onPath: false, faded: false });
    // The selected job's path waits for the hover to end.
    expect(data[`${j('build')}->${j('test')}`]).toMatchObject({ onPath: false, faded: true });
    expect(data[`${j('test')}->${j('deploy')}`]).toMatchObject({
      onPath: false,
      faded: true,
      deciding: true,
    });
  });

  it('keeps an edge inside a called workflow only between two lit cards', () => {
    const { model, layout } = picture();
    const both = toFlow(model, layout, {
      lit: new Set([CI, j('build'), SUB, j('compile', SUB), j('pack', SUB)]),
    });
    expect(edgeData(both.edges)[`${j('compile', SUB)}->${j('pack', SUB)}`]).toMatchObject({ faded: false });
    expect(edgeData(both.edges)[`${j('build')}->${j('test')}`]).toMatchObject({ faded: true });
    const one = toFlow(model, layout, { lit: new Set([CI, j('build'), SUB, j('pack', SUB)]) });
    expect(edgeData(one.edges)[`${j('compile', SUB)}->${j('pack', SUB)}`]).toMatchObject({ faded: true });
  });

  it('fades every card and edge for an unknown that lights none', () => {
    const { model, layout } = picture();
    const { nodes, edges } = toFlow(model, layout, { lit: new Set() });
    expect(nodes.every((n) => n.data.state.path === 'off')).toBe(true);
    expect(edges.every((e) => e.data!.faded && !e.data!.onPath)).toBe(true);
  });

  it('flashes the cards the last change changed and rings the ones it added, with its parity, and no other', () => {
    const { model, layout } = picture();
    const flash = {
      parity: 'b' as const,
      cards: new Set([j('deploy'), RELEASE]),
      ring: new Set([j('lint')]),
    };
    const { nodes } = toFlow(model, layout, { flash });
    const flashing = nodes.filter((n) => n.data.state.flash !== undefined);
    expect(flashing.map((n) => [n.id, n.data.state.flash])).toEqual([
      [j('deploy'), 'b'],
      [RELEASE, 'b'],
    ]);
    const ringed = nodes.filter((n) => n.data.state.added !== undefined);
    expect(ringed.map((n) => [n.id, n.data.state.added])).toEqual([[j('lint'), 'b']]);
  });

  it('keeps every card a flash or a hover leaves alone as the object it was', () => {
    const { model, layout } = picture();
    const before = toFlow(model, layout, {});
    const flash = { parity: 'a' as const, cards: new Set([j('deploy')]), ring: new Set<string>() };
    const flashed = keepUnchanged(before, toFlow(model, layout, { flash }));
    expect(flashed.nodes.filter((n, i) => n !== before.nodes[i]).map((n) => n.id)).toEqual([j('deploy')]);
    expect(flashed.edges).toBe(before.edges);
    // The same cards lit by a set built anew change nothing.
    const lit = keepUnchanged(flashed, toFlow(model, layout, { flash, lit: new Set([CI, j('lint')]) }));
    const again = keepUnchanged(lit, toFlow(model, layout, { flash, lit: new Set([CI, j('lint')]) }));
    expect(again.nodes).toBe(lit.nodes);
    expect(again.edges).toBe(lit.edges);
  });
});

describe('the workflow being edited', () => {
  const editing = { editing: CI };

  it('makes its jobs connectable and its edges focusable with ✕, and no other workflow’s', () => {
    const { model, layout } = picture();
    const { nodes, edges } = toFlow(model, layout, editing);
    const data = (id: string) => byId(nodes, id).data as { editable?: boolean };
    expect(data(j('build')).editable).toBe(true);
    expect(data(CI).editable).toBe(true);
    expect(data(j('compile', SUB)).editable).toBeUndefined();
    expect(data(RELEASE).editable).toBeUndefined();
    const own = edges.find((e) => e.id === `${j('build')}->${j('test')}`)!;
    expect(own).toMatchObject({ focusable: true, data: { removable: true, hot: false } });
    const callee = edges.find((e) => e.source === j('compile', SUB))!;
    expect(callee.focusable).toBe(false);
    expect(callee.data?.removable).toBeUndefined();
    // Outside edit mode nothing of it.
    const read = toFlow(model, layout, {});
    expect(read.edges.every((e) => e.focusable === false && e.data?.removable === undefined)).toBe(true);
    expect((byId(read.nodes, j('build')).data as { editable?: boolean }).editable).toBeUndefined();
  });

  it('shows ✕ on the hot edge alone', () => {
    const { model, layout } = picture();
    const hot = `${j('lint')}->${j('docs')}`;
    const { edges } = toFlow(model, layout, { ...editing, hotEdge: hot });
    expect(edges.filter((e) => e.data?.hot).map((e) => e.id)).toEqual([hot]);
  });

  it('draws a need written since the picture dashed between the two cards it places, until the picture has it', () => {
    const { model, layout } = picture();
    const pending = [
      { source: j('lint'), target: j('deploy'), files: 3 },
      // Drawn already, and one whose card the picture does not place.
      { source: j('build'), target: j('test'), files: 3 },
      { source: j('lint'), target: j('publish', RELEASE), files: 3 },
    ];
    const { edges } = toFlow(model, layout, { ...editing, pending });
    expect(edges.filter((e) => e.data?.pending).map((e) => e.id)).toEqual([
      `pending:${j('lint')}->${j('deploy')}`,
    ]);
    expect(toFlow(model, layout, { pending }).edges.some((e) => e.data?.pending)).toBe(false);
  });

  it('reads Delete as removing the focused edge’s need, else the selection, and nothing typed or held', () => {
    const { model } = picture();
    const key = (k: string, target: unknown, mods: Partial<{ altKey: boolean; shiftKey: boolean }> = {}) =>
      editKey({ key: k, altKey: false, ctrlKey: false, metaKey: false, target, ...mods }, model);
    const edgeEl = {
      classList: { contains: (name: string) => name === 'react-flow__edge' },
      getAttribute: (name: string) => (name === 'data-id' ? `${j('test')}->${j('deploy')}` : null),
    };
    expect(edgeIdOf(edgeEl)).toBe(`${j('test')}->${j('deploy')}`);
    expect(edgeIdOf(cardElement(j('test')))).toBeUndefined();
    expect(key('Delete', cardElement(j('test')))).toBe('remove');
    expect(key('Backspace', cardElement(j('test')))).toBe('remove');
    expect(key('Delete', edgeEl)).toEqual({ source: j('test'), target: j('deploy') });
    expect(key('Delete', { tagName: 'INPUT' })).toBeUndefined();
    expect(key('Delete', cardElement(j('test')), { shiftKey: true })).toBeUndefined();
    expect(key('x', cardElement(j('test')))).toBeUndefined();
  });
});

describe('the canvas glue', () => {
  it('tells a rectangle partly out of view from one wholly inside', () => {
    const view = { width: 800, height: 600 };
    expect(outsideView({ x: 10, y: 10, width: 100, height: 50 }, [0, 0, 1], view)).toBe(false);
    expect(outsideView({ x: 750, y: 10, width: 100, height: 50 }, [0, 0, 1], view)).toBe(true);
    expect(outsideView({ x: 10, y: 10, width: 100, height: 50 }, [-20, 0, 1], view)).toBe(true);
    expect(outsideView({ x: 500, y: 300, width: 100, height: 50 }, [0, 0, 2], view)).toBe(true);
    expect(outsideView({ x: 500, y: 300, width: 100, height: 50 }, [0, 0, 0.5], view)).toBe(false);
  });

  it('leaves keys typed into a field, given to a button or held with Ctrl or Meta to their owner', () => {
    const press = (target: unknown, mods: Partial<{ ctrlKey: boolean; metaKey: boolean }> = {}) =>
      canvasKey({ key: 'ArrowDown', altKey: false, target, ctrlKey: false, metaKey: false, ...mods });
    expect(press({ tagName: 'DIV' })).toBe(true);
    expect(press(null)).toBe(true);
    expect(press({ tagName: 'input' })).toBe(false);
    expect(press({ tagName: 'BUTTON' })).toBe(false);
    expect(press({ tagName: 'DIV', isContentEditable: true })).toBe(false);
    expect(press({ tagName: 'DIV' }, { metaKey: true })).toBe(false);
    expect(press({ tagName: 'DIV' }, { ctrlKey: true })).toBe(false);
  });

  it('asks navigate about a canvas key with the selection and the picture, and about nothing else', () => {
    const { model, layout } = picture();
    const asked: unknown[][] = [];
    const navigate = (...args: unknown[]) => {
      asked.push(args);
      return { fit: true } as const;
    };
    const key = {
      key: 'ArrowRight',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      target: { tagName: 'DIV' },
    };
    expect(keyAction(key, navigate, j('test'), { model, layout })).toEqual({ fit: true });
    expect(asked).toEqual([[{ key: 'ArrowRight', altKey: true }, j('test'), model, layout]]);
    expect(keyAction(key, navigate, j('test'), undefined)).toBeUndefined();
    expect(
      keyAction({ ...key, target: { tagName: 'INPUT' } }, navigate, j('test'), { model, layout }),
    ).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  it('acts from the focused card when it does not hold the selection, from the selection when it does', () => {
    const { model, layout } = picture();
    const at: unknown[] = [];
    const navigate = (_: unknown, from: unknown) => {
      at.push(from);
      return undefined;
    };
    const press = (target: unknown, selected: string) =>
      keyAction({ key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, target }, navigate, selected, {
        model,
        layout,
      });
    press(cardElement(j('test')), j('deploy'));
    press(cardElement(j('test')), `${j('test')}/steps.run`);
    press({ tagName: 'DIV' }, j('deploy'));
    expect(at).toEqual([j('test'), `${j('test')}/steps.run`, j('deploy')]);
  });

  it('acts from the selection while the keys are still moving the focus to the card they selected', () => {
    const { model, layout } = picture();
    const at: unknown[] = [];
    const navigate = (_: unknown, from: unknown) => {
      at.push(from);
      return undefined;
    };
    const key = { key: 'ArrowDown', altKey: false, ctrlKey: false, metaKey: false, target: cardElement(CI) };
    keyAction(key, navigate, j('test'), { model, layout }, j('test'));
    keyAction(key, navigate, j('test'), { model, layout });
    expect(at).toEqual([j('test'), CI]);
  });

  it('reads the node a React Flow node element is, and none from anything inside it', () => {
    expect(nodeIdOf(cardElement(j('test')))).toBe(j('test'));
    expect(nodeIdOf({ classList: { contains: () => false }, getAttribute: () => j('test') })).toBeUndefined();
    expect(nodeIdOf(null)).toBeUndefined();
    expect(nodeIdOf({ tagName: 'DIV' })).toBeUndefined();
  });

  it('selects a card focus lands on unless it holds the selection, and brings a keyboard focus into view', () => {
    const { model } = picture();
    const by = (keys: boolean, keyboard: boolean) => ({ keys, keyboard });
    expect(cardFocus(j('test'), j('deploy'), model, by(false, true))).toEqual({
      select: j('test'),
      centre: j('test'),
    });
    expect(cardFocus(j('test'), j('deploy'), model, by(false, false))).toEqual({ select: j('test') });
    expect(cardFocus(j('test'), `${j('test')}[node=22]`, model, by(false, true))).toEqual({
      centre: j('test'),
    });
    expect(cardFocus(j('test'), j('deploy'), model, by(true, true))).toEqual({});
    expect(cardFocus(CI, undefined, model, by(false, false))).toEqual({ select: CI });
  });

  it('runs each navigation answer as its effect', () => {
    const calls: string[] = [];
    const fx: NavEffects = {
      select: (id) => calls.push(`select ${id ?? 'focus'}`),
      toggle: (id) => calls.push(`toggle ${id}`),
      fit: () => calls.push('fit'),
      centre: (id) => calls.push(`centre ${id}`),
      actualSize: () => calls.push('100%'),
      leave: () => calls.push('leave'),
    };
    runNav({ select: 'a' }, fx);
    runNav({ select: undefined }, fx);
    runNav({ toggle: 'b' }, fx);
    runNav({ fit: true }, fx);
    runNav({ centre: 'c' }, fx);
    runNav({ actualSize: true }, fx);
    runNav({ leave: true }, fx);
    expect(calls).toEqual(['select a', 'select focus', 'toggle b', 'fit', 'centre c', '100%', 'leave']);
  });
});

describe('what a card says', () => {
  it('names a job by its verdict word, label, clause, a result that is not success and its needs', () => {
    expect(jobLabel(job(j('build')))).toBe('runs build');
    expect(jobLabel(job(j('e2e'), { verdict: 'maybe', clause: 'if: vars.E2E → ?', result: '?' }))).toBe(
      'might run e2e — if: vars.E2E → ?, result ?',
    );
    expect(jobLabel(job(j('deploy')), ['test', 'build'])).toBe('runs deploy, needs test, build');
  });

  it('names a needs edge and a leg cell in words', () => {
    expect(needsLabel('build', 'deploy', { from: 'no' })).toBe('deploy needs build (skipped)');
    expect(needsLabel('build', 'deploy', { from: 'maybe', label: 'result: ?' })).toBe(
      'deploy needs build (might run); result: ? decided deploy',
    );
    const leg = { id: 'x[node=22]', legKey: 'node=22', label: 'node=22', verdict: 'yes' as const };
    expect(legTitle(leg)).toBe('node=22: runs');
    expect(legTitle({ ...leg, verdict: 'no', result: 'skipped' })).toBe('node=22: skipped, result skipped');
    expect(
      legTitle({
        ...leg,
        label: '∗',
        verdict: 'maybe',
        reason: 'matrix only the run knows (ci.yml#b.matrix)',
      }),
    ).toBe('∗: might run — matrix only the run knows (ci.yml#b.matrix)');
  });

  it('names a workflow by its name or path, its clause and its caller', () => {
    expect(scopeLabel(scope(CI, { name: 'CI' }))).toBe('runs CI — on: push');
    expect(scopeLabel(scope(SUB, { path: 'build.yml', verdict: 'no', clause: 'parent no' }), 'build')).toBe(
      'skipped build.yml — parent no, called by build',
    );
  });

  it('builds the subline from the clause, the count, the uses and a check that is not the label', () => {
    expect(subline(job(j('build')))).toEqual({});
    expect(
      subline(
        job(j('test'), {
          verdict: 'no',
          clause: 'branches [main] ← topic: false',
          count: 4,
          uses: './.github/workflows/t.yml',
          check: 'Test',
        }),
      ),
    ).toEqual({
      status: 'skipped — branches [main] ← topic: false',
      count: '×4',
      uses: './.github/workflows/t.yml',
      check: 'Test',
    });
    expect(subline(job(j('lint'), { check: 'lint' })).check).toBeUndefined();
    expect(subline(job(j('lint'), { count: '?' })).count).toBe('×?');
  });

  it('tones a result badge by what it says', () => {
    expect(resultTone('failure')).toBe('danger');
    expect(resultTone('success | cancelled')).toBe('unknown');
    expect(resultTone('?')).toBe('unknown');
    expect(resultTone('cancelled')).toBe('skip');
    expect(resultTone('neutral')).toBe('muted');
  });

  it('counts a workflow by verdict, leaving the empty ones out', () => {
    const counts = { yes: 4, no: 0, maybe: 2 };
    expect(countParts(counts)).toEqual([
      { verdict: 'yes', n: 4, glyph: '●' },
      { verdict: 'maybe', n: 2, glyph: '◐' },
    ]);
    expect(countsText(counts)).toBe('4 runs, 2 might run');
  });

  it('opens and closes only a callee past depth 2', () => {
    expect(deepCallee(scope(SUB, { caller: j('build'), depth: 3 }))).toBe(true);
    expect(deepCallee(scope(SUB, { caller: j('build'), depth: 2 }))).toBe(false);
    expect(deepCallee(scope(CI, { depth: 3 }))).toBe(false);
  });

  it('gives the styles the verdict, the selection, the path and the flash as attributes', () => {
    expect(cardAttrs('maybe', { selected: false, hovered: false })).toEqual({ 'data-verdict': 'maybe' });
    expect(cardAttrs('yes', { selected: false, hovered: false, path: 'off', flash: 'b' })).toEqual({
      'data-verdict': 'yes',
      'data-path': 'off',
      'data-flash': 'b',
    });
    expect(cardAttrs('yes', { selected: true, hovered: false, path: 'on' })).toEqual({
      'data-verdict': 'yes',
      'data-selected': 'self',
      'data-path': 'on',
    });
    expect(cardAttrs('no', { selected: true, inner: 'x[a]', hovered: false })['data-selected']).toBe('inner');
    expect(edgeAttrs({ from: 'no', deciding: true, onPath: false, faded: true })).toEqual({
      'data-from': 'no',
      'data-deciding': 'true',
      'data-path': 'off',
    });
    expect(edgeAttrs({ from: 'maybe', deciding: false, onPath: true, faded: false })).toEqual({
      'data-from': 'maybe',
      'data-path': 'on',
    });
  });
});

describe('the grid, the strip and the list', () => {
  const grid: GridGeometry = {
    cols: 3,
    rows: 2,
    cell: { width: 72, height: 20 },
    values: true,
    histogram: false,
    width: 3 * 72 + 2 * 4,
    height: 2 * 20 + 4,
  };

  it('places cells row by row with the space between them shared', () => {
    expect(cellAt(0, grid)).toEqual({ x: 0, y: 0 });
    expect(cellAt(2, grid)).toEqual({ x: 152, y: 0 });
    expect(cellAt(4, grid)).toEqual({ x: 76, y: 24 });
    expect(cellAt(0, { ...grid, cols: 1, rows: 1, width: 72, height: 20 })).toEqual({ x: 0, y: 0 });
  });

  it('cuts a value that does not fit its cell', () => {
    expect(cellChars(grid)).toBe(10);
    expect(clip('node=22', 10)).toBe('node=22');
    expect(clip('node=22,os=ubuntu', 10)).toBe('node=22,o…');
  });

  it('counts a large matrix into one histogram row', () => {
    const legs = [
      ...Array.from({ length: 1800 }, () => ({ verdict: 'yes' as const })),
      ...Array.from({ length: 200 }, () => ({ verdict: 'maybe' as const })),
    ];
    expect(histogram(legs)).toEqual([
      { verdict: 'yes', glyph: '●', n: '1,800' },
      { verdict: 'no', glyph: '○', n: '0' },
      { verdict: 'maybe', glyph: '◐', n: '200' },
    ]);
  });

  it('lays the strip out 26 marks to a row, narrowing the pitch to fit the width', () => {
    const few = stripLayout(5, 152);
    expect(few).toMatchObject({ width: 60, height: CARD.stripRow, size: 10 });
    expect(few.at(1)).toEqual({ x: 13, y: 2 });
    const many = stripLayout(30, 152);
    expect(many.height).toBe(2 * CARD.stripRow);
    expect(many.at(26)).toMatchObject({ y: CARD.stripRow + (CARD.stripRow - many.size) / 2 });
    expect(many.width).toBeLessThanOrEqual(152);
  });

  it('lists inner steps under their composite step and cuts the list at its cap', () => {
    const mark = (id: string, inner: StepMark[] = []): StepMark => ({ id, label: id, verdict: 'yes', inner });
    const steps = [mark('a', [mark('a1'), mark('a2', [mark('a2x')])]), mark('b')];
    expect(listRows(steps).rows.map((r) => `${r.step.id}:${r.depth}`)).toEqual([
      'a:0',
      'a1:1',
      'a2:1',
      'a2x:2',
      'b:0',
    ]);
    expect(listRows(steps, 3)).toMatchObject({ more: 2 });
    expect(listRows(steps, 3).rows).toHaveLength(3);
  });
});

describe('what a click does', () => {
  const WF = '.github/workflows/ci.yml';
  const TEST = `${WF}#test`;
  const files = {
    [WF]: `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: make }]
  test:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps: [{ run: npm test }]
`,
  };

  /** The worker's answer for a push to main, as the store holds it. */
  function planned(): PlanState {
    const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
    const { response } = handle(loaded.state, {
      id: 2,
      type: 'simulate',
      project: 1,
      scenario: { event: 'push', branch: 'main' },
      assume: [],
      detail: 'steps',
    });
    if (response.type !== 'plan') throw new Error(response.type);
    const { plan, derived, text, ms } = response;
    return { plan, derived, text, ms, for: { files: 1, epoch: 1, project: 1 } };
  }

  const storeOf = () => createSessionStore({ ...initialSessionState(), plan: planned(), focus: WF });

  it('selects a node through its unit path, and ignores one the plan does not hold', () => {
    const store = storeOf();
    const act = cardActions(store);
    act.select(TEST);
    expect(store.getState()).toMatchObject({ focus: WF, sel: 'test' });
    act.select(`${WF}#gone`);
    expect(store.getState().sel).toBe('test');
    expect(selectedNode(store.getState())).toBe(TEST);
    act.selectFocus();
    expect(store.getState().sel).toBeUndefined();
    expect(selectedNode(store.getState())).toBe(WF);
  });

  it('makes a picked leg the representative and selects it', () => {
    const store = storeOf();
    const leg = `${TEST}[node=22]`;
    cardActions(store).select(leg);
    expect(store.getState().ui.representative).toEqual({ [TEST]: leg });
    expect(store.getState().sel).toBe('test[node=22]');
  });

  it('leaves the representative alone when the leg picked already is one, or the node is not a leg', () => {
    const store = storeOf();
    const act = cardActions(store);
    act.select(`${TEST}[node=20]`);
    const representative = store.getState().ui.representative;
    act.select(`${TEST}[node=20]`);
    act.select(TEST);
    expect(store.getState().ui.representative).toBe(representative);
  });

  it('opens and closes the step list and a deep callee', () => {
    const store = storeOf();
    const act = cardActions(store);
    act.toggleExpanded(TEST);
    act.toggleOpened(SUB);
    expect(store.getState().ui).toMatchObject({ expanded: [TEST], opened: [SUB] });
    act.toggleExpanded(TEST);
    expect(store.getState().ui.expanded).toEqual([]);
  });

  it('selects nothing before a plan exists', () => {
    const store = createSessionStore();
    cardActions(store).select(TEST);
    expect(store.getState().sel).toBeUndefined();
    expect(selectedNode(store.getState())).toBeUndefined();
  });
});
