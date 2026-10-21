// @vitest-environment happy-dom
import { type NodeId, simulate } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { type Gestures, gestures } from '../src/edit/gestures';
import type { IndexedNode, PlanIndex } from '../src/plan/index';
import { OutlineTree } from '../src/panels/OutlineTree';
import {
  openedFor,
  outlineModel,
  planLabels,
  tabStop,
  toggled,
  type TreeKey,
  treeKey,
  visibleRows,
} from '../src/panels/outline-tree';
import { createSessionStore, initialSessionState, type PlanState } from '../src/state/store';
import { deriveTables } from '../src/worker/derived';

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const CALLEE = `${CI}#call>.github/workflows/reusable.yml`;

const files = {
  [CI]: `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Compile
        run: make
      - uses: ./.github/actions/setup
  test:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - name: Unit
        run: npm test
  call:
    uses: ./.github/workflows/reusable.yml
`,
  '.github/workflows/reusable.yml':
    'on: workflow_call\njobs:\n  inner:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
  [RELEASE]:
    'name: Release\non: release\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo }]\n',
  '.github/actions/setup/action.yml':
    'name: Setup\nruns:\n  using: composite\n  steps:\n    - name: Install\n      run: npm ci\n      shell: bash\n',
};

function planState(): PlanState {
  const plan = simulate({ files, scenario: { event: 'push' }, assume: [], detail: 'steps' });
  const derived = deriveTables(plan, { files: [], workflows: [], events: {} });
  return { plan, derived, text: '', ms: { simulate: 0, derive: 0 }, for: { files: 1, epoch: 1, project: 1 } };
}

/** A small index by hand: ci.yml with a job, its step using a composite action, and an untriggered release.yml. */
function handIndex(): PlanIndex {
  const nodes: IndexedNode[] = [
    { id: CI, kind: 'workflow', verdict: 'yes', workflow: CI },
    { id: `${CI}#build`, kind: 'job', parent: CI, verdict: 'yes', workflow: CI, unitPath: 'build' },
    {
      id: `${CI}#build/~a`,
      kind: 'step',
      parent: `${CI}#build`,
      verdict: 'yes',
      workflow: CI,
      unitPath: 'build.#1',
    },
    { id: `${CI}#build/~a>x`, kind: 'composite', parent: `${CI}#build/~a`, verdict: 'yes', workflow: CI },
    { id: `${CI}#build/~a>x/~in`, kind: 'step', parent: `${CI}#build/~a>x`, verdict: 'maybe', workflow: CI },
    { id: `${CI}#lint`, kind: 'job', parent: CI, verdict: 'no', workflow: CI, unitPath: 'lint' },
    { id: RELEASE, kind: 'workflow', verdict: 'no', workflow: RELEASE },
  ];
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    affectedBy: new Map(),
    checks: [],
    byPath: new Map(),
  };
}

const labels = new Map([
  [CI, 'CI'],
  [`${CI}#build`, 'build'],
]);

const ids = (rows: { node: { id: NodeId } }[]) => rows.map((r) => r.node.id);

describe('the outline model', () => {
  it('hangs a composite action’s inner steps under the step that uses it, and labels by the plan', () => {
    const model = outlineModel(handIndex(), labels);
    expect(model.roots).toEqual([CI, RELEASE]);
    expect(model.nodes.get(CI)!.children).toEqual([`${CI}#build`, `${CI}#lint`]);
    expect(model.nodes.get(`${CI}#build/~a`)!.children).toEqual([`${CI}#build/~a>x/~in`]);
    expect(model.nodes.has(`${CI}#build/~a>x`)).toBe(false);
    expect(model.nodes.get(`${CI}#build/~a>x/~in`)!.parent).toBe(`${CI}#build/~a`);
    expect([CI, `${CI}#lint`, `${CI}#build/~a>x/~in`].map((id) => model.nodes.get(id)!.label)).toEqual([
      'CI',
      'lint',
      `${CI}#build/~a>x/~in`,
    ]);
  });

  it('labels each node as the canvas does, callees and composite steps included', () => {
    const l = planLabels(planState().plan);
    expect(l.get(CI)).toBe('CI');
    expect(l.get(`${CI}#build/~actions-checkout`)).toBe('actions/checkout@v4');
    expect(l.get(`${CI}#build/~compile`)).toBe('Compile');
    expect(l.get(`${CI}#build/~github-actions-setup>.github/actions/setup/~install`)).toBe('Install');
    expect(l.get(`${CI}#test[node=20]`)).toBe('node=20');
    expect(l.get(CALLEE)).toBe('.github/workflows/reusable.yml');
    expect(l.get(`${CALLEE}#inner`)).toBe('inner');
  });
});

