// @vitest-environment happy-dom
import type { ScenarioInput, Tri } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { type CardState, jobLabel, scopeLabel } from '../src/graph/card';
import { Canvas } from '../src/graph/Canvas';
import { viewport } from '../src/graph/commands';
import type { FlowNode, JobFlowNode, WorkflowFlowNode } from '../src/graph/flow';
import { FLASH_MS } from '../src/graph/highlight';
import { JobNode } from '../src/graph/nodes/JobNode';
import { LegGrid } from '../src/graph/nodes/LegGrid';
import { StepList } from '../src/graph/nodes/StepList';
import { StepStrip } from '../src/graph/nodes/StepStrip';
import { WorkflowNode } from '../src/graph/nodes/WorkflowNode';
import {
  CARD,
  type GraphState,
  type JobModel,
  type LegCell,
  type ScopeModel,
  type StepMark,
} from '../src/graph/types';
import { createSessionStore, initialSessionState, type Pin, type PlanState } from '../src/state/store';

/**
 * The plan index and the canvas keys' answers are other modules': a table of unit paths (a leg's id names its job
 * before the `[`) and a scripted answer stand in for them.
 */
const fake = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  nav: { answer: undefined as object | undefined, asked: [] as string[], from: [] as (string | undefined)[] },
  node: (id: string) =>
    id.includes('[') ? { id, kind: 'leg', parent: id.slice(0, id.indexOf('[')) } : { id },
}));
vi.mock('../src/plan/index', () => ({
  planIndex: () => ({ nodes: new Map(Object.keys(fake.paths).map((id) => [id, fake.node(id)])) }),
  resolveSelection: (_index: unknown, focus: string | undefined, sel: string | undefined) =>
    sel === undefined ? focus : (Object.keys(fake.paths).find((id) => fake.paths[id] === sel) ?? focus),
  selectionOf: (_index: unknown, id: string) => ({ focus: 'ci.yml', sel: fake.paths[id] || undefined }),
}));
vi.mock('../src/graph/navigate', async (original) => ({
  ...(await original<typeof import('../src/graph/navigate')>()),
  createNavigator: () => (key: { key: string }, at: string | undefined) => {
    fake.nav.asked.push(key.key);
    fake.nav.from.push(at);
    return fake.nav.answer;
  },
}));

const CI = 'ci.yml';
const BUILD = 'ci.yml#build';
const TEST = 'ci.yml#test';

function jobOf(over: Partial<JobModel> = {}): JobModel {
  return {
    id: TEST,
    scope: CI,
    jobId: 'test',
    label: 'test',
    verdict: 'yes',
    needs: [],
    steps: [],
    expanded: false,
    ...over,
  };
}

function scopeOf(over: Partial<ScopeModel> = {}): ScopeModel {
  return {
    id: CI,
    path: CI,
    verdict: 'yes',
    clause: 'on: push',
    counts: { yes: 2, no: 0, maybe: 0 },
    depth: 0,
    collapsed: false,
    jobs: [],
    edges: [],
    shape: '',
    ...over,
  };
}

const mark = (id: string, verdict: Tri = 'yes', over: Partial<StepMark> = {}): StepMark => ({
  id,
  label: id.split('/').pop()!,
  verdict,
  inner: [],
  ...over,
});
const leg = (key: string, verdict: Tri = 'yes'): LegCell => ({
  id: `${TEST}[${key}]`,
  legKey: key,
  label: key,
  verdict,
});
const state = (over: Partial<CardState> = {}): CardState => ({ selected: false, hovered: false, ...over });

function jobNode(job: JobModel, s: Partial<CardState> = {}): JobFlowNode {
  return {
    id: job.id,
    type: 'job',
    position: { x: 0, y: 0 },
    width: 240,
    height: 200,
    ariaLabel: jobLabel(job),
    data: { job, needs: [], state: state(s) },
  };
}

