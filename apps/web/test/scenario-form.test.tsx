// @vitest-environment happy-dom
import type { ScenarioInput } from '@simulci/engine';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { ScenarioForm } from '../src/app/ScenarioForm';
import { createSessionStore, initialSessionState } from '../src/state/store';
import type { Outline } from '../src/worker/protocol';

const outline: Outline = {
  files: [],
  workflows: [
    {
      path: '.github/workflows/ci.yml',
      name: 'CI',
      callable: false,
      events: [
        { event: 'push', tags: ['v*'], paths: ['src/**'] },
        {
          event: 'pull_request',
          types: { allowed: ['opened', 'labeled'], all: ['opened', 'labeled', 'closed'], narrowed: true },
          paths: ['src/**'],
        },
        { event: 'workflow_run', workflows: ['CI'] },
        { event: 'release' },
        { event: 'workflow_dispatch' },
      ],
      dispatch: [{ name: 'dry', type: 'boolean', required: false, default: 'true' }],
      jobs: [],
      onLine: 1,
    },
  ],
  events: { pull_request: { types: ['opened', 'labeled', 'closed'], default: ['opened'] } },
};

/** The form over a store that holds a loaded project and the scenario given. */
function mount(scenario: ScenarioInput) {
  const store = createSessionStore({
    ...initialSessionState(),
    project: { status: 'ready', version: 1, outline, files: 1 },
    scenario,
  });
  render(
    <AppProvider app={{ store } as unknown as App}>
      <ScenarioForm />
    </AppProvider>,
  );
  return { store, user: userEvent.setup() };
}

const changedField = () => screen.getByLabelText<HTMLTextAreaElement>(/Changed files/);
const eventSelect = () => screen.getAllByRole<HTMLSelectElement>('combobox')[0]!;