describe('the rows', () => {
  const model = outlineModel(handIndex(), labels);

  it('shows the children of open nodes only, with their level and place in their set', () => {
    const rows = visibleRows(model, new Set([CI]));
    expect(ids(rows)).toEqual([CI, `${CI}#build`, `${CI}#lint`, RELEASE]);
    expect(rows.map((r) => [r.level, r.posinset, r.setsize, r.expanded])).toEqual([
      [1, 1, 2, true],
      [2, 1, 2, false],
      [2, 2, 2, undefined],
      [1, 2, 2, undefined],
    ]);
    expect(ids(visibleRows(model, new Set([CI, `${CI}#build`, `${CI}#build/~a`])))).toContain(
      `${CI}#build/~a>x/~in`,
    );
  });

  it('leaves untriggered workflows out when the canvas hides them', () => {
    expect(ids(visibleRows(model, new Set(), true))).toEqual([CI]);
  });

  it('opens the ancestors of a selection and a selected workflow, keeping the set when none is missing', () => {
    const open = openedFor(new Set(), model, `${CI}#build/~a>x/~in`);
    expect([...open].sort()).toEqual([CI, `${CI}#build`, `${CI}#build/~a`].sort());
    expect(openedFor(open, model, `${CI}#build`)).toBe(open);
    expect([...openedFor(new Set(), model, RELEASE)]).toEqual([RELEASE]);
    const none = new Set<NodeId>();
    expect(openedFor(none, model, undefined)).toBe(none);
    expect(openedFor(none, model, 'gone.yml')).toBe(none);
    expect([...toggled(toggled(none, CI), CI)]).toEqual([]);
  });

  it('puts the one tab stop on the row the keys reached, else the selection, else the first row', () => {
    const rows = visibleRows(model, new Set([CI]));
    expect(tabStop(rows, `${CI}#lint`, `${CI}#build`)).toBe(`${CI}#lint`);
    expect(tabStop(rows, `${CI}#build/~a`, `${CI}#build`)).toBe(`${CI}#build`);
    expect(tabStop(rows, undefined, `${CI}#build/~a`)).toBe(CI);
    expect(tabStop([], undefined, undefined)).toBeUndefined();
  });
});

describe('the tree keys', () => {
  const model = outlineModel(handIndex(), labels);
  const rows = visibleRows(model, new Set([CI]));
  const press = (key: string, at: NodeId | undefined, mods: Partial<TreeKey> = {}) =>
    treeKey({ key, altKey: false, ctrlKey: false, metaKey: false, ...mods }, at, rows);

  it('moves through the visible rows with ↓ ↑ Home End, stopping at either end', () => {
    expect(press('ArrowDown', CI)).toEqual({ focus: `${CI}#build` });
    expect(press('ArrowUp', `${CI}#lint`)).toEqual({ focus: `${CI}#build` });
    expect(press('ArrowUp', CI)).toBeUndefined();
    expect(press('ArrowDown', RELEASE)).toBeUndefined();
    expect(press('Home', `${CI}#lint`)).toEqual({ focus: CI });
    expect(press('End', CI)).toEqual({ focus: RELEASE });
  });

  it('opens with → then goes to the first child, closes with ← then goes to the parent', () => {
    expect(press('ArrowRight', `${CI}#build`)).toEqual({ open: `${CI}#build` });
    expect(press('ArrowRight', CI)).toEqual({ focus: `${CI}#build` });
    expect(press('ArrowRight', `${CI}#lint`)).toBeUndefined();
    expect(press('ArrowLeft', CI)).toEqual({ close: CI });
    expect(press('ArrowLeft', `${CI}#build`)).toEqual({ focus: CI });
    expect(press('ArrowLeft', RELEASE)).toBeUndefined();
  });

  it('selects with Enter, starts at the first row from nowhere, and leaves other keys and combinations alone', () => {
    expect(press('Enter', `${CI}#lint`)).toEqual({ select: `${CI}#lint` });
    expect(press('ArrowDown', 'gone')).toEqual({ focus: CI });
    expect(press('ArrowLeft', `${CI}#build`, { altKey: true })).toBeUndefined();
    expect(press('Home', CI, { ctrlKey: true })).toBeUndefined();
    expect(press('t', CI)).toBeUndefined();
  });
});