function workflowNode(scope: ScopeModel, caller?: string): WorkflowFlowNode {
  return {
    id: scope.id,
    type: 'workflow',
    position: { x: 0, y: 0 },
    width: 600,
    height: scope.collapsed ? 44 : 300,
    ariaLabel: scopeLabel(scope, caller),
    data: { scope, caller, state: state() },
  };
}

function storeOf(
  paths: Record<string, string> = {},
  extra: Partial<ReturnType<typeof initialSessionState>> = {},
) {
  for (const k of Object.keys(fake.paths)) delete fake.paths[k];
  Object.assign(fake.paths, paths);
  return createSessionStore({ ...initialSessionState(), plan: {} as PlanState, focus: CI, ...extra });
}

const TYPES = { job: JobNode, workflow: WorkflowNode };

function withApp(store: ReturnType<typeof storeOf>, children: ReactNode) {
  return (
    <AppProvider app={{ store } as unknown as App}>
      <ReactFlowProvider>
        <div style={{ width: 1000, height: 800 }}>{children}</div>
      </ReactFlowProvider>
    </AppProvider>
  );
}

/**
 * The nodes inside a real React Flow, so handles and toolbars find their node. Clicks inside a flow are plain
 * `click` events: a pointer's `mousedown` reaches d3-zoom, which reads `event.view`, and happy-dom leaves it null.
 */
function mountNodes(nodes: FlowNode[], store = storeOf()) {
  render(withApp(store, <ReactFlow nodes={nodes} edges={[]} nodeTypes={TYPES} nodesDraggable={false} />));
  return store;
}
const click = (el: Element | null) => fireEvent.click(el!);

/** A node by its accessible name, which React Flow's node element carries. */
const card = (name: string) => screen.getByRole('group', { name });
/** The card or frame a node component draws, which the styles key on. */
const drawn = (name: string) => card(name).querySelector<HTMLElement>('.sc-card, .sc-scope')!;

afterEach(() => {
  cleanup();
  fake.nav.answer = undefined;
  fake.nav.asked.length = 0;
  fake.nav.from.length = 0;
});