describe('the scenario form', () => {
  afterEach(cleanup);

  it('takes every keystroke of the changed files, newlines and spaces included', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' });
    await user.type(changedField(), 'src/a.ts{Enter}docs/my file.md');
    expect(changedField().value).toBe('src/a.ts\ndocs/my file.md');
    expect(store.getState().scenario.changed).toEqual(['src/a.ts', 'docs/my file.md']);
    await user.type(changedField(), '{Enter}');
    expect(changedField().value).toBe('src/a.ts\ndocs/my file.md\n');
    act(() => store.getState().patchScenario({ changed: ['x.ts'] }));
    expect(changedField().value).toBe('x.ts');
  });

  it('shows changed files of the wrong shape instead of failing', () => {
    mount({ event: 'push', changed: [null, 3, { path: 'a.ts' }] as never });
    expect(changedField().value).toBe('null\n3\na.ts');
  });

  it('reveals the free-text event when other… is picked and keeps it while the author types', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' });
    await user.selectOptions(eventSelect(), '…');
    const name = screen.getByLabelText<HTMLInputElement>('Event name');
    await user.clear(name);
    await user.type(name, 'push');
    expect(screen.getByLabelText('Event name')).toBe(name);
    await user.type(name, 'x');
    expect(store.getState().scenario.event).toBe('pushx');
    expect(eventSelect().value).toBe('…');
    await user.selectOptions(eventSelect(), 'pull_request');
    expect(screen.queryByLabelText('Event name')).toBeNull();
  });

  it('shows a listed event that comes from outside in the select, after other… was picked', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' });
    await user.selectOptions(eventSelect(), '…');
    act(() => store.getState().setScenario({ event: 'pull_request' }, { from: 'url' }));
    expect(eventSelect().value).toBe('pull_request');
    expect(screen.queryByLabelText('Event name')).toBeNull();
    await user.selectOptions(eventSelect(), '…');
    await user.clear(screen.getByLabelText('Event name'));
    await user.type(screen.getByLabelText('Event name'), 'issues');
    act(() => store.getState().setScenario({ event: 'push', branch: 'main' }, { from: 'url' }));
    expect(eventSelect().value).toBe('push');
    expect(screen.queryByLabelText('Event name')).toBeNull();
  });

  it('keeps what the event owns when other… is picked and the same event picked again', async () => {
    const scenario = { event: 'pull_request', action: 'labeled', merged: true, number: 3 };
    const { store, user } = mount(scenario);
    act(() => store.getState().setScenario(scenario, { assumed: ['action'], from: 'default' }));
    await user.selectOptions(eventSelect(), '…');
    await user.selectOptions(eventSelect(), 'pull_request');
    expect(store.getState().scenario).toEqual(scenario);
    expect(store.getState().assumed).toEqual(['action']);
    expect(eventSelect().value).toBe('pull_request');
    expect(screen.queryByLabelText('Event name')).toBeNull();
  });

  it('gives a release the tag it names and nothing a release cannot run on', async () => {
    const { store, user } = mount({ event: 'push', branch: 'main' });
    await user.selectOptions(eventSelect(), 'release');
    expect(store.getState().scenario).toEqual({ event: 'release' });
    await user.type(screen.getByRole('textbox', { name: 'Tag' }), 'v1.2.3');
    expect(store.getState().scenario).toEqual({ event: 'release', tag: 'v1.2.3' });
    act(() => store.getState().setScenario({ event: 'release', ref: 'refs/tags/v1' }, { from: 'url' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Tag' }).value).toBe('v1');
    await user.type(screen.getByRole('textbox', { name: 'Tag' }), '.1');
    expect(store.getState().scenario).toEqual({ event: 'release', tag: 'v1.1' });
    act(() => store.getState().setScenario({ event: 'release', branch: 'main' }, { from: 'url' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Tag' }).value).toBe('');
    await user.type(screen.getByRole('textbox', { name: 'Tag' }), 'v3');
    expect(store.getState().scenario).toEqual({ event: 'release', tag: 'v3' });
  });

  it('renders an event named like an Object.prototype key', () => {
    mount({ event: 'constructor' });
    expect(screen.getByLabelText<HTMLInputElement>('Event name').value).toBe('constructor');
  });

  it('keeps the Tag field a Tag field when it is emptied', async () => {
    const { store, user } = mount({ event: 'push', tag: 'v1.0.0' });
    const tag = screen.getByRole('textbox', { name: 'Tag' });
    await user.clear(tag);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Tag' }).checked).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'Tag' }), 'v2.0.0');
    expect(store.getState().scenario).toEqual({ event: 'push', tag: 'v2.0.0' });
    await user.clear(screen.getByRole('textbox', { name: 'Tag' }));
    act(() => store.getState().setScenario({ event: 'push' }, { from: 'url' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Branch' }).checked).toBe(true);
  });

  it('reads a push ref as the branch or the tag it names and writes it back as one', async () => {
    const { store, user } = mount({ event: 'push', ref: 'refs/tags/v1' });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Tag' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Tag' }).value).toBe('v1');
    expect(screen.queryByLabelText(/Changed files/)).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Tag' }), '.1');
    expect(store.getState().scenario).toEqual({ event: 'push', tag: 'v1.1' });
    act(() => store.getState().setScenario({ event: 'push', ref: 'heads/dev' }, { from: 'url' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Branch' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Branch' }).value).toBe('dev');
    await user.click(screen.getByRole('radio', { name: 'Tag' }));
    expect(store.getState().scenario).toEqual({ event: 'push', tag: 'v1.0.0' });
    act(() => store.getState().setScenario({ event: 'push', ref: 'refs/tags/v2' }, { from: 'url' }));
    await user.click(screen.getByRole('radio', { name: 'Branch' }));
    expect(store.getState().scenario).toEqual({ event: 'push', branch: 'main' });
  });

  it('offers the changed files to a pull request that follows a tag push', async () => {
    const { store, user } = mount({ event: 'push', tag: 'v1.0.0' });
    expect(screen.queryByLabelText(/Changed files/)).toBeNull();
    await user.selectOptions(eventSelect(), 'pull_request');
    expect(store.getState().scenario.tag).toBeUndefined();
    expect(changedField()).toBeTruthy();
  });

  it('shows an action that is not a type of the event as itself', () => {
    mount({ event: 'pull_request', action: 'foo' });
    const select = screen.getByLabelText<HTMLSelectElement>(/Activity type/);
    expect(select.value).toBe('foo');
    expect(select.selectedOptions[0]?.textContent).toBe('foo · not a type of pull_request');
  });

  it('keeps the conclusion chosen before the triggering workflow', async () => {
    const { store, user } = mount({ event: 'workflow_run' });
    const conclusion = screen.getByLabelText<HTMLSelectElement>(/Its conclusion/);
    await user.selectOptions(conclusion, 'failure');
    expect(conclusion.value).toBe('failure');
    await user.selectOptions(screen.getByLabelText(/Triggering workflow/), 'CI');
    expect(store.getState().scenario.workflow_run).toEqual({ name: 'CI', conclusion: 'failure' });
  });

  it('shows the conclusion of the named run, not one chosen for an earlier run', async () => {
    const { store, user } = mount({ event: 'workflow_run' });
    await user.selectOptions(screen.getByLabelText(/Triggering workflow/), 'CI');
    await user.selectOptions(screen.getByLabelText(/Its conclusion/), 'failure');
    expect(store.getState().scenario.workflow_run).toEqual({ name: 'CI', conclusion: 'failure' });
    act(() =>
      store.getState().setScenario({ event: 'workflow_run', workflow_run: { name: 'CI' } }, { from: 'url' }),
    );
    expect(screen.getByLabelText<HTMLSelectElement>(/Its conclusion/).value).toBe('success');
    await user.selectOptions(screen.getByLabelText(/Triggering workflow/), '');
    expect(screen.getByLabelText<HTMLSelectElement>(/Its conclusion/).value).toBe('success');
    await user.selectOptions(screen.getByLabelText(/Triggering workflow/), 'CI');
    expect(store.getState().scenario.workflow_run).toEqual({ name: 'CI' });
  });

  it('sends false for a boolean input whose quoted default is true', async () => {
    const { store, user } = mount({ event: 'workflow_dispatch' });
    const dry = screen.getByRole<HTMLInputElement>('checkbox', { name: /dry/ });
    expect(dry.checked).toBe(true);
    await user.click(dry);
    expect(store.getState().scenario.inputs).toEqual({ dry: false });
    await user.click(dry);
    expect(store.getState().scenario.inputs).toBeUndefined();
  });
});
