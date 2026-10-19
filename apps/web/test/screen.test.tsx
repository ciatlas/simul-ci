// @vitest-environment happy-dom
import type { ScenarioInput } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { installShortcuts } from '../src/app/shortcuts';
import { SimulateView } from '../src/app/SimulateView';
import { sampleByName } from '../src/input/samples';
import { Gate } from '../src/panels/kit';
import { createSessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const chunk = vi.hoisted(() => ({ fails: false }));

/** The YAML pane as built, or, while `chunk.fails`, an editor chunk that could not load. */
vi.mock('../src/yaml/YamlPane', async (importOriginal) => {
  const built = await importOriginal<typeof import('../src/yaml/YamlPane')>();
  return {
    YamlPane: () => {
      if (chunk.fails) throw new TypeError('Failed to fetch dynamically imported module');
      return createElement(built.YamlPane);
    },
  };
});

/** The screen over the starter sample: a push to main that changes src/, simulated by the worker's own `handle`. */
function mount() {
  const files = sampleByName('starter')!.files;
  const loaded = handle(initialState(), { id: 1, type: 'load', files, repository: 'o/r' });
  if (loaded.response.type !== 'loaded') throw new Error(loaded.response.type);
  const scenario: ScenarioInput = { event: 'push', branch: 'main', changed: ['src/a.ts'] };
  const r = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (r.response.type !== 'plan') throw new Error(r.response.type);
  const store = createSessionStore();
  const a = store.getState();
  a.setFiles(files, { kind: 'sample', name: 'starter' });
  a.projectReady(1, loaded.response.outline, 1);
  a.setScenario(scenario, { from: 'url' });
  a.setFocus('.github/workflows/ci.yml');
  const { plan, derived, text, ms } = r.response;
  a.planReceived({ plan, derived, text, ms, for: { files: 1, project: 1 } });
  const app = { store, sources: { canPickFolder: false } } as unknown as App;
  render(
    <AppProvider app={app}>
      <SimulateView />
    </AppProvider>,
  );
  return { store, user: userEvent.setup() };
}

const happy = () =>
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM;

const classes = (el: Element): string[] => el.className.split(/\s+/);

function resize(width: number): void {
  act(() => {
    happy().setViewport({ width, height: 768 });
    window.dispatchEvent(new Event('resize'));
  });
}

describe('the screen', () => {
  afterEach(() => {
    cleanup();
    resize(1024);
    chunk.fails = false;
    vi.restoreAllMocks();
  });

  it('puts the outline below the scenario form, and the run graph beside them', () => {
    mount();
    const column = screen.getByRole('complementary', { name: 'Scenario and outline' });
    const tree = within(column).getByRole('tree', { name: 'Outline' });
    const form = within(column).getAllByRole('combobox')[0]!;
    expect(form.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: 'CI, runs' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'The run graph' }).textContent).toContain(
      'Laying out the graph',
    );
    expect(screen.queryByLabelText('The plan')).toBeNull();
  });

  it('puts the plan details beside the graph, on the tab the author last opened', () => {
    const { store } = mount();
    const details = screen.getByRole('complementary', { name: 'Plan details' });
    expect(within(details).getByRole('tab', { name: 'Reasons', selected: true })).toBeTruthy();
    act(() => store.getState().setPanel('problems'));
    expect(within(details).getByRole('tab', { name: /^Problems/, selected: true })).toBeTruthy();
    act(() => store.getState().togglePane('right'));
    expect(screen.queryByRole('complementary', { name: 'Plan details' })).toBeNull();
  });

  it('shows the plan as text when the author picks it, and the graph again on the next pick', async () => {
    const { store, user } = mount();
    await user.click(screen.getByRole('button', { name: 'Text' }));
    expect(store.getState().ui.view).toBe('text');
    expect(screen.getByLabelText('The plan').textContent).toContain('deploy');
    expect(screen.queryByRole('region', { name: 'The run graph' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Graph' }));
    expect(screen.getByRole('region', { name: 'The run graph' })).toBeTruthy();
  });

  it('shows the text below 1024 px whatever the author picked, and the graph once there is room again', () => {
    const { store } = mount();
    resize(800);
    expect(store.getState().ui.view).toBe('graph');
    expect(screen.getByLabelText('The plan')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'The run graph' })).toBeNull();
    resize(1280);
    expect(screen.getByRole('region', { name: 'The run graph' })).toBeTruthy();
  });

  it('keeps an editor that could not load inside the YAML pane, with a way to close it and one to reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    chunk.fails = true;
    const { store, user } = mount();
    act(() => store.getState().togglePane('yaml'));
    const pane = await screen.findByRole('region', { name: 'Workflow source' });
    const alert = await within(pane).findByRole('alert');
    expect(alert.textContent).toContain('The editor could not load.');
    expect(screen.getByRole('form', { name: 'Scenario' })).toBeTruthy();
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    await user.click(within(alert).getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledOnce();
    await user.click(within(alert).getByRole('button', { name: 'Close the workflow source' }));
    expect(store.getState().ui.prefs.collapsed.yaml).toBe(true);
    expect(document.activeElement?.hasAttribute('data-plan')).toBe(true);
    expect([store.getState().scenarioFrom, store.getState().scenario.branch]).toEqual(['url', 'main']);
  });

  it('hands the focus to the plan when [, ] or \\ closes the pane that holds it', async () => {
    const { store } = mount();
    const stop = installShortcuts(store);
    try {
      const plan = () => document.querySelector('[data-plan]');
      screen.getByRole('treeitem', { name: 'CI, runs' }).focus();
      fireEvent.keyDown(document.activeElement!, { key: '[' });
      expect(store.getState().ui.prefs.collapsed.left).toBe(true);
      expect(document.activeElement).toBe(plan());
      screen.getByRole('tab', { name: 'Reasons' }).focus();
      fireEvent.keyDown(document.activeElement!, { key: ']' });
      expect(store.getState().ui.prefs.collapsed.right).toBe(true);
      expect(document.activeElement).toBe(plan());
      act(() => store.getState().togglePane('yaml'));
      const pane = await screen.findByRole('region', { name: 'Workflow source' });
      (await within(pane).findAllByRole('tab'))[0]!.focus();
      fireEvent.keyDown(document.activeElement!, { key: '\\' });
      expect(screen.queryByRole('region', { name: 'Workflow source' })).toBeNull();
      expect(document.activeElement).toBe(plan());
    } finally {
      stop();
    }
  });

  it('puts the focus in the Reasons panel itself with r, and makes the open panel a tab stop', async () => {
    const { store } = mount();
    const stop = installShortcuts(store);
    try {
      act(() => store.getState().setPanel('problems'));
      const details = screen.getByRole('complementary', { name: 'Plan details' });
      expect(details.querySelector('[data-panel="problems"]')?.getAttribute('tabindex')).toBe('0');
      fireEvent.keyDown(document.body, { key: 'r' });
      await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('tabpanel'));
      expect(document.activeElement?.getAttribute('data-panel')).toBe('reasons');
      expect(within(details).getByRole('tab', { name: 'Reasons', selected: true })).toBeTruthy();
    } finally {
      stop();
    }
  });

  it('turns the page keys off and on with the Shortcuts switch, which says its state in words', async () => {
    const { store, user } = mount();
    const keys = screen.getByRole('switch', { name: 'Shortcuts' });
    expect([keys.getAttribute('aria-checked'), keys.textContent]).toEqual(['true', 'Shortcuts on']);
    await user.click(keys);
    expect(store.getState().ui.prefs.keys).toBe(false);
    expect([keys.getAttribute('aria-checked'), keys.textContent]).toEqual(['false', 'Shortcuts off']);
  });

  it('lays the panes out on the classes the layout rests on (happy-dom lays nothing out)', () => {
    const { store } = mount();
    // Below 768 px every row takes its own height and the page scrolls, so the open YAML pane starves no row.
    expect(classes(screen.getByRole('main'))).toEqual(
      expect.arrayContaining(['auto-rows-max', 'md:auto-rows-auto']),
    );
    // From 768 to 1023 px the scenario column spans the plan and the panel under it; alone, the plan has the height.
    const column = screen.getByRole('complementary', { name: 'Scenario and outline' });
    expect(classes(column)).toEqual(expect.arrayContaining(['md:row-span-2', 'lg:row-span-1']));
    // The scrollers hold their sr-only text, which would otherwise scroll the page.
    const details = screen.getByRole('complementary', { name: 'Plan details' });
    expect(classes(column)).toContain('relative');
    expect(classes(within(details).getByRole('tabpanel'))).toContain('relative');
    act(() => store.getState().togglePane('right'));
    expect(classes(column)).not.toContain('md:row-span-2');
  });

  it('draws an undecided gate in the amber kept for text, and names it', () => {
    render(<Gate gate={{ known: false, unknowns: [] }} />);
    const gate = screen.getByRole('img', { name: 'undecided' });
    expect([gate.textContent, classes(gate).includes('text-might-text')]).toEqual(['?', true]);
  });
});