describe('a job card', () => {
  it('shows a job that runs by its run mark and label, with nothing to explain in its subline', () => {
    mountNodes([jobNode(jobOf())]);
    const root = drawn('runs test');
    expect(root.getAttribute('data-verdict')).toBe('yes');
    expect(within(root).getByRole('img', { name: 'runs' })).toBeTruthy();
    expect(root.querySelector('.sc-card-sub')!.textContent).toBe('');
  });

  it('tells a skipped job by its word and clause in the subline, its matrix size, and keeps its grid as skipped cells', () => {
    const job = jobOf({ verdict: 'no', clause: "if: github.ref == 'refs/heads/main' → false", count: 4 });
    mountNodes([jobNode(job)]);
    const root = drawn("skipped test — if: github.ref == 'refs/heads/main' → false");
    expect(root.getAttribute('data-verdict')).toBe('no');
    expect(within(root).getByText("skipped — if: github.ref == 'refs/heads/main' → false")).toBeTruthy();
    expect(within(root).getByText('×4')).toBeTruthy();
    expect(root.querySelector('[data-leg]')).toBeNull();
    const room = root.querySelector('.sc-legs')!;
    expect(room.getAttribute('aria-hidden')).toBe('true');
    expect(room.querySelectorAll('[data-verdict="no"] > .sc-cell')).toHaveLength(4);
    // The strip's row is kept though the plan has no steps for it.
    expect(root.querySelector<HTMLElement>('div.sc-strip')!.style.height).toBe(`${CARD.stripRow}px`);
  });

  it('keeps one skipped histogram row for a skipped matrix above 512 legs, and no strip row for a call', () => {
    mountNodes([jobNode(jobOf({ verdict: 'no', count: 600, uses: './.github/workflows/t.yml' }))]);
    const root = drawn('skipped test');
    expect(root.querySelector('.sc-legs')!.textContent).toBe('○ 600');
    expect(root.querySelector('.sc-strip')).toBeNull();
  });

  it('makes its step-list toggle a tab stop only while it holds the selection', () => {
    const steps = [mark(`${TEST}/a`)];
    mountNodes([
      jobNode(jobOf({ steps })),
      jobNode(jobOf({ id: BUILD, label: 'build', steps }), { selected: true }),
    ]);
    const toggles = screen.getAllByRole('button', { name: 'Show the steps' });
    expect(toggles.map((b) => b.tabIndex)).toEqual([-1, 0]);
  });

  it('tells a might-run job by its own verdict, its word, and a result only the run knows', () => {
    const job = jobOf({ verdict: 'maybe', clause: 'if: vars.E2E → ?', result: 'success | cancelled' });
    mountNodes([jobNode(job)]);
    const root = drawn('might run test — if: vars.E2E → ?, result success | cancelled');
    expect(root.getAttribute('data-verdict')).toBe('maybe');
    expect(within(root).getByRole('img', { name: 'might run' })).toBeTruthy();
    expect(within(root).getByText('success | cancelled').getAttribute('data-tone')).toBe('unknown');
  });

  it('badges a failure in the danger tone and names the reusable workflow it uses', () => {
    mountNodes([jobNode(jobOf({ result: 'failure', uses: './.github/workflows/t.yml', check: 'Test' }))]);
    const root = card('runs test, result failure');
    expect(within(root).getByText('failure').getAttribute('data-tone')).toBe('danger');
    expect(within(root).getByTitle('uses: ./.github/workflows/t.yml')).toBeTruthy();
    expect(within(root).getByText('Test')).toBeTruthy();
  });

  it('outlines the card that holds the selection', () => {
    mountNodes([jobNode(jobOf(), { selected: true, path: 'on' })]);
    expect(drawn('runs test').getAttribute('data-selected')).toBe('self');
    expect(drawn('runs test').getAttribute('data-path')).toBe('on');
  });

  it('carries the flash of a pin that changed it, and none otherwise', () => {
    mountNodes([jobNode(jobOf(), { flash: 'b' }), jobNode(jobOf({ id: BUILD, label: 'build' }))]);
    expect(drawn('runs test').getAttribute('data-flash')).toBe('b');
    expect(drawn('runs build').hasAttribute('data-flash')).toBe(false);
  });

  it('opens its step list with the toggle, without selecting the job', () => {
    const store = mountNodes([jobNode(jobOf({ steps: [mark(`${TEST}/a`)] }))], storeOf({ [TEST]: 'test' }));
    click(screen.getByRole('button', { name: 'Show the steps' }));
    expect(store.getState().ui.expanded).toEqual([TEST]);
    expect(store.getState().sel).toBeUndefined();
  });

  it('selects a step from the strip', () => {
    const steps = [mark(`${TEST}/a`), mark(`${TEST}/b`, 'no')];
    const store = mountNodes([jobNode(jobOf({ steps }))], storeOf({ [`${TEST}/b`]: 'test/b' }));
    click(document.querySelector(`[data-step="${TEST}/b"]`));
    expect(store.getState().sel).toBe('test/b');
  });

  it('lists its steps when open, and selects the row clicked', () => {
    const steps = [mark(`${TEST}/a`, 'yes', { outputs: 'changed=true' }), mark(`${TEST}/b`, 'maybe')];
    const job = jobOf({ steps, expanded: true });
    const store = mountNodes([jobNode(job)], storeOf({ [`${TEST}/a`]: 'test/a' }));
    expect(screen.getByRole('button', { name: 'Hide the steps' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('changed=true')).toBeTruthy();
    expect(document.querySelectorAll('.sc-list li')).toHaveLength(2);
    click(screen.getByText('a'));
    expect(store.getState().sel).toBe('test/a');
  });

  it('makes the leg clicked the representative and selects it', () => {
    const legs = [leg('node=20'), leg('node=22', 'maybe')];
    const job = jobOf({ legs, representative: legs[0]!.id, count: 2 });
    const store = mountNodes([jobNode(job)], storeOf({ [legs[1]!.id]: 'test[node=22]' }));
    click(document.querySelector(`[data-leg="${legs[1]!.id}"]`));
    expect(store.getState().ui.representative).toEqual({ [TEST]: legs[1]!.id });
    expect(store.getState().sel).toBe('test[node=22]');
  });
});

describe('a workflow', () => {
  it("shows its title bar: the mark, the name and path, its jobs' counts and who calls it", () => {
    const scope = scopeOf({
      id: `${BUILD}>build.yml`,
      path: 'build.yml',
      name: 'Build',
      depth: 1,
      caller: BUILD,
      counts: { yes: 4, no: 1, maybe: 2 },
    });
    mountNodes([workflowNode(scope, 'build')]);
    const root = card('runs Build — on: push, called by build');
    expect(within(root).getByText('Build')).toBeTruthy();
    expect(within(root).getByText('build.yml')).toBeTruthy();
    expect(within(root).getByText('4 runs, 1 skipped, 2 might run')).toBeTruthy();
    expect(within(root).getByText('called by build')).toBeTruthy();
    expect(within(root).queryByRole('button')).toBeNull();
  });

  it('shows an untriggered workflow as one line with its clause, and nothing to open', () => {
    mountNodes([
      workflowNode(
        scopeOf({
          id: 'release.yml',
          path: 'release.yml',
          verdict: 'no',
          clause: 'no on: push',
          collapsed: true,
        }),
      ),
    ]);
    const root = drawn('skipped release.yml — no on: push');
    expect(root.getAttribute('data-collapsed')).toBe('true');
    expect(within(root).getByText('no on: push')).toBeTruthy();
    expect(within(root).queryByRole('button')).toBeNull();
  });

  it('opens a closed callee past depth 2 with a click on it or on its Open button', () => {
    const id = `${BUILD}>a.yml#x>b.yml#y>c.yml`;
    const scope = scopeOf({ id, path: 'c.yml', depth: 3, caller: BUILD, collapsed: true });
    const store = mountNodes([workflowNode(scope, 'y')]);
    click(screen.getByText('c.yml'));
    expect(store.getState().ui.opened).toEqual([id]);
    click(screen.getByRole('button', { name: 'Open' }));
    expect(store.getState().ui.opened).toEqual([]);
  });

  it('closes an opened deep callee with its Close button', () => {
    const id = `${BUILD}>c.yml`;
    const scope = scopeOf({ id, path: 'c.yml', depth: 3, caller: BUILD });
    const store = mountNodes([workflowNode(scope, 'build')]);
    store.getState().toggleOpened(id);
    click(screen.getByRole('button', { name: 'Close' }));
    expect(store.getState().ui.opened).toEqual([]);
  });
});

/** A plain component inside the provider, as a node draws it. */
function mountPlain(children: ReactNode) {
  render(withApp(storeOf(), children));
  return userEvent.setup();
}

describe('the leg grid', () => {
  it('draws a cell per leg with its values and a title naming its verdict and result', () => {
    const legs = [leg('node=20'), { ...leg('node=22', 'no'), result: 'cancelled' }];
    mountPlain(<LegGrid legs={legs} onPick={() => {}} />);
    const cells = document.querySelectorAll('[data-leg]');
    expect(cells).toHaveLength(2);
    expect(cells[1]!.getAttribute('data-verdict')).toBe('no');
    expect(cells[1]!.querySelector('title')!.textContent).toBe('node=22: skipped, result cancelled');
    expect(cells[0]!.querySelector('text')!.textContent).toBe('node=20');
  });

  it('draws a mark and an index in each cell above 48 legs', () => {
    const legs = Array.from({ length: 60 }, (_, i) => leg(`n=${i}`, i % 2 ? 'maybe' : 'yes'));
    mountPlain(<LegGrid legs={legs} onPick={() => {}} />);
    const cells = document.querySelectorAll('[data-leg]');
    expect(cells).toHaveLength(60);
    expect(cells[1]!.querySelector('text')!.textContent).toBe('2');
    expect(cells[1]!.querySelector('.sc-glyph-half')).not.toBeNull();
    expect(cells[0]!.querySelector('.sc-glyph-half')).toBeNull();
  });

  it('draws one histogram row above 512 legs', () => {
    const legs = Array.from({ length: 600 }, (_, i) => leg(`n=${i}`, i < 450 ? 'yes' : 'no'));
    mountPlain(<LegGrid legs={legs} onPick={() => {}} />);
    expect(document.querySelectorAll('[data-leg]')).toHaveLength(0);
    expect(screen.getByRole('img', { name: '600 legs: 450 runs, 150 skipped, 0 might run' })).toBeTruthy();
  });

  it('marks the representative and the selected leg, and picks the cell clicked', async () => {
    const legs = [leg('a'), leg('b'), leg('c')];
    const onPick = vi.fn();
    const user = mountPlain(
      <LegGrid legs={legs} representative={legs[0]!.id} selected={legs[2]!.id} onPick={onPick} />,
    );
    const cells = document.querySelectorAll('[data-leg]');
    expect(cells[0]!.getAttribute('data-representative')).toBe('true');
    expect(cells[0]!.querySelector('.sc-rep')).not.toBeNull();
    expect(cells[2]!.getAttribute('data-selected')).toBe('true');
    await user.click(cells[1]!);
    expect(onPick).toHaveBeenCalledWith(legs[1]!.id);
  });
});

describe('the step strip', () => {
  it('draws a mark per step, each named by its step and verdict, and picks the one clicked', async () => {
    const steps = [mark(`${TEST}/checkout`), mark(`${TEST}/lint`, 'no'), mark(`${TEST}/deploy`, 'maybe')];
    const onPick = vi.fn();
    const user = mountPlain(<StepStrip steps={steps} width={224} selected={steps[1]!.id} onPick={onPick} />);
    expect(screen.getAllByRole('img').map((m) => m.getAttribute('aria-label'))).toEqual([
      'checkout: runs',
      'lint: skipped',
      'deploy: might run',
    ]);
    expect(document.querySelector(`[data-step="${TEST}/lint"]`)!.getAttribute('data-selected')).toBe('true');
    await user.click(document.querySelector(`[data-step="${TEST}/deploy"]`)!);
    expect(onPick).toHaveBeenCalledWith(`${TEST}/deploy`);
  });
});

describe('the step list', () => {
  it('indents a composite action’s inner steps and shows each step’s outputs', () => {
    const steps = [
      mark(`${TEST}/setup`, 'yes', { inner: [mark(`${TEST}/setup>inner`, 'maybe')] }),
      mark(`${TEST}/b`),
    ];
    mountPlain(<StepList steps={steps} onPick={() => {}} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.style.paddingLeft)).toEqual(['0px', '12px', '0px']);
    expect(within(rows[1]!).getByRole('img', { name: 'might run' })).toBeTruthy();
  });

  it('stops at 40 rows and counts the rest', () => {
    const steps = Array.from({ length: 45 }, (_, i) => mark(`${TEST}/s${i}`));
    mountPlain(<StepList steps={steps} onPick={() => {}} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(41);
    expect(screen.getByText('+5')).toBeTruthy();
  });

  it('picks the row clicked', async () => {
    const onPick = vi.fn();
    const user = mountPlain(<StepList steps={[mark(`${TEST}/a`), mark(`${TEST}/b`)]} onPick={onPick} />);
    await user.click(screen.getByText('b'));
    expect(onPick).toHaveBeenCalledWith(`${TEST}/b`);
  });
});

/** ci.yml: build → test. */
function graphOf(): GraphState {
  const build = jobOf({ id: BUILD, jobId: 'build', label: 'build' });
  const test = jobOf({ needs: [BUILD], steps: [mark(`${TEST}/a`)] });
  return {
    model: {
      roots: [CI],
      scopes: {
        [CI]: scopeOf({
          jobs: [BUILD, TEST],
          edges: [{ id: `${BUILD}->${TEST}`, source: BUILD, target: TEST, from: 'yes', deciding: false }],
        }),
      },
      jobs: { [BUILD]: build, [TEST]: test },
    },
    layout: {
      roots: { [CI]: { x: 0, y: 0, width: 500, height: 160 } },
      scopes: {
        [CI]: {
          width: 500,
          height: 160,
          positions: { [BUILD]: { x: 16, y: 40 }, [TEST]: { x: 260, y: 40 } },
        },
      },
      cards: { [BUILD]: { width: 200, height: 64 }, [TEST]: { width: 200, height: 78 } },
    },
    for: { files: 1, project: 1 },
  };
}

const ORIGIN = 'translate(0px,0px) scale(1)';
const transform = (): string => document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform;
const scaleOf = (t: string): number => Number(/scale\(([\d.]+)\)/.exec(t)![1]);
/** A few animation frames, for React Flow's queued fit to run. */
const frames = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));

