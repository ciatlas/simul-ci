// @vitest-environment happy-dom
/**
 * The triggers editor (synthesis § 4.6), on a store that holds a plan: the rows are the file's events, each radio the
 * scenario's event; chips add on Enter after +, cancel on Escape and go on Delete, keeping the focus in the row; a
 * filter the event lacks is added in place, an `on: push` becoming a map; a filter next to its twin is refused with the
 * switch as its fix; removing the only event asks first; schedules and dispatch inputs are edited in place; a
 * generated file shows why it takes no input. Every edit is said in a polite live region and undoes to the bytes.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScenarioInput } from '@simulci/engine';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { TriggerRows } from '../src/edit/triggers/TriggerRows';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';
import { eventTable } from '../src/worker/events';

const CI = '.github/workflows/ci.yml';
const JOBS = 'jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n';

/** A store showing the plan of the files under a scenario, in edit mode, focused on the CI workflow. */
function opened(text: string, scenario: ScenarioInput, path = CI): SessionStore {
  const store = createSessionStore();
  const s = store.getState();
  s.engineReady({ version: '0', models: [], events: eventTable() });
  const files = { [path]: text };
  s.setFiles(files, { kind: 'folder', name: 'repo', readAt: 0 });
  const loaded = handle(initialState(), { id: 1, type: 'load', files });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  s.projectReady(1, loaded.response.outline, 1);
  s.setScenario(scenario);
  const r = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (r.response.type !== 'plan') throw new Error(JSON.stringify(r.response));
  const { plan, derived, text: planText, ms } = r.response;
  s.planReceived({ plan, derived, text: planText, ms, for: { files: 1, epoch: 1, project: 1 } });
  s.setEdit(true);
  s.select(path, undefined);
  return store;
}

function mount(store: SessionStore) {
  render(
    <AppProvider app={{ store } as unknown as App}>
      <TriggerRows />
    </AppProvider>,
  );
  return userEvent.setup();
}

const text = (store: SessionStore, path = CI): string => store.getState().files.byPath[path]!;
const said = (): string => document.querySelector('[aria-live="polite"]')!.textContent ?? '';
const row = (event: string): HTMLElement => document.querySelector<HTMLElement>(`[data-event="${event}"]`)!;

afterEach(cleanup);

