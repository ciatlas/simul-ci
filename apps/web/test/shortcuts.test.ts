// @vitest-environment happy-dom
import type { NodeId } from '@simulci/engine';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { installShortcuts, isNarrow, keyFor, type PageKey, shownView } from '../src/app/shortcuts';
import { ViewToggle } from '../src/app/ViewToggle';
import { viewport } from '../src/graph/commands';
import type { GraphState, JobModel, ScopeModel } from '../src/graph/types';
import { createSessionStore, type PlanState, type SessionStore } from '../src/state/store';

const ids = vi.hoisted(() => {
  const CI = '.github/workflows/ci.yml';
  return { CI, BUILD: `${CI}#build`, STEP: `${CI}#build/~compile` };
});

/** The index's selection, as plan/index.ts resolves it, for the two unit paths these tests select. */
vi.mock('../src/plan/index', () => ({
  planIndex: () => ({}),
  resolveSelection: (_index: unknown, focus?: string, sel?: string): string | undefined =>
    sel === undefined
      ? focus
      : (({ build: ids.BUILD, 'build.#2': ids.STEP } as Record<string, string>)[sel] ?? sel),
}));

const { CI, BUILD, STEP } = ids;

const base: PageKey = {
  key: '',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  target: null,
};
const page = (key: string, more: Partial<PageKey> = {}) => keyFor({ ...base, key, ...more });

describe('the page keys', () => {
  it('takes t, f, . and 0 as the page’s commands, and nothing else', () => {
    expect(['t', 'f', '.', '0'].map((k) => page(k))).toEqual(['view', 'fit', 'centre', 'actualSize']);
    expect(['r', '1', '2', '3', '4', '[', ']', '\\'].map((k) => page(k))).toEqual([
      'reasons',
      'panel:reasons',
      'panel:unknowns',
      'panel:node',
      'panel:problems',
      'pane:left',
      'pane:right',
      'pane:yaml',
    ]);
    expect(page('T')).toBeUndefined();
    expect(page('x')).toBeUndefined();
    expect(page('constructor')).toBeUndefined();
  });

  it('leaves a key alone once something on the way handled it, and with Alt, Ctrl, Meta or an IME composing', () => {
    expect(page('t', { defaultPrevented: true })).toBeUndefined();
    expect(page('f', { ctrlKey: true })).toBeUndefined();
    expect(page('0', { metaKey: true })).toBeUndefined();
    expect(page('t', { altKey: true })).toBeUndefined();
    expect(page('f', { isComposing: true })).toBeUndefined();
  });

  it('never fires while the author types in a field, an editable region or the YAML pane, nor in a dialog', () => {
    document.body.innerHTML = `
      <input id="input"><textarea id="textarea"></textarea><select id="select"></select>
      <div contenteditable="true"><span id="inside">x</span></div>
      <div contenteditable="false"><span id="frozen">x</span></div>
      <div class="cm-editor"><div id="yaml">on: push</div></div>
      <div role="dialog"><button id="paste">Paste</button></div>
      <button id="button">b</button><div role="tree"><div role="treeitem" id="item">build</div></div>`;
    const at = (id: string) => page('t', { target: document.getElementById(id) });
    expect(['input', 'textarea', 'select', 'inside', 'yaml', 'paste'].map(at)).toEqual(
      Array(6).fill(undefined),
    );
    expect(['frozen', 'button', 'item'].map(at)).toEqual(['view', 'view', 'view']);
    expect(page('t', { target: window })).toBe('view');
    document.body.innerHTML = '';
  });
});

const scope = (id: NodeId, jobs: NodeId[]): ScopeModel => ({
  id,
  path: id,
  verdict: 'yes',
  clause: '',
  counts: { yes: jobs.length, no: 0, maybe: 0 },
  depth: 0,
  collapsed: false,
  jobs,
  edges: [],
  shape: '',
});

const build: JobModel = {
  id: BUILD,
  scope: CI,
  jobId: 'build',
  label: 'build',
  verdict: 'yes',
  needs: [],
  steps: [{ id: STEP, label: 'Compile', verdict: 'yes', inner: [] }],
  expanded: false,
};

const graph: GraphState = {
  model: { roots: [CI], scopes: { [CI]: scope(CI, [BUILD]) }, jobs: { [BUILD]: build } },
  layout: { scopes: {}, roots: {}, cards: {} },
  for: { files: 1, project: 1 },
};

