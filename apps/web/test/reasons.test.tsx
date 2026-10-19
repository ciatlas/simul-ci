// @vitest-environment happy-dom
import type { ScenarioInput } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { sampleByName } from '../src/input/samples';
import { Reasons } from '../src/panels/Reasons';
import { DEFAULT_PREFS } from '../src/state/prefs';
import { createSessionStore, initialSessionState, type PlanState } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const starter = sampleByName('starter')!.files;
const CI = '.github/workflows/ci.yml';

function planState(scenario: ScenarioInput): PlanState {
  const loaded = handle(initialState(), { id: 1, type: 'load', files: starter, repository: 'o/r' });
  const step = handle(loaded.state, {
    id: 2,
    type: 'simulate',
    project: 1,
    scenario,
    assume: [],
    detail: 'steps',
  });
  if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
  const { plan, derived, text, ms } = step.response;
  return { plan, derived, text, ms, for: { files: 1, project: 1 } };
}

const push = planState({ event: 'push', branch: 'main' });

function mount(options: { plan?: PlanState | null; sel?: string; left?: boolean } = {}) {
  const initial = initialSessionState({
    ...DEFAULT_PREFS,
    collapsed: { ...DEFAULT_PREFS.collapsed, left: options.left ?? false },
  });
  const plan = options.plan === null ? {} : { plan: options.plan ?? push };
  const store = createSessionStore({ ...initial, ...plan, focus: CI, sel: options.sel });
  render(
    <AppProvider app={{ store } as unknown as App}>
      <Reasons />
    </AppProvider>,
  );
  return { store, user: userEvent.setup() };
}

/** The chain's own rows; the chips inside them are lists of their own. */
const rows = () =>
  Array.from(screen.getByRole('list', { name: 'Reasons in evaluation order' }).children) as HTMLElement[];
const decided = () => rows().filter((row) => row.textContent?.includes('decided here'));

describe('the Reasons tab', () => {
  afterEach(cleanup);

  it('says there is no plan yet before the first one', () => {
    mount({ plan: null });
    expect(screen.getByText(/No plan yet/)).toBeTruthy();
  });

  it("shows the focused workflow's trigger chain, the undecided paths-ignore filter decided here", () => {
    mount();
    expect(screen.getByRole('article', { name: 'Reasons for CI' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'CI' })).toBeTruthy();
    expect(screen.getByText('might run')).toBeTruthy();
    expect(rows()).toHaveLength(3);
    const [row] = decided();
    expect(decided()).toHaveLength(1);
    expect(row).toBe(rows()[2]);
    expect(row!.textContent).toContain('paths-ignore');
    expect(within(row!).getByRole('img', { name: 'undecided' })).toBeTruthy();
    expect(within(rows()[0]!).getByRole('img', { name: 'passes' })).toBeTruthy();
  });

  it('asks the form for the changed files, and opens the scenario column first when it is closed', async () => {
    const { store, user } = mount({ left: true });
    const set = screen.getByRole('button', { name: 'Set changed files' });
    await user.click(set);
    expect(store.getState().fieldFocus).toMatchObject({ path: 'changed' });
    expect(store.getState().ui.prefs.collapsed.left).toBe(false);
    // The request is the form's to act on: the focus stays where the author left it.
    expect(document.activeElement).toBe(set);
  });

  it('opens the YAML pane on the line the deciding reason is written on', async () => {
    const { store, user } = mount();
    await user.click(
      within(decided()[0]!).getByRole('button', { name: `ci.yml:5 in the YAML pane (${CI} line 5)` }),
    );
    expect(store.getState().reveal).toMatchObject({ file: CI, line: 5 });
  });

  it('copies the unit path, and selects it when the clipboard refuses', async () => {
    mount({ sel: 'deploy' });
    // After user-event, which installs a clipboard of its own.
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copy = screen.getByRole('button', { name: 'Copy the unit path' });
    await act(async () => fireEvent.click(copy));
    expect(writeText).toHaveBeenCalledWith('deploy');
    expect(screen.getByRole('status').textContent).toBe('copied');
    await act(async () => fireEvent.click(copy));
    expect(screen.getByRole('status').textContent).toContain('copy refused');
    expect(window.getSelection()?.toString()).toBe('deploy');
  });

  it("reads deploy's if: and selects its workflow from the parent row", async () => {
    const { store, user } = mount({ sel: 'deploy' });
    const table = screen.getByRole('table', { name: 'What the condition reads' });
    expect(within(table).getByText('github.event_name')).toBeTruthy();
    expect(within(table).getByText('push')).toBeTruthy();
    expect(screen.getByText("github.event_name == 'push' || inputs.deploy")).toBeTruthy();
    expect(screen.getByText(/evaluated with the implicit success\(\)/)).toBeTruthy();
    expect(decided()[0]!.textContent).toContain('Its workflow might not be triggered');
    await user.click(screen.getByRole('button', { name: 'Select CI' }));
    expect([store.getState().focus, store.getState().sel]).toEqual([CI, undefined]);
    // The button left with deploy's rows; the focus stays in the tab.
    expect(document.activeElement).toBe(screen.getByRole('article', { name: 'Reasons for CI' }));
  });

  it('opens the Unknowns tab from an unknown the condition reads, and the Node tab for the effects', async () => {
    const labeled = planState({
      event: 'pull_request',
      base: 'main',
      head: 'topic',
      number: 1,
      action: 'labeled',
    });
    const { store, user } = mount({ plan: labeled, sel: 'preview' });
    await user.click(
      screen.getByRole('button', { name: 'Show github.event.pull_request.labels.*.name in Unknowns' }),
    );
    expect(store.getState().ui.prefs.panel).toBe('unknowns');
    await user.click(screen.getByRole('button', { name: 'Effects in the Node tab' }));
    expect(store.getState().ui.prefs.panel).toBe('node');
  });

  it('follows the selection', () => {
    const { store } = mount();
    act(() => store.getState().select(CI, 'build'));
    expect(screen.getByRole('article', { name: 'Reasons for build' })).toBeTruthy();
  });
});
