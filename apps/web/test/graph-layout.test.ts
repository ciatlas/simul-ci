import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { assembleLayout, createLayoutCache, type LayoutCache } from '../src/graph/layout';
import { tableMetrics } from '../src/graph/metrics';
import { cardSize } from '../src/graph/size';
import {
  CARD,
  type GraphLayout,
  type GraphModel,
  type JobModel,
  type ScopeLayout,
  type ScopeModel,
} from '../src/graph/types';
import {
  answerLayout,
  ELK_OPTIONS,
  isLayoutRequest,
  type LayoutRequest,
  WARM_UP,
} from '../src/worker/layout-protocol';

const elk = new ELK();

/** A model written by hand: scopes of jobs by id, `needs` as [source, target] pairs. */
class Model {
  model: GraphModel = { roots: [], scopes: {}, jobs: {} };

  scope(id: string, jobs: string[], needs: [string, string][] = [], over: Partial<ScopeModel> = {}): this {
    const ids = jobs.map((j) => `${id}#${j}`);
    this.model.scopes[id] = {
      id,
      path: id,
      verdict: 'yes',
      clause: '',
      counts: { yes: jobs.length, no: 0, maybe: 0 },
      depth: 0,
      collapsed: false,
      jobs: ids,
      edges: needs.map(([s, t]) => ({
        id: `${id}#${s}->${id}#${t}`,
        source: `${id}#${s}`,
        target: `${id}#${t}`,
        from: 'yes',
        deciding: false,
      })),
      // What graph/shape.ts hashes, spelled out: jobs, labels, open lists and edges.
      shape: `${jobs.join(',')}|${needs.join(';')}|${over.collapsed ?? false}`,
      ...over,
    };
    for (const [i, j] of jobs.entries()) this.model.jobs[ids[i]!] = job(id, j);
    if ((over.depth ?? 0) === 0 && !this.model.roots.includes(id)) this.model.roots.push(id);
    return this;
  }

  /** The job calls `callee`, and the shape of its scope says so, as graph/shape.ts folds the callee's shape in. */
  calls(jobId: string, callee: string): this {
    const job = this.model.jobs[jobId]!;
    job.callee = callee;
    job.uses = callee;
    const scope = this.model.scopes[job.scope]!;
    scope.shape += `|${jobId}>${this.model.scopes[callee]!.shape}`;
    return this;
  }
}

const job = (scope: string, jobId: string): JobModel => ({
  id: `${scope}#${jobId}`,
  scope,
  jobId,
  label: jobId,
  verdict: 'yes',
  needs: [],
  steps: [],
  expanded: false,
});

/** What the session does: plan, ask the worker's code for what is missing, keep it, assemble. */
async function lay(
  cache: LayoutCache,
  model: GraphModel,
): Promise<{ layout: GraphLayout; asked?: string[] }> {
  let plan = cache.plan(model, tableMetrics);
  const asked = plan.request?.scopes.map((s) => s.id);
  if (plan.request) {
    const r = await answerLayout(elk, { id: 1, type: 'layout', ...plan.request });
    if (r.type !== 'layout') throw new Error(r.message);
    plan = cache.keep(plan, r.scopes);
  }
  const layout = assembleLayout(model, plan, tableMetrics);
  if (!layout) throw new Error('not placed');
  return { layout, ...(asked ? { asked } : {}) };
}