describe('the outline tree', () => {
  afterEach(cleanup);

  function mount(options: { plan?: boolean; hide?: boolean } = {}) {
    const initial = initialSessionState();
    const store = createSessionStore({
      ...initial,
      ...(options.plan === false ? {} : { plan: planState() }),
      focus: CI,
      ui: { ...initial.ui, hideUntriggered: options.hide ?? false },
    });
    render(
      <AppProvider app={{ store } as unknown as App}>
        <button type="button">Elsewhere</button>
        <OutlineTree />
      </AppProvider>,
    );
    return { store, user: userEvent.setup() };
  }

  const item = (name: string) => screen.getByRole('treeitem', { name });
  const names = () => screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'));

  it('shows the focused workflow open with its jobs, each with its mark, level and place in its set', () => {
    mount();
    expect(screen.getByRole('tree', { name: 'Outline' })).toBeTruthy();
    expect(names()).toEqual([
      'CI, runs',
      'build, runs',
      'test, runs',
      'call, runs',
      'Release, skipped',
      '.github/workflows/reusable.yml, skipped',
    ]);
    const ci = item('CI, runs');
    expect([
      ci.getAttribute('aria-level'),
      ci.getAttribute('aria-expanded'),
      ci.getAttribute('aria-selected'),
    ]).toEqual(['1', 'true', 'true']);
    const test = item('test, runs');
    expect(
      ['aria-level', 'aria-posinset', 'aria-setsize', 'aria-expanded'].map((a) => test.getAttribute(a)),
    ).toEqual(['2', '2', '3', 'false']);
    expect(item('Release, skipped').hasAttribute('aria-expanded')).toBe(false);
    expect(ci.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('runs');
  });

  it('selects a row on a click or Enter, through the focus and unit path the canvas uses', async () => {
    const { store, user } = mount();
    await user.click(item('build, runs'));
    expect([store.getState().focus, store.getState().sel]).toEqual([CI, 'build']);
    expect(item('build, runs').getAttribute('aria-selected')).toBe('true');
    expect(item('CI, runs').getAttribute('aria-selected')).toBe('false');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(store.getState().sel).toBe('test');
    expect(document.activeElement).toBe(item('test, runs'));
  });

  it('walks the rows with ↓ ↑ Home End, opens and goes in with →, closes and goes up with ←', async () => {
    const { user } = mount();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(item('CI, runs'));
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(item('build, runs').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(item('build, runs'));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(item('actions/checkout@v4, runs'));
    await user.keyboard('{End}{ArrowLeft}');
    expect(document.activeElement).toBe(item('.github/workflows/reusable.yml, skipped'));
    await user.keyboard('{Home}{ArrowLeft}');
    expect(names()).toEqual(['CI, runs', 'Release, skipped', '.github/workflows/reusable.yml, skipped']);
    expect(screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0)).toEqual([item('CI, runs')]);
  });

  it('opens down to a selection made elsewhere and moves the tab stop there, never the focus', () => {
    const { store } = mount();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    act(() => store.getState().select(CI, 'build.#3/#1'));
    const install = item('Install, runs');
    expect(install.getAttribute('aria-selected')).toBe('true');
    expect(install.getAttribute('aria-level')).toBe('4');
    expect(install.tabIndex).toBe(0);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('selects a called workflow through the leg that calls it', async () => {
    const { store, user } = mount();
    await user.click(item('call, runs').querySelector('[data-disclosure]')!);
    await user.click(item('.github/workflows/reusable.yml, runs'));
    expect(store.getState().sel).toBe('call');
    expect(item('call, runs').getAttribute('aria-selected')).toBe('true');
  });

  it('leaves Alt+← to the browser', () => {
    mount();
    expect(fireEvent.keyDown(item('build, runs'), { key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(fireEvent.keyDown(item('build, runs'), { key: 'ArrowLeft' })).toBe(false);
  });

  it('opens and closes a row from its disclosure without selecting it', async () => {
    const { store, user } = mount();
    await user.click(item('test, runs').querySelector('[data-disclosure]')!);
    expect(item('test, runs').getAttribute('aria-expanded')).toBe('true');
    expect(store.getState().sel).toBeUndefined();
  });

  it('opens a row’s actions in edit mode from the context menu key, Shift+F10 or a right click, at the row', () => {
    const { store } = mount();
    const asked: [NodeId, Element][] = [];
    const unregister = gestures.register(store, {
      menu: (node: NodeId, at: HTMLElement) => asked.push([node, at]) > 0,
    } as unknown as Gestures);
    // Outside edit mode the browser keeps its own menu.
    expect(fireEvent.contextMenu(item('build, runs'))).toBe(true);
    expect(fireEvent.keyDown(item('CI, runs'), { key: 'ContextMenu' })).toBe(true);
    act(() => store.getState().setEdit(true));
    expect(fireEvent.contextMenu(item('build, runs'))).toBe(false);
    expect(fireEvent.keyDown(item('build, runs'), { key: 'F10', shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(item('build, runs'), { key: 'ContextMenu' })).toBe(false);
    expect(asked.map(([node, at]) => [node, at.getAttribute('aria-label')])).toEqual([
      [`${CI}#build`, 'build, runs'],
      [`${CI}#build`, 'build, runs'],
      [`${CI}#build`, 'build, runs'],
    ]);
    unregister();
  });

  it('hides untriggered workflows when the canvas does, and shows nothing before a plan', () => {
    mount({ hide: true });
    expect(names()).toEqual(['CI, runs', 'build, runs', 'test, runs', 'call, runs']);
    cleanup();
    mount({ plan: false });
    expect(screen.queryByRole('tree')).toBeNull();
  });
});
