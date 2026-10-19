// @vitest-environment happy-dom
import type { ScenarioInput } from '@simulci/engine';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { ScenarioForm } from '../src/app/ScenarioForm';
import { deriveForm } from '../src/scenario/derive';
import { createSessionStore, initialSessionState, type SessionStore } from '../src/state/store';
import type { Outline } from '../src/worker/protocol';

const CI = '.github/workflows/ci.yml';

const outline: Outline = {
  files: [],
  workflows: [
    {
      path: CI,
      name: 'CI',
      callable: false,
      events: [
        { event: 'push', branches: ['main'], paths: ['src/**'] },
        {
          event: 'pull_request',
          types: { allowed: ['opened', 'closed'], all: ['opened', 'closed', 'labeled'], narrowed: true },
          paths: ['src/**'],
        },
        { event: 'release' },
        { event: 'schedule', crons: ['0 0 * * *'] },
        { event: 'workflow_run', workflows: ['CI'], branches: ['main'] },
        { event: 'workflow_dispatch' },
      ],
      dispatch: [
        { name: 'dry', type: 'boolean', required: false, default: false },
        { name: 'level', type: 'choice', required: false, default: 'low', options: ['low', 'high'] },
        { name: 'target', type: 'environment', required: true },
      ],
      jobs: [],
      onLine: 1,
    },
  ],
  events: { pull_request: { types: ['opened', 'closed', 'labeled'], default: ['opened'] } },
};

/** The form over a store that holds a loaded project and the scenario given, the scenario column open or closed. */
function mount(scenario: ScenarioInput, left: 'open' | 'closed' = 'open') {
  const initial = initialSessionState();
  const store = createSessionStore({
    ...initial,
    project: { status: 'ready', version: 1, outline, files: 1 },
    scenario,
    focus: CI,
    ui: {
      ...initial.ui,
      prefs: { ...initial.ui.prefs, collapsed: { ...initial.ui.prefs.collapsed, left: left === 'closed' } },
    },
  });
  render(
    <AppProvider app={{ store } as unknown as App}>
      <button type="button">a pin</button>
      <ScenarioForm />
    </AppProvider>,
  );
  return { store, user: userEvent.setup() };
}

const variables = () => screen.getByLabelText<HTMLTextAreaElement>('Variables');
const changed = () => screen.getByLabelText<HTMLTextAreaElement>(/Changed files/);
const advanced = () => screen.getByRole('button', { name: 'Advanced' });

/** Waits until the form took the request it was given. */
const taken = (store: SessionStore) => waitFor(() => expect(store.getState().fieldFocus).toBeUndefined());

