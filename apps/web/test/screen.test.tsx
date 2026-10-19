// @vitest-environment happy-dom
import type { ScenarioInput } from '@simulci/engine';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { SimulateView } from '../src/app/SimulateView';
import { sampleByName } from '../src/input/samples';
import { createSessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

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
  });

  it('puts the outline below the scenario form, and the run graph beside them', () => {
    mount();
    const column = screen.getByRole('complementary');
    const tree = within(column).getByRole('tree', { name: 'Outline' });
    const form = within(column).getAllByRole('combobox')[0]!;
    expect(form.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: 'CI, runs' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'The run graph' }).textContent).toContain(
      'Laying out the graph',
    );
    expect(screen.queryByLabelText('The plan')).toBeNull();
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
});
