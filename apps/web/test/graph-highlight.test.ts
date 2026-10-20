import type { NodeId, RunPlan, ScenarioInput, Unknown } from '@simulci/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flashOf, litCards, reducedMotion } from '../src/graph/highlight';
import type { GraphModel, GraphState, JobModel, ScopeModel } from '../src/graph/types';
import type { VerdictChange } from '../src/plan/changes';
import type { Pin, PlanState } from '../src/state/store';

const CI = 'ci.yml';
const RELEASE = 'release.yml';
const SUB = 'ci.yml#build>build.yml';
const j = (name: string, wf = CI): string => `${wf}#${name}`;

function job(id: string, scope = CI): JobModel {
  return {
    id,
    scope,
    jobId: id.slice(id.lastIndexOf('#') + 1),
    label: id,
    verdict: 'maybe',
    needs: [],
    steps: [],
    expanded: false,
  };
}

function scopeOf(id: string, jobs: string[], over: Partial<ScopeModel> = {}): ScopeModel {
  return {
    id,
    path: id,
    verdict: 'yes',
    clause: 'on: push',
    counts: { yes: 0, no: 0, maybe: 0 },
    depth: 0,
    collapsed: false,
    jobs,
    edges: [],
    shape: '',
    ...over,
  };
}

/** ci.yml: build (calls build.yml: compile, pack), test, deploy; release.yml is not triggered, one line. */
function model(): GraphModel {
  const jobs = [
    { ...job(j('build')), callee: SUB },
    job(j('test')),
    job(j('deploy')),
    job(j('compile', SUB), SUB),
    job(j('pack', SUB), SUB),
    job(j('publish', RELEASE), RELEASE),
  ];
  return {
    roots: [CI, RELEASE],
    scopes: {
      [CI]: scopeOf(CI, [j('build'), j('test'), j('deploy')]),
      [SUB]: scopeOf(SUB, [j('compile', SUB), j('pack', SUB)], { depth: 1, caller: j('build') }),
      [RELEASE]: scopeOf(RELEASE, [j('publish', RELEASE)], { verdict: 'no', collapsed: true }),
    },
    jobs: Object.fromEntries(jobs.map((x) => [x.id, x])),
  };
}

const unknown = (id: string, affects: NodeId[]): Unknown => ({ id, kind: 'step-output', reads: [], affects });
const planWith = (...unknowns: Unknown[]): RunPlan => ({ unknowns }) as unknown as RunPlan;
const sorted = (set: ReadonlySet<NodeId> | undefined): NodeId[] => [...(set ?? [])].sort();

describe('the cards a hovered unknown lights', () => {
  it('lights the card that shows what it affects and the workflow that holds it', () => {
    const plan = planWith(unknown('vars.DEPLOY', [j('deploy')]));
    expect(sorted(litCards(model(), plan, 'vars.DEPLOY'))).toEqual([CI, j('deploy')]);
  });

  it("lights a step's and a leg's job card", () => {
    const plan = planWith(unknown('u', [`${j('test')}[node=22]`, `${j('test')}/steps.lint`]));
    expect(sorted(litCards(model(), plan, 'u'))).toEqual([CI, j('test')]);
  });

  it("lights a called job's workflow, the job that calls it and that job's workflow, up to the root", () => {
    const plan = planWith(unknown('u', [`${j('pack', SUB)}/steps.zip`]));
    expect(sorted(litCards(model(), plan, 'u'))).toEqual([CI, j('build'), SUB, j('pack', SUB)].sort());
  });

  it('lights a collapsed workflow for a job of it the canvas does not draw', () => {
    const plan = planWith(unknown('u', [j('publish', RELEASE)]));
    expect(litCards(model(), plan, 'u')!.has(RELEASE)).toBe(true);
  });

  it('lights nothing, so every card fades, for an unknown that affects nothing', () => {
    const lit = litCards(model(), planWith(unknown('u', [])), 'u');
    expect(lit).toBeDefined();
    expect(lit!.size).toBe(0);
  });

  it('lights no set at all while no unknown of the plan is hovered', () => {
    const plan = planWith(unknown('u', [j('deploy')]));
    expect(litCards(model(), plan, undefined)).toBeUndefined();
    expect(litCards(model(), plan, 'gone')).toBeUndefined();
    expect(litCards(model(), undefined, 'u')).toBeUndefined();
  });
});

const answer = {} as RunPlan;
const change = (id: NodeId, kind: VerdictChange['kind'] = 'job'): VerdictChange => ({
  id,
  kind,
  from: 'no',
  to: 'yes',
  label: id,
});

/** The store's plan answering the pin, and the picture committed for it, as the graph session commits one. */
function answered(seq: number, changes: VerdictChange[]) {
  const plan = { plan: answer, for: { files: 1, epoch: 1, project: 1 } } as PlanState;
  const graph: GraphState = { model: model(), layout: { scopes: {}, roots: {}, cards: {} }, for: plan.for };
  const pin: Pin = {
    seq,
    scenario: {} as ScenarioInput,
    assume: [],
    after: { plan: answer, changes, sentence: 'pinned; deploy now runs' },
  };
  return { pin, plan, graph };
}

describe('the flash of a pin', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('flashes the cards that show what the pin changed, a step in its job card', () => {
    const { pin, plan, graph } = answered(4, [
      change(j('deploy')),
      change(RELEASE, 'workflow'),
      change(`${j('test')}/steps.lint`, 'step'),
    ]);
    const flash = flashOf(pin, plan, graph);
    expect(flash).toMatchObject({ seq: 4, parity: 'a' });
    expect(sorted(flash!.cards)).toEqual([j('deploy'), j('test'), RELEASE].sort());
  });

  it('alternates its parity from one pin to the next, so the same card flashes again', () => {
    const changes = [change(j('deploy'))];
    const first = answered(5, changes);
    const next = answered(6, changes);
    expect(flashOf(first.pin, first.plan, first.graph)?.parity).toBe('b');
    expect(flashOf(next.pin, next.plan, next.graph)?.parity).toBe('a');
  });

  it("waits for the answering plan's picture, and stops at a later plan", () => {
    const { pin, plan, graph } = answered(4, [change(j('deploy'))]);
    // The picture of the plan before the pin is still on the canvas.
    expect(flashOf(pin, plan, { ...graph, for: { files: 1, epoch: 1, project: 1 } })).toBeUndefined();
    // A plan came after the one that answered the pin.
    expect(flashOf(pin, { ...plan, plan: {} as RunPlan }, graph)).toBeUndefined();
    expect(flashOf({ ...pin, after: undefined }, plan, graph)).toBeUndefined();
    expect(flashOf(undefined, plan, graph)).toBeUndefined();
    expect(flashOf(pin, undefined, graph)).toBeUndefined();
  });

  it('flashes nothing for an author who asked for less motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
    }));
    const { pin, plan, graph } = answered(4, [change(j('deploy'))]);
    expect(reducedMotion()).toBe(true);
    expect(flashOf(pin, plan, graph)).toBeUndefined();
  });

  it('takes motion as wanted where nothing says otherwise', () => {
    expect(reducedMotion()).toBe(false);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(reducedMotion()).toBe(false);
  });
});
