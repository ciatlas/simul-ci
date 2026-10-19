import type { NodeId } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { cardOf, createNavigator, type NavKey, navigate } from '../src/graph/navigate';
import type { EdgeModel, GraphLayout, GraphModel, JobModel, ScopeModel, StepMark } from '../src/graph/types';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const CALLEE = `${CI}#call>.github/workflows/reusable.yml`;

const ci = (name: string): NodeId => `${CI}#${name}`;
const callee = (name: string): NodeId => `${CALLEE}#${name}`;
const LEG20 = `${ci('test')}[node=20]`;
const LEG22 = `${ci('test')}[node=22]`;

function scope(id: NodeId, jobs: NodeId[], extra: Partial<ScopeModel> = {}): ScopeModel {
  const counts = { yes: jobs.length, no: 0, maybe: 0 };
  return {
    id,
    path: id,
    verdict: 'yes',
    clause: '',
    counts,
    depth: 0,
    collapsed: false,
    jobs,
    edges: [],
    shape: '',
    ...extra,
  };
}

function job(id: NodeId, scopeId: NodeId, extra: Partial<JobModel> = {}): JobModel {
  const jobId = id.slice(id.lastIndexOf('#') + 1);
  return {
    id,
    scope: scopeId,
    jobId,
    label: jobId,
    verdict: 'yes',
    needs: [],
    steps: [],
    expanded: false,
    ...extra,
  };
}

const step = (id: NodeId, inner: StepMark[] = []): StepMark => ({ id, label: id, verdict: 'yes', inner });

const edge = (source: NodeId, target: NodeId): EdgeModel => ({
  id: `${source}->${target}`,
  source,
  target,
  from: 'yes',
  deciding: false,
});

/**
 * ci.yml, declared lint, build, test, docs, deploy, call and laid out in two rows: build lint | test docs | deploy
 * call. build is needed by test and docs, deploy needs both; test has two legs, build a composite step, call a
 * callee with two jobs. release.yml is untriggered and collapsed.
 */
const model: GraphModel = {
  roots: [CI, RELEASE],
  scopes: {
    [CI]: scope(CI, ['lint', 'build', 'test', 'docs', 'deploy', 'call'].map(ci), {
      edges: [
        edge(ci('build'), ci('test')),
        edge(ci('build'), ci('docs')),
        edge(ci('test'), ci('deploy')),
        edge(ci('docs'), ci('deploy')),
      ],
    }),
    [RELEASE]: scope(RELEASE, [], { verdict: 'no', collapsed: true }),
    [CALLEE]: scope(CALLEE, [callee('two'), callee('one')], { depth: 1, caller: ci('call') }),
  },
  jobs: {
    [ci('lint')]: job(ci('lint'), CI),
    [ci('build')]: job(ci('build'), CI, {
      steps: [
        step(`${ci('build')}/~checkout`),
        step(`${ci('build')}/~compile`, [
          step(`${ci('build')}/~compile>a/~one`),
          step(`${ci('build')}/~compile>a/~two`),
        ]),
        step(`${ci('build')}/~upload`),
      ],
    }),
    [ci('test')]: job(ci('test'), CI, {
      needs: [ci('build')],
      legs: [
        { id: LEG20, legKey: 'node=20', label: 'node=20', verdict: 'yes' },
        { id: LEG22, legKey: 'node=22', label: 'node=22', verdict: 'yes' },
      ],
      representative: LEG22,
      steps: [step(`${LEG22}/steps.unit`), step(`${LEG22}/~lint`)],
    }),
    [ci('docs')]: job(ci('docs'), CI, { needs: [ci('build')] }),
    [ci('deploy')]: job(ci('deploy'), CI, { needs: [ci('test'), ci('docs')] }),
    [ci('call')]: job(ci('call'), CI, { callee: CALLEE }),
    [callee('one')]: job(callee('one'), CALLEE),
    [callee('two')]: job(callee('two'), CALLEE),
  },
};

const layout: GraphLayout = {
  scopes: {
    [CI]: {
      width: 640,
      height: 320,
      positions: {
        [ci('build')]: { x: 0, y: 0 },
        [ci('lint')]: { x: 0, y: 100 },
        [ci('test')]: { x: 200, y: 0 },
        [ci('docs')]: { x: 200, y: 100 },
        [ci('deploy')]: { x: 400, y: 0 },
        [ci('call')]: { x: 400, y: 100 },
      },
    },
    [CALLEE]: {
      width: 300,
      height: 80,
      positions: { [callee('one')]: { x: 0, y: 0 }, [callee('two')]: { x: 200, y: 0 } },
    },
  },
  roots: {
    [CI]: { x: 0, y: 0, width: 640, height: 320 },
    [RELEASE]: { x: 0, y: 344, width: 320, height: 44 },
  },
  cards: {},
};

