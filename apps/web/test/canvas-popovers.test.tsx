// @vitest-environment happy-dom
/**
 * Add job and What it needs (synthesis § 4.2): Add job offers a free id, the runner and the need of the job it follows
 * and Checkout at the repository's ref, says under the field why a typed id cannot be one, and adds on Enter; What it
 * needs lists the jobs that can be needed without a loop, adds the one picked with Enter, and takes the last need away
 * with Backspace in the empty input, asking first when an expression still reads it.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { AddJobPopover } from '../src/edit/canvas/AddJob';
import { NeedsPopover } from '../src/edit/canvas/Needs';
import type { Ask, GestureUi } from '../src/edit/canvas/actions';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const CI = '.github/workflows/ci.yml';

const TEXT = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  build:
    needs: test
    runs-on: macos-14
    steps:
      - run: npm run build
  deploy:
    needs: [test, build]
    if: needs.build.outputs.ok == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;

function opened(): SessionStore {
  const store = createSessionStore();
  const s = store.getState();
  const files = { [CI]: TEXT };
  s.setFiles(files, { kind: 'folder', name: 'repo', readAt: 0 });
  const loaded = handle(initialState(), { id: 1, type: 'load', files });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  s.projectReady(1, loaded.response.outline, 1);
  s.setEdit(true);
  return store;
}

function fakeUi() {
  const asks: Ask[] = [];
  const ui: GestureUi = { open: vi.fn(), confirm: (a) => asks.push(a), refused: vi.fn(), added: vi.fn() };
  return { ui, asks };
}

const text = (store: SessionStore): string => store.getState().files.byPath[CI]!;
const rev = (store: SessionStore): number => store.getState().files.revs[CI]!;

afterEach(cleanup);

describe('Add job', () => {
  function mount(store: SessionStore, after?: string) {
    const { ui } = fakeUi();
    const onClose = vi.fn();
    render(
      <AppProvider app={{ store } as unknown as App}>
        <AddJobPopover
          open={{ kind: 'addJob', file: CI, rev: rev(store), ...(after ? { after } : {}) }}
          ui={ui}
          onClose={onClose}
        />
      </AppProvider>,
    );
    return { user: userEvent.setup(), onClose, ui };
  }

  it('offers a free id with the focus, the runner and the need of the job it follows, and Checkout at the ref used here', () => {
    const store = opened();
    mount(store, 'build');
    const id = screen.getByRole<HTMLInputElement>('textbox', { name: 'Id' });
    expect(id.value).toBe('job');
    expect(document.activeElement).toBe(id);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Runs on' }).value).toBe('macos-14');
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'build' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'test' }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Start with Checkout/ }).checked).toBe(
      true,
    );
    expect(screen.getByText('actions/checkout@v4')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add a job after build' })).toBeTruthy();
  });

  it('says why a typed id cannot be one, and adds nothing on Enter until it can', async () => {
    const store = opened();
    const { user, onClose } = mount(store, 'build');
    const id = screen.getByRole('textbox', { name: 'Id' });
    await user.clear(id);
    await user.type(id, 'Deploy{Enter}');
    expect(id.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('A job deploy already exists; ids ignore case.')).toBeTruthy();
    expect(text(store)).toBe(TEXT);
    expect(onClose).not.toHaveBeenCalled();
    await user.clear(id);
    await user.type(id, 'e2e{Enter}');
    expect(text(store)).toContain(
      '  e2e:\n    runs-on: macos-14\n    needs: build\n    steps:\n      - uses: actions/checkout@v4\n',
    );
    expect(text(store).indexOf('  e2e:')).toBeLessThan(text(store).indexOf('  deploy:'));
    expect(onClose).toHaveBeenCalled();
    expect(store.getState().edit.past.at(-1)?.label).toBe('Added job e2e after build');
  });

  it('adds an independent job last, without a first step when Checkout is left out', async () => {
    const store = opened();
    const { user } = mount(store);
    await user.click(screen.getByRole('checkbox', { name: /Start with Checkout/ }));
    await user.click(screen.getByRole('button', { name: 'Add job' }));
    expect(text(store).endsWith('  job:\n    runs-on: ubuntu-latest\n')).toBe(true);
  });
});

describe('What it needs', () => {
  function mount(store: SessionStore, job: string) {
    const { ui, asks } = fakeUi();
    render(
      <AppProvider app={{ store } as unknown as App}>
        <NeedsPopover open={{ kind: 'needs', file: CI, rev: rev(store), job }} ui={ui} onClose={vi.fn()} />
      </AppProvider>,
    );
    return { user: userEvent.setup(), asks };
  }

  it('lists what the job needs, and offers the jobs it can need without a loop', () => {
    const store = opened();
    mount(store, 'build');
    expect(screen.getByRole('list', { name: 'build needs' }).textContent).toContain('test');
    const box = screen.getByRole('combobox', { name: 'Add a need to build' });
    expect(document.activeElement).toBe(box);
    // deploy needs build: build needing it would loop.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['lint']);
  });

  it('adds the job picked with Enter, the arrows walking the list, and the typed text narrowing it', async () => {
    const store = opened();
    const { user } = mount(store, 'lint');
    const box = screen.getByRole('combobox', { name: 'Add a need to lint' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['test', 'build', 'deploy']);
    await user.keyboard('{ArrowDown}');
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id);
    await user.keyboard('{Enter}');
    expect(text(store)).toContain('  lint:\n    runs-on: ubuntu-latest\n    needs: build\n');
    await user.type(box, 'dep{Enter}');
    expect(text(store)).toContain('  lint:\n    runs-on: ubuntu-latest\n    needs: [build, deploy]\n');
    expect(store.getState().edit.past.map((t) => t.label)).toEqual([
      'Connected build to lint',
      'Connected deploy to lint',
    ]);
  });

  it('takes the last need away with Backspace in the empty input, asking first when it is still read', async () => {
    const store = opened();
    const { user, asks } = mount(store, 'deploy');
    screen.getByRole('combobox', { name: 'Add a need to deploy' }).focus();
    await user.keyboard('{Backspace}');
    expect(text(store)).toBe(TEXT);
    expect(asks[0]).toMatchObject({ title: "Remove deploy's need on build?" });
    act(() => asks[0]!.run());
    expect(text(store)).toContain('    needs: [test]\n');
    // A chip's button takes its need away; nothing reads needs.test.
    await user.click(screen.getByRole('button', { name: 'Remove test' }));
    expect(text(store)).not.toMatch(/deploy:\n {4}needs/);
    expect(store.getState().notices.map((n) => n.text)).toEqual([
      "Removed deploy's need on build",
      "Removed deploy's need on test",
    ]);
  });
});