describe('ELK in the layout worker', () => {
  it('knows every option the worker sets', async () => {
    const known = new Set((await elk.knownLayoutOptions()).map((o) => o.id));
    for (const key of Object.keys(ELK_OPTIONS)) expect(known).toContain(`org.eclipse.${key}`);
  });

  it('lays a chain of needs out left to right, inside the scope padding', async () => {
    const m = new Model().scope(
      'ci.yml',
      ['lint', 'test', 'deploy'],
      [
        ['lint', 'test'],
        ['test', 'deploy'],
      ],
    ).model;
    const { layout } = await lay(createLayoutCache(), m);
    const at = layout.scopes['ci.yml']!.positions;
    const [lint, test, deploy] = [at['ci.yml#lint']!, at['ci.yml#test']!, at['ci.yml#deploy']!];
    expect(lint.x).toBeGreaterThanOrEqual(CARD.scopePadding.left);
    expect(lint.y).toBeGreaterThanOrEqual(CARD.scopePadding.top);
    expect(test.x).toBeGreaterThanOrEqual(lint.x + CARD.minWidth + 48);
    expect(deploy.x).toBeGreaterThanOrEqual(test.x + CARD.minWidth + 48);
    expect(layout.scopes['ci.yml']!.width).toBeGreaterThanOrEqual(deploy.x + CARD.minWidth);
    expect(layout.cards['ci.yml#deploy']).toEqual({ width: CARD.minWidth, height: 64 });
  });

  it('places the same input in the same positions every time', async () => {
    const m = new Model().scope(
      'ci.yml',
      ['a', 'b', 'c', 'd', 'e'],
      [
        ['a', 'c'],
        ['b', 'c'],
        ['a', 'd'],
        ['c', 'e'],
        ['d', 'e'],
      ],
    ).model;
    const first = await lay(createLayoutCache(), m);
    const second = await lay(createLayoutCache(), structuredClone(m));
    expect(second.layout).toEqual(first.layout);
  });

  it('lays every warm-up out, its call card around the chain, and moves no card laid out after it', async () => {
    const m = new Model().scope(
      'ci.yml',
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'd'],
      ],
    ).model;
    const before = await lay(createLayoutCache(), m);
    const warm: Record<string, ScopeLayout> = {};
    for (const request of WARM_UP) {
      const r = await answerLayout(elk, request);
      if (r.type !== 'layout') throw new Error(r.message);
      Object.assign(warm, r.scopes);
    }
    expect(Object.keys(warm)).toEqual(['chain', 'fan', 'call']);
    // The chain as laid out is the size the call card is given for it.
    expect(warm.chain).toMatchObject(WARM_UP[2]!.known.chain!);
    expect(warm.call!.width).toBeGreaterThan(warm.chain!.width);
    const after = await lay(createLayoutCache(), structuredClone(m));
    expect(after.layout).toEqual(before.layout);
  });

  it("lays a callee out first and sizes its caller's card around it, in one request", async () => {
    const m = new Model()
      .scope('callee', ['build', 'publish'], [['build', 'publish']], { depth: 1, caller: 'ci.yml#release' })
      .scope('ci.yml', ['release', 'notify'], [['release', 'notify']])
      .calls('ci.yml#release', 'callee').model;
    const { layout, asked } = await lay(createLayoutCache(), m);
    expect(asked).toEqual(['callee', 'ci.yml']);
    const callee = layout.scopes.callee!;
    const card = layout.cards['ci.yml#release']!;
    expect(card).toEqual(cardSize(m.jobs['ci.yml#release']!, tableMetrics, callee));
    expect(card.width).toBe(callee.width + 2 * CARD.callPadding);
    const at = layout.scopes['ci.yml']!.positions;
    expect(at['ci.yml#notify']!.x).toBeGreaterThanOrEqual(at['ci.yml#release']!.x + card.width + 48);
    expect(layout.scopes['ci.yml']!.height).toBeGreaterThanOrEqual(card.height + CARD.scopePadding.top);
  });

  it('lays out together the scopes whose callees have sizes, then their callers, as one at a time would', async () => {
    const m = new Model()
      .scope('one', ['build', 'sign'], [['build', 'sign']], { depth: 1, caller: 'a.yml#call' })
      .scope('two', ['x'], [], { depth: 1, caller: 'b.yml#call' })
      .scope('a.yml', ['call', 'after'], [['call', 'after']])
      .calls('a.yml#call', 'one')
      .scope('b.yml', ['lint', 'call'], [['lint', 'call']])
      .calls('b.yml#call', 'two').model;
    const request = createLayoutCache().plan(m, tableMetrics).request!;
    expect(request.scopes.map((s) => s.id)).toEqual(['one', 'a.yml', 'two', 'b.yml']);
    let running: string[] = [];
    const starts: string[][] = [];
    const watched: Pick<InstanceType<typeof ELK>, 'layout'> = {
      layout: async (graph) => {
        running.push(graph.id);
        starts.push([...running]);
        const laid = await elk.layout(graph);
        running = running.filter((id) => id !== graph.id);
        return laid;
      },
    };
    const together = await answerLayout(watched, { id: 1, type: 'layout', ...request });
    expect(starts).toEqual([['one'], ['one', 'two'], ['a.yml'], ['a.yml', 'b.yml']]);
    if (together.type !== 'layout') throw new Error(together.message);

    const known = { ...request.known };
    const alone: Record<string, unknown> = {};
    for (const scope of request.scopes) {
      const r = await answerLayout(elk, { id: 1, type: 'layout', scopes: [scope], known });
      if (r.type !== 'layout') throw new Error(r.message);
      const laid = r.scopes[scope.id]!;
      alone[scope.id] = laid;
      known[scope.id] = { width: laid.width, height: laid.height };
    }
    expect(together.scopes).toEqual(alone);
  });

  it('stacks the roots by plan order, an untriggered one collapsed in its slot and never laid out', async () => {
    const m = new Model()
      .scope('a.yml', ['one'])
      .scope('b.yml', [], [], { collapsed: true, verdict: 'no' })
      .scope('c.yml', ['two', 'three'], [['two', 'three']]).model;
    const { layout, asked } = await lay(createLayoutCache(), m);
    expect(asked).toEqual(['a.yml', 'c.yml']);
    expect(Object.keys(layout.scopes)).toEqual(['a.yml', 'c.yml']);
    const a = layout.scopes['a.yml']!;
    expect(layout.roots).toEqual({
      'a.yml': { x: 0, y: 0, width: a.width, height: a.height },
      'b.yml': { x: 0, y: a.height + CARD.rootGap, ...CARD.collapsed },
      'c.yml': {
        x: 0,
        y: a.height + CARD.rootGap + CARD.collapsed.height + CARD.rootGap,
        width: layout.scopes['c.yml']!.width,
        height: layout.scopes['c.yml']!.height,
      },
    });
  });

  it('sizes a call card around a closed callee without laying the callee out', async () => {
    const m = new Model()
      .scope('deep', ['x'], [], { depth: 3, collapsed: true })
      .scope('ci.yml', ['call'])
      .calls('ci.yml#call', 'deep').model;
    const { layout, asked } = await lay(createLayoutCache(), m);
    expect(asked).toEqual(['ci.yml']);
    expect(layout.cards['ci.yml#call']!.width).toBe(CARD.collapsed.width + 2 * CARD.callPadding);
  });

  it('answers with an error, and no partial picture, when a scope cannot be laid out', async () => {
    const node = {
      id: 'ci.yml#a',
      callee: 'missing',
      extra: { width: 0, height: 0 },
      min: { width: 1, height: 1 },
    };
    const request: LayoutRequest = {
      id: 7,
      type: 'layout',
      scopes: [{ id: 'ci.yml', nodes: [node], edges: [] }],
      known: {},
    };
    expect(await answerLayout(elk, request)).toEqual({
      id: 7,
      type: 'error',
      message: 'ci.yml#a calls missing, which is neither laid out nor known',
    });
    const dangling = {
      ...request,
      scopes: [
        {
          id: 'ci.yml',
          nodes: [{ id: 'ci.yml#a', width: 10, height: 10 }],
          edges: [{ id: 'e', source: 'ci.yml#a', target: 'ci.yml#gone' }],
        },
      ],
    };
    expect(await answerLayout(elk, dangling)).toMatchObject({ id: 7, type: 'error' });
  });

  it('takes only messages shaped like a layout request', () => {
    expect(isLayoutRequest({ id: 1, type: 'layout', scopes: [], known: {} })).toBe(true);
    expect(isLayoutRequest({ id: 1, type: 'simulate', scopes: [], known: {} })).toBe(false);
    expect(isLayoutRequest({ id: 1, type: 'layout', scopes: [] })).toBe(false);
    expect(isLayoutRequest(null)).toBe(false);
  });
});

