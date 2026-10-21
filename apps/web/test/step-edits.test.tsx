// @vitest-environment happy-dom
/**
 * Steps as the builder edits them (synthesis § 4.2, § 4.4, § 4.8): the palette inserts `uses:` and nothing else where
 * it was opened for, selects the step and opens Properties; Run a script puts the focus in its Run once Properties
 * shows it; calling a workflow adds a job after this one; Change… writes the step's `uses:` alone. Properties' Steps
 * moves a step with Alt+↑/↓ keeping the focus on it, removes one with Delete, and opens the palette between rows. A
 * step that moved under a gesture is refused, and nothing is written.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import type { GestureUi } from '../src/edit/canvas/ui';
import { hostUi } from '../src/edit/canvas/ui';
import { type Gestures, gestures } from '../src/edit/gestures';
import { Palette } from '../src/edit/palette/Palette';
import { moveStep, removeStep, stepTarget, stepWords } from '../src/edit/steps/actions';
import { CanvasSteps } from '../src/edit/steps/CanvasSteps';
import { PanelSteps } from '../src/edit/steps/PanelSteps';
import { graphModel } from '../src/graph/model';
import { documents } from '../src/edit/documents';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const CI = '.github/workflows/ci.yml';
const REUSABLE = '.github/workflows/reusable.yml';

const TEXT = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: detect
        run: echo "changed=true" >> "$GITHUB_OUTPUT"
      - run: npm run build
        if: steps.detect.outputs.changed == 'true'
  call:
    uses: ./.github/workflows/reusable.yml
`;

const CALLED = `on:
  workflow_call:
jobs:
  inner:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
`;

function opened(planned = false): SessionStore {
  const store = createSessionStore();
  const s = store.getState();
  const files = { [CI]: TEXT, [REUSABLE]: CALLED };
  s.setFiles(files, { kind: 'folder', name: 'repo', readAt: 0 });
  const loaded = handle(initialState(), { id: 1, type: 'load', files });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  s.projectReady(1, loaded.response.outline, 1);
  if (planned) {
    const step = handle(loaded.state, {
      id: 2,
      type: 'simulate',
      project: 1,
      scenario: { event: 'push', branch: 'main' },
      assume: [],
      detail: 'steps',
    });
    if (step.response.type !== 'plan') throw new Error(JSON.stringify(step.response));
    const { plan, derived, text: t, ms } = step.response;
    s.planReceived({ plan, derived, text: t, ms, for: { files: 1, epoch: 1, project: 1 } });
  }
  s.setEdit(true);
  s.select(CI, 'build');
  return store;
}

function fakeUi(): GestureUi & { asks: { run: () => void; lines: string[] }[]; addedCards: string[] } {
  const asks: { run: () => void; lines: string[] }[] = [];
  const addedCards: string[] = [];
  return {
    open: vi.fn(),
    confirm: (a) => asks.push(a),
    refused: vi.fn(),
    added: (card) => addedCards.push(card),
    asks,
    addedCards,
  };
}

const text = (store: SessionStore): string => store.getState().files.byPath[CI]!;
const rev = (store: SessionStore): number => store.getState().files.revs[CI]!;

afterEach(cleanup);

describe('the palette', () => {
  function mount(store: SessionStore, index: number, change?: boolean) {
    const ui = fakeUi();
    const fp = change ? stepTarget(store, CI, 'build', index)!.step.fp : undefined;
    const onClose = vi.fn();
    render(
      <AppProvider app={{ store } as unknown as App}>
        <Palette
          open={{
            kind: 'palette',
            file: CI,
            rev: rev(store),
            job: 'build',
            index,
            ...(fp ? { change: fp } : {}),
          }}
          ui={ui}
          onClose={onClose}
        />
      </AppProvider>,
    );
    return { user: userEvent.setup(), ui, onClose };
  }

  it('inserts uses: and nothing else where it was opened for, selects the step and opens Properties', async () => {
    const store = opened();
    store.getState().togglePane('right');
    const { user } = mount(store, 1);
    expect(screen.getByRole('heading', { name: 'Add a step to build' })).toBeTruthy();
    await user.type(screen.getByRole('combobox', { name: 'Steps to add' }), 'setup{Enter}');
    expect(text(store)).toContain(
      '      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - id: detect\n',
    );
    expect(store.getState().edit.past.at(-1)?.label).toBe('Added actions/setup-node@v4 to build');
    expect(store.getState().edit.pendingSel).toMatchObject({ focus: CI, sel: 'build.#2' });
    expect(store.getState().ui.prefs).toMatchObject({ panel: 'node', collapsed: { right: false } });
  });

  it('inserts a script step and asks Properties to put the focus in its Run', async () => {
    const store = opened();
    const { user } = mount(store, 3);
    await user.type(screen.getByRole('combobox', { name: 'Steps to add' }), 'run a{Enter}');
    expect(text(store)).toContain(
      "        if: steps.detect.outputs.changed == 'true'\n      - run: echo hello\n  call:",
    );
    expect(store.getState().propertyFocus).toMatchObject({ field: 'run' });
  });

  it('adds a job after this one that calls a workflow of the repository', async () => {
    const store = opened();
    const { user, ui } = mount(store, 3);
    await user.type(screen.getByRole('combobox', { name: 'Steps to add' }), 'call{Enter}');
    expect(text(store)).toContain(
      "outputs.changed == 'true'\n  reusable:\n    uses: ./.github/workflows/reusable.yml\n  call:",
    );
    expect(store.getState().edit.past.at(-1)?.label).toBe(
      'Added job reusable after build calling ./.github/workflows/reusable.yml',
    );
    expect(ui.addedCards).toEqual([`${CI}#reusable`]);
  });

  it('changes a step’s action, writing its uses: alone, and offers actions only', async () => {
    const store = opened();
    const { user } = mount(store, 0, true);
    expect(
      screen.getByRole('heading', { name: 'Change the action of step 1 of build (actions/checkout@v4)' }),
    ).toBeTruthy();
    // Once the catalog is in, its actions follow what the repository uses, which it names.
    await screen.findByRole('group', { name: 'Common actions' });
    const used = within(screen.getByRole('group', { name: 'Used here' }));
    expect(used.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^actions\/checkout@v4Checkout · 1 use here$/),
      expect.stringMatching(/^actions\/setup-node@v4.+ · 1 use here$/),
    ]);
    expect(screen.queryByRole('option', { name: /Run a script/ })).toBeNull();
    // A browser's modal dialog gives its first control the focus; happy-dom does not.
    screen.getByRole('combobox', { name: 'Actions' }).focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(text(store)).toContain('    steps:\n      - uses: actions/setup-node@v4\n      - id: detect');
    expect(store.getState().edit.past.at(-1)?.label).toBe(
      'Changed the action of step 1 of build (actions/checkout@v4) to actions/setup-node@v4',
    );
  });
});

describe('Properties’ steps', () => {
  function mount(store: SessionStore) {
    const ui = fakeUi();
    const palette = vi.fn(() => true);
    const stopHost = hostUi.register(store, ui);
    const stopGestures = gestures.register(store, { palette } as unknown as Gestures);
    const doc = () => documents(store).of(store.getState(), CI)!;
    const view = () => (
      <AppProvider app={{ store } as unknown as App}>
        <PanelSteps doc={doc()} file={CI} job="build" locked={false} />
      </AppProvider>
    );
    const r = render(view());
    const unsubscribe = store.subscribe(() => r.rerender(view()));
    return {
      user: userEvent.setup(),
      ui,
      palette,
      stop: () => {
        unsubscribe();
        stopGestures();
        stopHost();
      },
    };
  }

  const names = () => [...document.querySelectorAll('[data-step-name]')].map((b) => b.textContent);

  it('moves a step with Alt+↓ and Alt+↑, the focus following it, and keeps the job selected', async () => {
    const store = opened();
    const { user, stop } = mount(store);
    await user.click(screen.getByRole('button', { name: '1 actions/checkout@v4' }));
    store.getState().select(CI, 'build');
    screen.getByRole('button', { name: '1 actions/checkout@v4' }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(names()).toEqual([
      '1echo "changed=true" >> "$GITHUB_OUTPUT"',
      '2actions/checkout@v4',
      '3npm run build',
    ]);
    expect(document.activeElement?.textContent).toBe('2actions/checkout@v4');
    expect(store.getState().sel).toBe('build');
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(text(store)).toBe(TEXT);
    stop();
  });

  it('asks before moving a step above the one whose outputs it reads', async () => {
    const store = opened();
    const { user, ui, stop } = mount(store);
    screen.getByRole('button', { name: /^3 npm run build/ }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(text(store)).toBe(TEXT);
    expect(ui.asks[0]!.lines[0]).toMatch(/still reads steps\.detect.*now before that step runs/);
    act(() => ui.asks[0]!.run());
    expect(names()[1]).toBe('2npm run build');
    stop();
  });

  it('removes a step with Delete, asking first when its id is still read, with Undo in the notice', async () => {
    const store = opened();
    const { user, ui, stop } = mount(store);
    screen.getByRole('button', { name: /^2 echo/ }).focus();
    await user.keyboard('{Delete}');
    expect(ui.asks[0]).toMatchObject({
      title: 'Remove step 2 of build (echo "changed=true" >> "$GITHUB_OUTPUT")?',
    });
    act(() => ui.asks[0]!.run());
    expect(names()).toEqual(['1actions/checkout@v4', '2npm run build']);
    expect(store.getState().notices.at(-1)?.text).toBe(
      'Removed step 2 of build (echo "changed=true" >> "$GITHUB_OUTPUT")',
    );
    screen.getByRole('button', { name: '1 actions/checkout@v4' }).focus();
    await user.keyboard('{Backspace}');
    expect(names()).toEqual(['1npm run build']);
    stop();
  });

  it('opens the palette between two rows and after the last', async () => {
    const store = opened();
    const { user, palette, stop } = mount(store);
    await user.click(screen.getByRole('button', { name: 'Add a step before step 2' }));
    await user.click(screen.getByRole('button', { name: '+ Add step' }));
    expect(palette.mock.calls).toEqual([[{ job: 'build', index: 1 }], [{ job: 'build', index: 3 }]]);
    stop();
  });
});

describe('a step gesture', () => {
  it('is refused when the step it read moved, writing nothing', () => {
    const store = opened();
    const ui = fakeUi();
    const target = stepTarget(store, CI, 'build', 0)!;
    // Typed in the pane meanwhile: a step above it.
    const at = text(store).indexOf('      - uses: actions/checkout@v4');
    store.getState().typed(CI, [{ from: at, to: at, insert: '      - run: echo first\n' }]);
    const moved = { ...target, rev: rev(store) };
    expect(removeStep(store, ui, moved)).toBe(true);
    expect(store.getState().edit.refused?.refusal.reason).toBe('moved');
    expect(moveStep(store, ui, moved, 1)).toBe(true);
    expect(store.getState().edit.refused?.refusal.reason).toBe('moved');
    expect(text(store)).toContain('      - run: echo first\n      - uses: actions/checkout@v4');
  });

  it('moves nothing past either end', () => {
    const store = opened();
    const ui = fakeUi();
    expect(moveStep(store, ui, stepTarget(store, CI, 'build', 0)!, -1)).toBe(false);
    expect(moveStep(store, ui, stepTarget(store, CI, 'build', 2)!, 3)).toBe(false);
    expect(text(store)).toBe(TEXT);
  });

  it('names a step as a sentence does', () => {
    expect(stepWords('build', 0, { uses: 'actions/checkout@v4' })).toBe(
      'step 1 of build (actions/checkout@v4)',
    );
    expect(stepWords('build', 2, { id: 'x' })).toBe('step 3 of build (x)');
    expect(stepWords('build', 1, {})).toBe('step 2 of build');
    expect(stepWords('b', 0, { runHead: 'a'.repeat(50) })).toBe(`step 1 of b (${'a'.repeat(39)}…)`);
  });
});

describe('the open step list of a card being edited', () => {
  function mount(store: SessionStore) {
    const s = store.getState();
    const model = graphModel(s.plan!.plan, s.plan!.derived, {
      expanded: [`${CI}#build`],
      representative: {},
      opened: [],
      hideUntriggered: false,
      only: CI,
    });
    const ui = fakeUi();
    const palette = vi.fn(() => true);
    const stopHost = hostUi.register(store, ui);
    const stopGestures = gestures.register(store, { palette } as unknown as Gestures);
    const onPick = vi.fn();
    render(
      <AppProvider app={{ store } as unknown as App}>
        <CanvasSteps job={model.jobs[`${CI}#build`]!} onPick={onPick} />
      </AppProvider>,
    );
    return { palette, onPick, stop: () => (stopGestures(), stopHost()) };
  }

  it('offers + before each step and after the last, at the places the text has them', () => {
    const store = opened(true);
    const { palette, stop } = mount(store);
    fireEvent.click(screen.getByRole('button', { name: 'Add a step before actions/checkout@v4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a step before detect' }));
    fireEvent.click(screen.getByRole('button', { name: /^Add a step after / }));
    expect(palette.mock.calls).toEqual([
      [{ job: 'build', index: 0 }],
      [{ job: 'build', index: 1 }],
      [{ job: 'build', index: 3 }],
    ]);
    stop();
  });

  it('moves a step dropped on another row to its place, the selection following it', () => {
    const store = opened(true);
    const { stop } = mount(store);
    const rows = document.querySelectorAll('li[data-step]');
    const grip = rows[0]!.querySelector('.sc-step-handle')!;
    const data = {
      types: ['application/x-simulci-step'],
      setData: vi.fn(),
      dropEffect: '',
      effectAllowed: '',
    };
    fireEvent.dragStart(grip, { dataTransfer: data });
    fireEvent.dragOver(rows[2]!, { dataTransfer: data });
    fireEvent.drop(rows[2]!, { dataTransfer: data });
    expect(text(store)).toContain(
      "        if: steps.detect.outputs.changed == 'true'\n      - uses: actions/checkout@v4\n  call:",
    );
    expect(store.getState().edit.pendingSel).toMatchObject({ sel: 'build.#3' });
    stop();
  });

  it('acts on no step known only by its place while the plan lags the text', () => {
    const store = opened(true);
    const at = text(store).indexOf('      - uses: actions/checkout@v4');
    store.getState().typed(CI, [{ from: at, to: at, insert: '      - run: echo first\n' }]);
    const { palette, stop } = mount(store);
    // + after checkout reads checkout's place: refused while the plan is behind. Before the first, there is no doubt.
    fireEvent.click(screen.getByRole('button', { name: 'Add a step before detect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a step before actions/checkout@v4' }));
    expect(palette.mock.calls).toEqual([[{ job: 'build', index: 0 }]]);
    stop();
  });
});