/** A plan the store holds, with its own `for`, as the session hands one to the store and the graph. */
const answeredPlan = (): PlanState =>
  ({ plan: { unknowns: [] }, for: { files: 1, project: 1 } }) as unknown as PlanState;

/** A pin the plan answered, which changed the verdicts of `changed`. */
const pinOf = (seq: number, plan: PlanState, changed: string[]): Pin => ({
  seq,
  scenario: {} as ScenarioInput,
  assume: [],
  after: {
    plan: plan.plan,
    changes: changed.map((id) => ({ id, kind: 'job', from: 'no', to: 'yes', label: id })),
    sentence: 'pinned; test now runs',
  },
});

function mountCanvas(paths: Record<string, string> = {}) {
  const store = storeOf(paths, { graph: graphOf() });
  render(withApp(store, <Canvas />));
  return store;
}

describe('the canvas', () => {
  it('says what it waits for until the first graph is committed', () => {
    render(withApp(storeOf(), <Canvas />));
    expect(screen.getByText('Laying out the graph…')).toBeTruthy();
  });

  it("draws the committed graph's workflow and job cards, named for a screen reader", () => {
    mountCanvas();
    expect(card('runs ci.yml — on: push')).toBeTruthy();
    expect(card('runs build')).toBeTruthy();
    expect(card('runs test, needs build')).toBeTruthy();
  });

  it('selects a card on a click and the focused workflow on a click on the pane', () => {
    const store = mountCanvas({ [BUILD]: 'build', [CI]: '' });
    click(card('runs build'));
    expect(store.getState()).toMatchObject({ focus: CI, sel: 'build' });
    expect(drawn('runs build').getAttribute('data-selected')).toBe('self');
    fireEvent.click(document.querySelector('.react-flow__pane')!);
    expect(store.getState().sel).toBeUndefined();
  });

  it('runs what the canvas keys answer, and leaves keys given to a button or held with Meta alone', () => {
    const store = mountCanvas({ [TEST]: 'test' });
    fake.nav.answer = { toggle: TEST };
    fireEvent.keyDown(card('runs test, needs build'), { key: ' ' });
    expect(store.getState().ui.expanded).toEqual([TEST]);
    fake.nav.answer = { select: TEST };
    fireEvent.keyDown(card('runs test, needs build'), { key: 'ArrowRight' });
    expect(store.getState().sel).toBe('test');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Show the steps' }), { key: 'Enter' });
    fireEvent.keyDown(card('runs test, needs build'), { key: 'f', metaKey: true });
    expect(fake.nav.asked).toEqual([' ', 'ArrowRight']);
  });

  it('goes on from the card a key selected when the next key comes before the focus has followed', async () => {
    const store = mountCanvas({ [BUILD]: 'build', [TEST]: 'test' });
    const build = card('runs build');
    fireEvent.focus(build);
    expect(store.getState().sel).toBe('build');
    fake.nav.answer = { select: TEST };
    fireEvent.keyDown(build, { key: 'ArrowRight' });
    expect(store.getState().sel).toBe('test');
    fake.nav.answer = undefined;
    // The focus is still on build: the card the keys moved to has it only from the next frame.
    fireEvent.keyDown(build, { key: 'ArrowDown' });
    expect(fake.nav.from).toEqual([BUILD, TEST]);
    await frames();
    expect(document.activeElement).toBe(card('runs test, needs build'));
    fireEvent.keyDown(card('runs test, needs build'), { key: 'ArrowDown' });
    act(() => store.getState().select(CI, 'build'));
    // Once the focus has followed, a card that lost the selection to the URL is where the keys act from.
    fireEvent.keyDown(card('runs test, needs build'), { key: 'ArrowDown' });
    expect(fake.nav.from).toEqual([BUILD, TEST, TEST, TEST]);
  });

  it('registers the viewport commands while it is mounted, and takes them back after', () => {
    const register = vi.spyOn(viewport, 'register');
    const { unmount } = render(withApp(storeOf({}, { graph: graphOf() }), <Canvas />));
    expect(register).toHaveBeenCalled();
    const commands = register.mock.calls.at(-1)![0];
    expect(() => {
      commands.actualSize();
      commands.centre(`${TEST}/a`);
      commands.centre('nowhere.yml');
    }).not.toThrow();
    const fit = vi.spyOn(commands, 'fit');
    viewport.fit();
    expect(fit).toHaveBeenCalledTimes(1);
    unmount();
    viewport.fit();
    expect(fit).toHaveBeenCalledTimes(1);
    register.mockRestore();
  });

  it('fits the first picture of a project once, under StrictMode too', async () => {
    const store = storeOf({}, { graph: graphOf() });
    render(<StrictMode>{withApp(store, <Canvas />)}</StrictMode>);
    expect(transform()).toBe(ORIGIN);
    await frames();
    expect(transform()).not.toBe(ORIGIN);
  });

  it('opens a picture mounted again where it was left, and fits newly loaded files', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      const store = storeOf({}, { graph: graphOf() });
      const first = render(withApp(store, <Canvas />));
      await frames();
      const fitted = transform();
      act(() => viewport.actualSize());
      const moved = transform();
      expect(moved).not.toBe(fitted);
      first.unmount();
      render(withApp(store, <Canvas />));
      await frames();
      expect(transform()).toBe(moved);
      // A restarted engine numbers the same files' project afresh: the picture stays where it was.
      act(() => store.getState().graphReady({ ...graphOf(), for: { files: 1, project: 2 } }));
      await frames();
      expect(transform()).toBe(moved);
      act(() => store.getState().graphReady({ ...graphOf(), for: { files: 2, project: 2 } }));
      await frames();
      expect(transform()).toBe(fitted);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('selects a card the focus lands on, unless it holds the selection already', () => {
    const store = mountCanvas({ [BUILD]: 'build', [TEST]: 'test', [`${TEST}/a`]: 'test/a', [CI]: '' });
    fireEvent.focus(card('runs build'));
    expect(store.getState().sel).toBe('build');
    act(() => store.getState().select(CI, 'test/a'));
    fireEvent.focus(card('runs test, needs build'));
    expect(store.getState().sel).toBe('test/a');
    // Focus inside a card, on its toggle, is the toggle's.
    fireEvent.focus(screen.getByRole('button', { name: 'Show the steps' }));
    expect(store.getState().sel).toBe('test/a');
  });

  it('makes the card that holds the selection the one tab stop among the cards', () => {
    const store = mountCanvas({ [BUILD]: 'build', [CI]: '' });
    const stops = () => document.querySelectorAll('.react-flow__node[tabindex="0"]');
    expect([...stops()].map((n) => n.getAttribute('data-id'))).toEqual([CI]);
    act(() => store.getState().select(CI, 'build'));
    expect([...stops()].map((n) => n.getAttribute('data-id'))).toEqual([BUILD]);
  });

  it('zooms about the pointer at once on a double-click when the author asked for less motion', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      mountCanvas();
      await frames();
      const before = scaleOf(transform());
      fireEvent.doubleClick(document.querySelector('.react-flow__pane')!, { clientX: 100, clientY: 80 });
      expect(scaleOf(transform())).toBeCloseTo(Math.min(2, before * 2));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fades every card but the ones a hovered unknown affects, and the needs with an end it does not', () => {
    const graph = graphOf();
    const plan = { plan: { unknowns: [{ id: 'u', affects: [`${TEST}/a`] }] }, for: graph.for };
    const store = storeOf({}, { graph, plan: plan as unknown as PlanState });
    render(withApp(store, <Canvas />));
    const paths = () =>
      ['runs ci.yml — on: push', 'runs build', 'runs test, needs build'].map((n) =>
        drawn(n).getAttribute('data-path'),
      );
    expect(paths()).toEqual([null, null, null]);
    act(() => store.getState().hoverUnknown('u'));
    expect(paths()).toEqual(['on', 'off', 'on']);
    expect(document.querySelector('.sc-edge')?.getAttribute('data-path')).toBe('off');
    act(() => store.getState().hoverUnknown(undefined));
    expect(paths()).toEqual([null, null, null]);
  });

  it("flashes the cards a pin changed once its plan's picture is on the canvas, and again for the next pin", () => {
    vi.useFakeTimers();
    try {
      const store = storeOf({}, { graph: graphOf() });
      render(withApp(store, <Canvas />));
      const flash = () => drawn('runs test, needs build').getAttribute('data-flash');
      const first = answeredPlan();
      act(() => store.setState({ plan: first, pin: pinOf(3, first, [TEST]) }));
      // The picture is still the plan's before the pin: its cards do not flash in their old colours.
      expect(flash()).toBeNull();
      act(() => store.getState().graphReady({ ...graphOf(), for: first.for }));
      expect(flash()).toBe('b');
      expect(drawn('runs build').hasAttribute('data-flash')).toBe(false);
      act(() => {
        vi.advanceTimersByTime(FLASH_MS);
      });
      expect(flash()).toBeNull();
      const next = answeredPlan();
      act(() => store.setState({ plan: next, pin: pinOf(4, next, [TEST]) }));
      act(() => store.getState().graphReady({ ...graphOf(), for: next.for }));
      expect(flash()).toBe('a');
      // A plan without a pin ends it.
      act(() => store.setState({ plan: answeredPlan() }));
      expect(flash()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not play a flash again on a picture mounted again', () => {
    vi.useFakeTimers();
    try {
      const plan = answeredPlan();
      const store = storeOf(
        {},
        { graph: { ...graphOf(), for: plan.for }, plan, pin: pinOf(6, plan, [TEST]) },
      );
      const first = render(withApp(store, <Canvas />));
      expect(drawn('runs test, needs build').getAttribute('data-flash')).toBe('a');
      act(() => {
        vi.advanceTimersByTime(FLASH_MS);
      });
      first.unmount();
      render(withApp(store, <Canvas />));
      expect(drawn('runs test, needs build').hasAttribute('data-flash')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flashes nothing for an author who asked for less motion', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    try {
      const plan = answeredPlan();
      const store = storeOf(
        {},
        { graph: { ...graphOf(), for: plan.for }, plan, pin: pinOf(5, plan, [TEST]) },
      );
      render(withApp(store, <Canvas />));
      expect(document.querySelector('[data-flash]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens the hover card 300 ms after the pointer settles on a job', () => {
    vi.useFakeTimers();
    try {
      mountCanvas();
      const node = card('runs test, needs build');
      fireEvent.mouseEnter(node);
      expect(screen.queryByText('needs: build')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getByText('needs: build')).toBeTruthy();
      fireEvent.mouseLeave(node);
      expect(screen.queryByText('needs: build')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