describe('the layout cache', () => {
  const two = () =>
    new Model()
      .scope('callee', ['build'], [], { depth: 1, caller: 'a.yml#call' })
      .scope('a.yml', ['call', 'after'], [['call', 'after']])
      .calls('a.yml#call', 'callee')
      .scope('b.yml', ['lint', 'test'], [['lint', 'test']]);

  it('reuses every scope for a recolour, and asks the worker nothing', async () => {
    const cache = createLayoutCache();
    const first = await lay(cache, two().model);
    const recoloured = two().model;
    for (const j of Object.values(recoloured.jobs))
      Object.assign(j, { verdict: 'no', clause: 'skipped — if' });
    for (const s of Object.values(recoloured.scopes)) Object.assign(s, { verdict: 'maybe', clause: 'push' });
    const again = await lay(cache, recoloured);
    expect(again.asked).toBeUndefined();
    expect(again.layout).toEqual(first.layout);
  });

  it('lays out again only the scope a new job joins, with the sizes of the callees it keeps', async () => {
    const cache = createLayoutCache();
    const first = await lay(cache, two().model);
    const grown = two().scope('b.yml', ['lint', 'test', 'audit'], [['lint', 'test']]);
    const again = await lay(cache, grown.model);
    expect(again.asked).toEqual(['b.yml']);
    expect(again.layout.scopes['a.yml']).toBe(first.layout.scopes['a.yml']);

    const called = two().scope('a.yml', ['call', 'after', 'tidy'], [['call', 'after']]);
    called.calls('a.yml#call', 'callee');
    const plan = cache.plan(called.model, tableMetrics);
    expect(plan.request?.scopes.map((s) => s.id)).toEqual(['a.yml']);
    const callee = first.layout.scopes.callee!;
    expect(plan.request?.known).toEqual({ callee: { width: callee.width, height: callee.height } });
  });

  it('lays out a callee and the scope that calls it when the callee changes', async () => {
    const cache = createLayoutCache();
    await lay(cache, two().model);
    const m = new Model()
      .scope('callee', ['build', 'sign'], [['build', 'sign']], { depth: 1, caller: 'a.yml#call' })
      .scope('a.yml', ['call', 'after'], [['call', 'after']])
      .calls('a.yml#call', 'callee')
      .scope('b.yml', ['lint', 'test'], [['lint', 'test']]).model;
    expect((await lay(cache, m)).asked).toEqual(['callee', 'a.yml']);
  });

  it('keeps the shapes an author toggles between, and lets the oldest go past its limit', async () => {
    const cache = createLayoutCache(2);
    const open = (expanded: boolean) => {
      const m = new Model().scope('ci.yml', ['build']).model;
      const build = m.jobs['ci.yml#build']!;
      Object.assign(build, { expanded, steps: [{ id: 's', label: 's', verdict: 'yes', inner: [] }] });
      m.scopes['ci.yml']!.shape += expanded ? '|open' : '';
      return m;
    };
    expect((await lay(cache, open(true))).asked).toEqual(['ci.yml']);
    expect((await lay(cache, open(false))).asked).toEqual(['ci.yml']);
    expect((await lay(cache, open(true))).asked).toBeUndefined();
    await lay(cache, new Model().scope('other.yml', ['x']).model);
    expect((await lay(cache, open(false))).asked).toEqual(['ci.yml']);
  });

  it('leaves the picture unplaced while the worker has not answered for a scope', () => {
    const cache = createLayoutCache();
    const m = two().model;
    const plan = cache.plan(m, tableMetrics);
    expect(assembleLayout(m, plan, tableMetrics)).toBeUndefined();
    expect(assembleLayout(m, cache.keep(plan, {}), tableMetrics)).toBeUndefined();
  });
});