const key = (k: string, altKey = false): NavKey => ({ key: k, altKey });
const go = (k: string, at: NodeId | undefined, alt = false) => navigate(key(k, alt), at, model, layout);

describe('the canvas keys', () => {
  it("walks a scope's jobs with ↓ and ↑ by x then y, and stops at either end", () => {
    const walked = [ci('build')];
    for (let a = go('ArrowDown', ci('build')); a && 'select' in a; a = go('ArrowDown', a.select))
      walked.push(a.select!);
    expect(walked).toEqual(['build', 'lint', 'test', 'docs', 'deploy', 'call'].map(ci));
    expect(go('ArrowUp', ci('test'))).toEqual({ select: ci('lint') });
    expect(go('ArrowUp', ci('build'))).toBeUndefined();
  });

  it('walks the roots in stack order, and a called workflow has no siblings', () => {
    expect(go('ArrowDown', CI)).toEqual({ select: RELEASE });
    expect(go('ArrowUp', RELEASE)).toEqual({ select: CI });
    expect(go('ArrowDown', RELEASE)).toBeUndefined();
    expect(go('ArrowDown', CALLEE)).toBeUndefined();
    expect(go('ArrowDown', callee('one'))).toEqual({ select: callee('two') });
  });

  it("walks a job's legs in grid order and a leg's steps in strip order, inner steps among themselves", () => {
    expect(go('ArrowDown', LEG20)).toEqual({ select: LEG22 });
    expect(go('ArrowUp', LEG20)).toBeUndefined();
    expect(go('ArrowDown', `${ci('build')}/~checkout`)).toEqual({ select: `${ci('build')}/~compile` });
    expect(go('ArrowDown', `${ci('build')}/~compile`)).toEqual({ select: `${ci('build')}/~upload` });
    expect(go('ArrowDown', `${ci('build')}/~compile>a/~one`)).toEqual({
      select: `${ci('build')}/~compile>a/~two`,
    });
    expect(go('ArrowDown', `${ci('build')}/~upload`)).toBeUndefined();
  });

  it('follows needs with → to the first job that needs it in layout order, and with ← to the first it needs', () => {
    expect(go('ArrowRight', ci('build'))).toEqual({ select: ci('test') });
    expect(go('ArrowLeft', ci('deploy'))).toEqual({ select: ci('test') });
    expect(go('ArrowRight', ci('deploy'))).toBeUndefined();
    expect(go('ArrowLeft', ci('build'))).toBeUndefined();
    expect(go('ArrowRight', LEG20)).toBeUndefined();
    expect(go('ArrowRight', CI)).toBeUndefined();
    expect(go('ArrowRight', ci('build'), true)).toEqual({ select: ci('test') });
  });

  it('cycles with Alt to the next edge of the node the last edge left, wrapping', () => {
    const nav = createNavigator();
    const n = (k: string, at: NodeId, alt = false) => nav(key(k, alt), at, model, layout);
    expect(n('ArrowRight', ci('build'))).toEqual({ select: ci('test') });
    expect(n('ArrowRight', ci('test'), true)).toEqual({ select: ci('docs') });
    expect(n('ArrowRight', ci('docs'), true)).toEqual({ select: ci('test') });
    expect(n('ArrowLeft', ci('deploy'))).toEqual({ select: ci('test') });
    expect(n('ArrowLeft', ci('test'), true)).toEqual({ select: ci('docs') });
  });

  it('cycles on from a node the selection came back to, and starts afresh anywhere else', () => {
    const nav = createNavigator();
    const n = (k: string, at: NodeId, alt = false) => nav(key(k, alt), at, model, layout);
    n('ArrowRight', ci('build'));
    expect(n('ArrowRight', ci('build'), true)).toEqual({ select: ci('docs') });
    expect(n('ArrowRight', ci('build'), true)).toEqual({ select: ci('test') });
    expect(n('ArrowRight', ci('docs'), true)).toEqual({ select: ci('deploy') });
  });

  it('descends with Enter: a workflow to its first job, a job to its leg, its first step or its callee', () => {
    expect(go('Enter', CI)).toEqual({ select: ci('build') });
    expect(go('Enter', ci('build'))).toEqual({ select: `${ci('build')}/~checkout` });
    expect(go('Enter', ci('test'))).toEqual({ select: LEG22 });
    expect(go('Enter', LEG22)).toEqual({ select: `${LEG22}/steps.unit` });
    expect(go('Enter', ci('call'))).toEqual({ select: callee('one') });
    expect(go('Enter', CALLEE)).toEqual({ select: callee('one') });
    expect(go('Enter', `${ci('build')}/~compile`)).toEqual({ select: `${ci('build')}/~compile>a/~one` });
  });

  it('descends nowhere from a collapsed workflow, a leg the card does not show, a plain step or a bare job', () => {
    expect(go('Enter', RELEASE)).toBeUndefined();
    expect(go('Enter', LEG20)).toBeUndefined();
    expect(go('Enter', `${ci('build')}/~checkout`)).toBeUndefined();
    expect(go('Enter', ci('lint'))).toBeUndefined();
  });

  it('ascends with Esc to the step, leg, job, workflow or caller that holds the selection, then leaves', () => {
    expect(go('Escape', `${ci('build')}/~compile>a/~one`)).toEqual({ select: `${ci('build')}/~compile` });
    expect(go('Escape', `${ci('build')}/~compile`)).toEqual({ select: ci('build') });
    expect(go('Escape', `${LEG22}/steps.unit`)).toEqual({ select: LEG22 });
    expect(go('Escape', LEG20)).toEqual({ select: ci('test') });
    expect(go('Escape', ci('test'))).toEqual({ select: CI });
    expect(go('Escape', callee('one'))).toEqual({ select: CALLEE });
    expect(go('Escape', CALLEE)).toEqual({ select: ci('call') });
    expect(go('Escape', CI)).toEqual({ leave: true });
    expect(go('Escape', undefined)).toEqual({ leave: true });
  });

  it("opens a job's step list with Space, and does nothing with it elsewhere", () => {
    expect(go(' ', ci('build'))).toEqual({ toggle: ci('build') });
    expect(go(' ', `${ci('build')}/~checkout`)).toBeUndefined();
    expect(go(' ', CI)).toBeUndefined();
  });

  it('centres the card that shows the selection, and fits or shows 100 % whatever is selected', () => {
    expect(go('.', `${ci('build')}/~checkout`)).toEqual({ centre: ci('build') });
    expect(go('.', LEG20)).toEqual({ centre: ci('test') });
    expect(go('.', CALLEE)).toEqual({ centre: CALLEE });
    expect(go('.', undefined)).toBeUndefined();
    expect(go('f', undefined)).toEqual({ fit: true });
    expect(go('0', LEG20)).toEqual({ actualSize: true });
  });

  it('leaves Ctrl and Meta combinations to the browser', () => {
    expect(navigate({ key: 'f', altKey: false, ctrlKey: true }, CI, model, layout)).toBeUndefined();
    expect(navigate({ key: 'ArrowDown', altKey: false, metaKey: true }, CI, model, layout)).toBeUndefined();
    expect(go('q', CI)).toBeUndefined();
  });

  it('starts from the first root when nothing is selected or the selection is not on the canvas', () => {
    expect(go('ArrowDown', undefined)).toEqual({ select: CI });
    expect(go('Enter', '.github/workflows/gone.yml')).toEqual({ select: CI });
    expect(go(' ', undefined)).toBeUndefined();
  });

  it('acts from the nearest ancestor the model has for a node it leaves out, and Esc selects that ancestor', () => {
    const hidden = `${LEG20}/steps.unit`;
    expect(go('Escape', hidden)).toEqual({ select: LEG20 });
    expect(go('ArrowDown', hidden)).toEqual({ select: LEG22 });
    expect(go('Escape', `${CI}#build-docs`)).toEqual({ select: CI });
  });
});

describe('the card of a node', () => {
  it('is the job for its legs and steps, the node itself for a job or a workflow, none for a stranger', () => {
    expect(cardOf(model, `${LEG22}/~lint`)).toBe(ci('test'));
    expect(cardOf(model, LEG20)).toBe(ci('test'));
    expect(cardOf(model, ci('deploy'))).toBe(ci('deploy'));
    expect(cardOf(model, CALLEE)).toBe(CALLEE);
    expect(cardOf(model, 'elsewhere.yml')).toBeUndefined();
  });
});
