// @vitest-environment happy-dom
/**
 * The adversarial review of renames, the keys and where they point (synthesis § 9.5; PR #76): F2 renames the node the
 * focus is on where the keys act on a focused row (an outline row the arrows reached, a step row of Properties); a
 * leg whose matrix value holds `/` or brackets is still a node of the file; and a rename taken from a row's menu opens
 * at the row, not at the menu that closed.
 */
import { simulate } from '@simulci/engine';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { installShortcuts } from '../src/app/shortcuts';
import { gesturesOf } from '../src/edit/canvas/actions';
import { RowMenu } from '../src/edit/canvas/Menu';
import { type GestureUi, hostUi, type Open } from '../src/edit/canvas/ui';
import { documents } from '../src/edit/documents';
import { gestures } from '../src/edit/gestures';
import { PanelSteps } from '../src/edit/steps/PanelSteps';
import { OutlineTree } from '../src/panels/OutlineTree';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { deriveTables } from '../src/worker/derived';
import { CI, disposeSessions, opened } from './rename-harness';

afterEach(() => {
  cleanup();
  disposeSessions();
});

/** The edit runtime's gestures on a store, answering with what they would open. */
function gesturing(store: SessionStore) {
  const opens: Open[] = [];
  const ui: GestureUi = {
    open: (o) => void opens.push(o),
    confirm: vi.fn(),
    refused: vi.fn(),
    added: vi.fn(),
  };
  const stops = [hostUi.register(store, ui), gestures.register(store, gesturesOf(store, ui))];
  const renames = () =>
    opens.flatMap((o) => (o.kind === 'rename' ? [{ job: o.target.job, step: o.target.step?.index }] : []));
  return { opens, ui, renames, stop: () => stops.forEach((s) => s()) };
}

/** A store showing the plan of the files, simulated here, in edit mode. */
function planned(files: Record<string, string>): SessionStore {
  const store = createSessionStore();
  store.getState().setFiles(files, { kind: 'folder', name: 'repo', readAt: 0 });
  const plan = simulate({ files, scenario: { event: 'push' }, assume: [], detail: 'steps' });
  const derived = deriveTables(plan, { files: [], workflows: [], events: {} });
  const { version, epoch } = store.getState().files;
  store.setState({
    plan: {
      plan,
      derived,
      text: '',
      ms: { simulate: 0, derive: 0 },
      for: { files: version, epoch, project: 1 },
    },
    focus: CI,
  });
  store.getState().setEdit(true);
  return store;
}

const TWO = {
  [CI]: 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: make }]\n  test:\n    needs: build\n    runs-on: ubuntu-latest\n    steps: [{ run: npm test }]\n',
};

describe('F2 on a focused row', () => {
  it('renames the outline row the arrows reached, not the selection, with the input at that row', async () => {
    const store = planned(TWO);
    const g = gesturing(store);
    const stopKeys = installShortcuts(store, window);
    render(
      <AppProvider app={{ store } as unknown as App}>
        <OutlineTree />
      </AppProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('treeitem', { name: 'build, runs' }));
    await user.keyboard('{ArrowDown}');
    const row = screen.getByRole('treeitem', { name: 'test, runs' });
    expect(store.getState().sel).toBe('build');
    act(() => {
      fireEvent.keyDown(row, { key: 'F2' });
    });
    stopKeys();
    g.stop();
    expect(g.renames()).toEqual([{ job: 'test', step: undefined }]);
    expect(g.opens.find((o) => o.kind === 'rename')?.anchor).toBe(row);
    expect(store.getState().sel).toBe('test');
  });

  it('renames the Properties step row it is on, the job staying selected', () => {
    const text =
      'on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n      - id: detect\n        run: echo\n';
    const store = createSessionStore();
    store.getState().setFiles({ [CI]: text }, { kind: 'folder', name: 'repo', readAt: 0 });
    store.getState().setEdit(true);
    store.getState().select(CI, 'build');
    const g = gesturing(store);
    const stopKeys = installShortcuts(store, window);
    render(
      <AppProvider app={{ store } as unknown as App}>
        <PanelSteps doc={documents(store).of(store.getState(), CI)!} file={CI} job="build" locked={false} />
      </AppProvider>,
    );
    const row = screen.getByRole('button', { name: /^2 echo/ });
    row.focus();
    act(() => {
      fireEvent.keyDown(row, { key: 'F2' });
    });
    stopKeys();
    g.stop();
    expect(g.renames()).toEqual([{ job: 'build', step: 1 }]);
    expect(store.getState().sel).toBe('build');
  });
});

describe('F2 on a leg whose matrix value holds / or brackets', () => {
  it.each([
    ['a slash', '[packages/a, packages/b]', 'build[dir=packages/a]'],
    ['brackets', "['.[dev]', '.[test]']", 'build[dir=.[dev]]'],
    ['neither', '[a, b]', 'build[dir=a]'],
  ])('renames the leg’s job, or its step (%s)', async (_, values, leg) => {
    const wf = `on: push\njobs:\n  build:\n    runs-on: x\n    strategy: { matrix: { dir: ${values} } }\n    steps:\n      - id: detect\n        run: echo\n`;
    const { store } = await opened({ [CI]: wf });
    store.getState().setEdit(true);
    const g = gesturing(store);
    const win = new EventTarget() as unknown as Window;
    const stopKeys = installShortcuts(store, win);
    const f2 = (sel: string): boolean => {
      store.getState().select(CI, sel);
      const event = new KeyboardEvent('keydown', { key: 'F2', cancelable: true });
      win.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const taken = [f2(`${leg}.detect`), f2(leg)];
    stopKeys();
    g.stop();
    expect(taken).toEqual([true, true]);
    expect(g.renames()).toEqual([
      { job: 'build', step: 0 },
      { job: 'build', step: undefined },
    ]);
  });
});

describe('Rename from a row’s menu', () => {
  it('opens at the row, which has the focus back when the menu closes', async () => {
    const store = planned({
      [CI]: 'on: push\njobs:\n  build:\n    runs-on: x\n    steps: [{ run: make }]\n',
    });
    let show: (o: Open | undefined) => void = () => undefined;
    const opens: Open[] = [];
    const ui: GestureUi = {
      open: (o) => {
        opens.push(o);
        show(o);
      },
      confirm: vi.fn(),
      refused: vi.fn(),
      added: vi.fn(),
    };
    const stop = gestures.register(store, gesturesOf(store, ui));
    function Host() {
      const [open, setOpen] = useState<Open>();
      show = setOpen;
      return open?.kind === 'menu' ? (
        <RowMenu node={open.node} anchor={open.anchor} onClose={() => setOpen(undefined)} />
      ) : null;
    }
    render(
      <AppProvider app={{ store } as unknown as App}>
        <OutlineTree />
        <Host />
      </AppProvider>,
    );
    const user = userEvent.setup();
    const row = screen.getByRole('treeitem', { name: 'build, runs' });
    await user.pointer({ keys: '[MouseRight]', target: row });
    await act(() => user.click(screen.getByRole('menuitem', { name: /Rename build/ })));
    stop();
    expect(opens.find((o) => o.kind === 'rename')?.anchor).toBe(row);
  });
});
