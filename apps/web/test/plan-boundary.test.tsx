// @vitest-environment happy-dom
import { simulate } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { SimulateView } from '../src/app/SimulateView';
import { createSessionStore, type PlanState, type SessionStore } from '../src/state/store';
import { deriveTables } from '../src/worker/derived';
import type { Outline } from '../src/worker/protocol';

/** A plan view that cannot show the plan `bad`, standing in for any render error the committed plan causes. */
vi.mock('../src/text/TextView', async () => {
  const { createElement: h } = await import('react');
  const { useSession } = await import('../src/app/providers');
  return {
    TextView: () => {
      const text = useSession((s) => s.plan?.text);
      if (text === 'bad') throw new Error('cannot show this plan');
      return h('pre', { 'aria-label': 'The plan' }, text);
    },
  };
});

const CI = '.github/workflows/ci.yml';

const outline: Outline = {
  files: [],
  workflows: [
    { path: CI, callable: false, events: [{ event: 'push', branches: ['main'] }], jobs: [], onLine: 1 },
  ],
  events: {},
};

const files = { [CI]: 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: make }]\n' };
const simulated = simulate({ files, scenario: { event: 'push' }, assume: [], detail: 'steps' });

const derived = deriveTables(simulated, outline);

/** The one simulated plan with the text given, which is all the plan view above reads. */
const plan = (text: string) =>
  ({ plan: simulated, derived, text, ms: { simulate: 1, derive: 0 } }) as PlanState;

/** The screen over a loaded project whose plan it can show as text; the test commits the next plans. */
function mountView(): SessionStore {
  const store = createSessionStore();
  const a = store.getState();
  a.setView('text');
  a.setFiles(files, { kind: 'sample', name: 'starter' });
  a.projectReady(1, outline, 1);
  a.setScenario({ event: 'push', branch: 'dev' }, { from: 'url' });
  a.planReceived(plan('ci.yml ● build'));
  const app = { store, sources: { canPickFolder: false } } as unknown as App;
  render(
    <AppProvider app={app}>
      <SimulateView />
    </AppProvider>,
  );
  return store;
}

describe('a plan the page cannot render', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('gives way to the next plan for the same scenario, which the page tries again', () => {
    const store = mountView();
    act(() => store.getState().planReceived(plan('bad')));
    expect(screen.getByRole('alert').textContent).toContain('cannot show this plan');
    expect(screen.queryByRole('form', { name: 'Scenario' })).toBeNull();
    act(() => store.getState().planReceived(plan('ci.yml ○ build')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('The plan').textContent).toBe('ci.yml ○ build');
    expect(screen.getByRole('form', { name: 'Scenario' })).toBeTruthy();
  });

  it("puts back the page's own scenario from its button, and shows the plan that answers it", () => {
    const store = mountView();
    act(() => store.getState().planReceived(plan('bad')));
    fireEvent.click(screen.getByRole('button', { name: 'Put back the default scenario' }));
    expect(store.getState().scenarioFrom).toBe('default');
    // The plan the page could not show is still the one committed until the worker answers.
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => store.getState().planReceived(plan('ci.yml ● build')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('The plan').textContent).toBe('ci.yml ● build');
  });
});