describe('the triggers editor', () => {
  it('lists the file’s events, the scenario’s checked, and a radio simulates another', async () => {
    const store = opened(`on:\n  push:\n    branches: [main]\n  pull_request:\n${JOBS}`, {
      event: 'push',
      branch: 'dev',
    });
    const user = mount(store);
    const push = screen.getByRole<HTMLInputElement>('radio', { name: 'push' });
    expect(push.checked).toBe(true);
    // The plan's word on the filter, for the scenario's event only.
    expect(within(row('push')).getByText(/dev matches none/)).toBeTruthy();
    expect(within(row('pull_request')).queryByText(/matches/)).toBeNull();
    // pull_request's types are its defaults, in grey, with nothing to remove.
    const types = within(row('pull_request')).getByRole('list', { name: "pull_request's types" });
    expect(within(types).getByText('(default)')).toBeTruthy();
    expect(within(types).queryByRole('button', { name: /^Remove/ })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'pull_request' }));
    expect(store.getState().scenario.event).toBe('pull_request');
  });

  it('adds a pattern on Enter after +, cancels on Escape, removes one on Delete, and keeps the focus in the row', async () => {
    const before = `on:\n  push:\n    branches: [main]\n${JOBS}`;
    const store = opened(before, { event: 'push', branch: 'main' });
    const user = mount(store);
    await user.click(screen.getByRole('button', { name: "Add a pattern to push's branches" }));
    await user.keyboard('release/**{Enter}');
    expect(text(store)).toContain('    branches: [main, release/**]\n');
    expect(said()).toBe("added release/** to push's branches");
    // The input stays for another; Escape closes it, writing nothing, and gives the focus back to +.
    await user.keyboard('nope{Escape}');
    expect(text(store)).not.toContain('nope');
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: "Add a pattern to push's branches" }),
    );
    // Tab back to a chip's ×, and Delete removes it; the focus goes to the chip that took its place.
    screen.getByRole('button', { name: "Remove main from push's branches" }).focus();
    await user.keyboard('{Delete}');
    expect(text(store)).toContain('    branches: [release/**]\n');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: "Remove release/** from push's branches" }),
    );
    expect(store.getState().edit.past).toHaveLength(2);
    act(() => void store.getState().undo());
    act(() => void store.getState().undo());
    expect(text(store)).toBe(before);
  });

  it('adds a filter to on: push in place, writing the map form, and the last pattern takes the filter with it', async () => {
    const before = `name: CI\non: push # every push\n${JOBS}`;
    const store = opened(before, { event: 'push', branch: 'dev' });
    const user = mount(store);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a filter to push' }), 'branches');
    await user.keyboard('main{Enter}');
    expect(text(store)).toBe(`name: CI\non: # every push\n  push:\n    branches: [main]\n${JOBS}`);
    expect(store.getState().edit.past.map((t) => t.label)).toEqual(["Set push's branches"]);
    // The new filter's + has the focus.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: "Add a pattern to push's branches" }),
    );
    await user.click(screen.getByRole('button', { name: "Remove main from push's branches" }));
    expect(text(store)).toBe(`name: CI\non: # every push\n  push:\n${JOBS}`);
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Add a filter to push' }));
    act(() => void store.getState().undo());
    act(() => void store.getState().undo());
    expect(text(store)).toBe(before);
  });

  it('refuses a filter beside its twin, and the switch is the fix; ⋯ switches or removes one', async () => {
    const store = opened(`on:\n  push:\n    branches-ignore: [dev]\n${JOBS}`, {
      event: 'push',
      branch: 'main',
    });
    const user = mount(store);
    expect(within(row('push')).getByText(/main is not ignored/)).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add a filter to push' }), 'branches');
    await user.keyboard('main{Enter}');
    expect(screen.getByText(/already uses/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Switch to branches' }));
    expect(text(store)).toContain('    branches: [main]\n');
    expect(text(store)).not.toContain('branches-ignore');
    // The fix wrote the filter: its own row takes over from the one being added.
    expect(screen.queryByRole('textbox', { name: "New pattern for push's branches" })).toBeNull();
    await user.click(screen.getByRole('button', { name: "More for push's branches" }));
    await user.click(screen.getByRole('button', { name: 'Switch to branches-ignore' }));
    expect(text(store)).toContain('    branches-ignore: [main]\n');
    await user.click(screen.getByRole('button', { name: "More for push's branches-ignore" }));
    await user.click(screen.getByRole('button', { name: 'Remove filter' }));
    expect(text(store)).toBe(`on:\n  push:\n${JOBS}`);
  });

  it('narrows the types from the defaults, and asks before removing the only event', async () => {
    const before = `on:\n  pull_request:\n${JOBS}`;
    const store = opened(before, { event: 'pull_request', action: 'closed', base: 'main' });
    const user = mount(store);
    await user.click(screen.getByRole('button', { name: "Add a type to pull_request's types" }));
    await user.keyboard('closed{Enter}');
    expect(text(store)).toContain('  pull_request:\n    types: [closed]\n');
    await user.click(screen.getByRole('button', { name: 'Remove the pull_request trigger' }));
    // Nothing yet: the only event asks first.
    expect(text(store)).toContain('pull_request');
    const ask = screen.getByRole('group', { name: 'Remove pull_request?' });
    await user.click(within(ask).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('group', { name: 'Remove pull_request?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove the pull_request trigger' }));
    await user.click(screen.getByRole('button', { name: 'Remove pull_request' }));
    // `on:` is left with no value: the workflow has no trigger, and the rows say so.
    expect(text(store)).toBe(`on:\n${JOBS}`);
    expect(screen.getByText(/No event runs this workflow/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Add an event' }));
  });

  it('adds a schedule with its first cron and edits its timezone in place', async () => {
    const store = opened(`on: push\n${JOBS}`, { event: 'push', branch: 'main' });
    const user = mount(store);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add an event' }), 'schedule');
    await user.keyboard('0 6 * * 1{Enter}');
    expect(text(store)).toBe(`on:\n  push:\n  schedule:\n    - cron: '0 6 * * 1'\n${JOBS}`);
    expect(said()).toBe('added the schedule trigger');
    const timezone = screen.getByRole('textbox', { name: 'Timezone of 0 6 * * 1' });
    await user.type(timezone, 'Europe/Paris{Enter}');
    expect(text(store)).toContain("    - cron: '0 6 * * 1'\n      timezone: Europe/Paris\n");
    await user.click(screen.getByRole('button', { name: 'Add a cron to the schedule' }));
    await user.keyboard('30 5 * * *{Enter}');
    expect(text(store)).toContain("      timezone: Europe/Paris\n    - cron: '30 5 * * *'\n");
  });

  it('says a cron in GitHub’s words, or the converter’s problem with it', () => {
    const store = opened(`on:\n  schedule:\n    - cron: '0 6 * * 1'\n    - cron: '61 6 * * 1'\n${JOBS}`, {
      event: 'schedule',
    });
    mount(store);
    expect(screen.getByText('Runs at 06:00, only on Monday')).toBeTruthy();
    expect(screen.getByText(/^Invalid cron expression/)).toBeTruthy();
  });

  it('adds a dispatch input, sets its type, options and default, and keeps its name read-only', async () => {
    const store = opened(`on:\n  workflow_dispatch:\n${JOBS}`, { event: 'workflow_dispatch' });
    const user = mount(store);
    await user.click(screen.getByRole('button', { name: "Add an input to workflow_dispatch's inputs" }));
    await user.keyboard('environment{Enter}');
    expect(text(store)).toContain(
      '  workflow_dispatch:\n    inputs:\n      environment:\n        type: string\n',
    );
    expect(screen.queryByRole('textbox', { name: /^Name/ })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type of environment' }), 'choice');
    await user.click(screen.getByRole('button', { name: "Add an option to environment's options" }));
    await user.keyboard('staging{Enter}prod{Enter}{Escape}');
    await user.type(screen.getByRole('textbox', { name: 'Default of environment' }), 'staging{Enter}');
    await user.click(screen.getByRole('checkbox', { name: 'required' }));
    expect(text(store)).toContain(
      '      environment:\n        required: true\n        default: staging\n        type: choice\n        options: [staging, prod]\n',
    );
    await user.click(screen.getByRole('button', { name: 'Remove the input environment' }));
    expect(text(store)).toBe(`on:\n  workflow_dispatch:\n${JOBS}`);
  });

  it('reads the text again once typing in the pane pauses, not per key', async () => {
    const store = opened(`on: push\n${JOBS}`, { event: 'push', branch: 'main' });
    mount(store);
    act(() => void store.getState().typed(CI, [{ from: 4, to: 8, insert: 'pull_request' }]));
    expect(store.getState().edit.group?.origin).toBe('pane');
    // Still the rows of the text before the key: the burst is read once, after it.
    expect(screen.getByRole('radio', { name: 'push' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'pull_request' })).toBeTruthy());
    expect(screen.queryByRole('radio', { name: 'push' })).toBeNull();
  });

  it('says why a generated file takes no input', () => {
    const LOCK = '.github/workflows/ci.lock.yml';
    const store = opened(`# Code generated by gen. DO NOT EDIT.\non: push\n${JOBS}`, { event: 'push' }, LOCK);
    mount(store);
    expect(screen.getByText(/is generated/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Add an event' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(screen.getByRole('radio', { name: 'push' })).toBeTruthy();
  });
});