describe('the page key listener', () => {
  let store: SessionStore;
  let win: EventTarget & { innerWidth: number };
  let calls: string[];
  let stop: () => void;
  let unregister: () => void;

  beforeEach(() => {
    store = createSessionStore();
    win = Object.assign(new EventTarget(), { innerWidth: 1280 });
    stop = installShortcuts(store, win as unknown as Window);
    calls = [];
    unregister = viewport.register({
      fit: () => calls.push('fit'),
      centre: (node) => calls.push(`centre ${node}`),
      actualSize: () => calls.push('actualSize'),
    });
  });
  afterEach(() => {
    stop();
    unregister();
  });

  /** Whether the key went on unhandled, as `dispatchEvent` says. */
  const press = (key: string): boolean =>
    win.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));

  it('switches between the graph and the text with t, and has nothing to switch below 1024 px', () => {
    expect(press('t')).toBe(false);
    expect(store.getState().ui.view).toBe('text');
    press('t');
    expect(store.getState().ui.view).toBe('graph');
    win.innerWidth = 800;
    expect(press('t')).toBe(true);
    expect(store.getState().ui.view).toBe('graph');
  });

  it('fits and shows 100 % through the canvas’s viewport commands', () => {
    expect([press('f'), press('0')]).toEqual([false, false]);
    expect(calls).toEqual(['fit', 'actualSize']);
  });

  it('centres the card that shows the selection, and the focused workflow when nothing is selected', () => {
    store.setState({ plan: { plan: {} } as PlanState, graph });
    store.getState().select(CI, 'build.#2');
    press('.');
    store.getState().select(CI, undefined);
    press('.');
    expect(calls).toEqual([`centre ${BUILD}`, `centre ${CI}`]);
  });

  it('leaves . unhandled before the canvas has a picture, or for a selection it does not show', () => {
    store.getState().select(CI, 'build');
    expect(press('.')).toBe(true);
    store.setState({ plan: { plan: {} } as PlanState, graph });
    store.getState().select(CI, 'deploy');
    expect(press('.')).toBe(true);
    expect(calls).toEqual([]);
  });

  it('opens a tab of the right panel with 1 to 4, opening the panel when it is closed', () => {
    store.getState().togglePane('right');
    expect(press('2')).toBe(false);
    expect(store.getState().ui.prefs.panel).toBe('unknowns');
    expect(store.getState().ui.prefs.collapsed.right).toBe(false);
    press('4');
    expect(store.getState().ui.prefs.panel).toBe('problems');
  });

  it('closes and opens the scenario column, the right panel and the YAML pane with [, ] and \\', () => {
    expect([press('['), press(']'), press('\\')]).toEqual([false, false, false]);
    expect(store.getState().ui.prefs.collapsed).toEqual({ left: true, right: true, yaml: false });
    press('[');
    expect(store.getState().ui.prefs.collapsed.left).toBe(false);
  });

  it('jumps to the Reasons tab with r and puts the focus in it once it has rendered', () => {
    stop();
    const frames: FrameRequestCallback[] = [];
    const full = Object.assign(new EventTarget(), {
      innerWidth: 1280,
      document,
      requestAnimationFrame: (f: FrameRequestCallback) => frames.push(f),
    });
    stop = installShortcuts(store, full as unknown as Window);
    store.getState().setPanel('problems');
    expect(full.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', cancelable: true }))).toBe(false);
    expect(store.getState().ui.prefs.panel).toBe('reasons');
    const panel = document.createElement('div');
    panel.dataset.panel = 'reasons';
    panel.tabIndex = -1;
    document.body.append(panel);
    for (const f of frames) f(0);
    expect(document.activeElement).toBe(panel);
    panel.remove();
  });

  it('stops listening once stopped', () => {
    stop();
    press('t');
    expect(store.getState().ui.view).toBe('graph');
  });

  it('listens on the window by default, and not to a key typed in a field', () => {
    stop();
    stop = installShortcuts(store);
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
    expect(store.getState().ui.view).toBe('graph');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
    expect(store.getState().ui.view).toBe('text');
    input.remove();
  });
});

describe('the narrow screen', () => {
  it('starts below 1024 px and shows the text there whatever the author picked', () => {
    expect([isNarrow(1023), isNarrow(1024)]).toEqual([true, false]);
    expect([shownView('graph', true), shownView('graph', false), shownView('text', false)]).toEqual([
      'text',
      'graph',
      'text',
    ]);
  });
});

describe('the view toggle', () => {
  const happy = () =>
    (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;
  afterEach(() => {
    cleanup();
    act(() => happy().setViewport({ width: 1024, height: 768 }));
  });

  function mount() {
    const store = createSessionStore();
    render(
      createElement(AppProvider, { app: { store } as unknown as App, children: createElement(ViewToggle) }),
    );
    return { store, user: userEvent.setup() };
  }
  const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

  it('writes the view the author picks and shows it pressed', async () => {
    const { store, user } = mount();
    expect([pressed('Graph'), pressed('Text')]).toEqual(['true', 'false']);
    await user.click(screen.getByRole('button', { name: 'Text' }));
    expect(store.getState().ui.view).toBe('text');
    expect([pressed('Graph'), pressed('Text')]).toEqual(['false', 'true']);
  });

  it('shows Text pressed and Graph disabled below 1024 px, with a line that says why', () => {
    mount();
    act(() => {
      happy().setViewport({ width: 800, height: 600 });
      window.dispatchEvent(new Event('resize'));
    });
    const graphButton = screen.getByRole('button', { name: 'Graph' });
    expect([pressed('Graph'), pressed('Text')]).toEqual(['false', 'true']);
    expect(graphButton.hasAttribute('disabled')).toBe(true);
    const hint = document.getElementById(graphButton.getAttribute('aria-describedby')!);
    expect(hint?.textContent).toBe('the graph needs 1024 px');
  });
});