describe('a focus request', () => {
  afterEach(cleanup);

  it('opens Advanced on a pinned variable and puts the caret after its =, so the author types its value', async () => {
    const { store } = mount({ event: 'push', branch: 'main' });
    expect(advanced().getAttribute('aria-expanded')).toBe('false');
    act(() =>
      store.getState().pinScenario({ event: 'push', branch: 'main', vars: { DEPLOY: '' } }, ['vars'], {
        path: 'vars',
        entry: 'DEPLOY',
      }),
    );
    await waitFor(() => expect(document.activeElement).toBe(variables()));
    expect(variables().value).toBe('DEPLOY=');
    expect([variables().selectionStart, variables().selectionEnd]).toEqual([7, 7]);
    expect(advanced().getAttribute('aria-expanded')).toBe('true');
    await taken(store);
    expect(store.getState().assumed).toContain('vars');
  });

  it("selects a pinned variable's example among the others", async () => {
    const { store } = mount({ event: 'push', branch: 'main', vars: { REGION: 'eu' } });
    act(() =>
      store
        .getState()
        .pinScenario({ event: 'push', branch: 'main', vars: { REGION: 'eu', DEPLOY: 'true' } }, ['vars'], {
          path: 'vars',
          entry: 'DEPLOY',
        }),
    );
    await waitFor(() => expect(document.activeElement).toBe(variables()));
    const { value, selectionStart, selectionEnd } = variables();
    expect(value).toBe('REGION=eu\nDEPLOY=true');
    expect(value.slice(selectionStart, selectionEnd)).toBe('true');
  });

  it('opens Advanced for a pin into it though the author closed it while one of its keys was set', async () => {
    const scenario: ScenarioInput = { event: 'push', branch: 'main', sha: 'abc1234' };
    const { store, user } = mount(scenario);
    expect(advanced().getAttribute('aria-expanded')).toBe('true');
    await user.click(advanced());
    expect(advanced().getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'a pin' }));
    act(() =>
      store.getState().pinScenario({ ...scenario, repository: 'owner/name' }, ['repository'], {
        path: 'repository',
      }),
    );
    const repository = () => screen.getByLabelText<HTMLInputElement>('Repository');
    await waitFor(() => expect(document.activeElement).toBe(repository()));
    expect(advanced().getAttribute('aria-expanded')).toBe('true');
    expect([repository().selectionStart, repository().selectionEnd]).toEqual([0, 'owner/name'.length]);
    await taken(store);
    // Once taken, the request opens it no more: the author can close it again.
    await user.click(advanced());
    act(() => store.getState().patchScenario({ message: 'docs' }));
    expect(advanced().getAttribute('aria-expanded')).toBe('false');
  });

  it('shows and focuses the changed files a pin writes on a dispatch, and keeps them in view while cleared', async () => {
    const scenario: ScenarioInput = { event: 'workflow_dispatch', branch: 'main' };
    const { store, user } = mount(scenario);
    expect(screen.queryByLabelText(/Changed files/)).toBeNull();
    act(() =>
      store
        .getState()
        .pinScenario({ ...scenario, changed: ['path/to/file'] }, ['changed'], { path: 'changed' }),
    );
    await waitFor(() => expect(document.activeElement).toBe(changed()));
    expect([changed().selectionStart, changed().selectionEnd]).toEqual([0, 'path/to/file'.length]);
    await taken(store);
    await user.clear(changed());
    expect(store.getState().scenario.changed).toBeUndefined();
    expect(document.activeElement).toBe(changed());
  });

  it('puts the focus in the changed files of a push with their text selected', async () => {
    const { store } = mount({ event: 'push', branch: 'main', changed: ['src/a.ts', 'docs/b.md'] });
    act(() => store.getState().focusField({ path: 'changed' }));
    await waitFor(() => expect(document.activeElement).toBe(changed()));
    expect([changed().selectionStart, changed().selectionEnd]).toEqual([0, 'src/a.ts\ndocs/b.md'.length]);
    await taken(store);
  });

  it('opens the scenario column when it is closed', async () => {
    const { store } = mount({ event: 'push', branch: 'main' }, 'closed');
    act(() => store.getState().focusField({ path: 'changed' }));
    expect(store.getState().ui.prefs.collapsed.left).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(changed()));
  });

  it('focuses a select as it is, with nothing to select in it', async () => {
    const { store } = mount({ event: 'pull_request', action: 'closed' });
    act(() => store.getState().focusField({ path: 'action' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Activity type')));
    act(() => store.getState().focusField({ path: 'number' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Number')));
    await taken(store);
  });

  it('takes a request for a field the form does not show and leaves the focus where it is', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' });
    await user.click(screen.getByRole('button', { name: 'a pin' }));
    act(() => store.getState().focusField({ path: 'cron' }));
    expect(store.getState().fieldFocus).toBeUndefined();
    act(() => store.getState().focusField({ path: 'inputs.dry' }));
    expect(store.getState().fieldFocus).toBeUndefined();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'a pin' }));
  });

  it('takes a request whose field never shows once it stops waiting', async () => {
    const { store } = mount({ event: 'workflow_dispatch', branch: 'main' });
    act(() => store.getState().focusField({ path: 'inputs.other' }));
    expect(store.getState().fieldFocus).toBeDefined();
    await taken(store);
    expect(document.activeElement).toBe(document.body);
  });

  it('takes the focus once, and leaves the author where they go next', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main', changed: ['src/a.ts'] });
    act(() => store.getState().focusField({ path: 'changed' }));
    await waitFor(() => expect(document.activeElement).toBe(changed()));
    await taken(store);
    const message = screen.getByLabelText('Commit message');
    await user.click(message);
    await user.type(changed(), 'x');
    await user.click(message);
    act(() => store.getState().patchScenario({ changed: ['src/b.ts'] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(message);
  });
});

/**
 * Each event with every field it can show in view: Advanced open (a SHA), Merged (a closed pull request), and the
 * fork under Advanced (a fork off a pull request).
 */
const fork = { sha: 'abc1234', actor: { fork: true } };
const SCENARIOS: ScenarioInput[] = [
  { event: 'push', branch: 'main', ...fork },
  { event: 'pull_request', action: 'closed', sha: 'abc1234' },
  { event: 'release', tag: 'v1.0.0', ...fork },
  { event: 'schedule', cron: '0 0 * * *', ...fork },
  { event: 'workflow_run', workflow_run: { name: 'CI', conclusion: 'success' }, ...fork },
  { event: 'workflow_dispatch', branch: 'main', ...fork },
];

describe('the controls a focus request finds', () => {
  afterEach(cleanup);

  it.each(SCENARIOS)('carry the field deriveForm routes to them, on $event', (scenario) => {
    mount(scenario);
    const form = screen.getByRole('form', { name: 'Scenario' });
    const shown = new Set(
      Array.from(form.querySelectorAll<HTMLElement>('[data-field]')).map((el) => el.dataset.field),
    );
    const fields = new Set(deriveForm(outline, scenario, CI).fields.values());
    // The dispatch inputs as a whole are a fieldset, each input a control of its own.
    fields.delete('inputs');
    expect([...fields].filter((field) => !shown.has(field))).toEqual([]);
    for (const el of within(form).queryAllByRole('textbox')) expect(el.dataset.field).toBeDefined();
  });
});
