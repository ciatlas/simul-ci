// @vitest-environment happy-dom
/**
 * The rename popover (synthesis § 4.2): the id selected in an input over the title, why a typed id cannot be one, Enter
 * listing every line the rename writes with Rename focused, Rename committing one entry, and the job's new card asked
 * to take the focus once it is drawn.
 */
import type { ReferenceTarget } from '@simulci/engine';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import type { GestureUi } from '../src/edit/canvas/ui';
import { RenamePopover } from '../src/edit/rename/Rename';
import type { FoundRefs } from '../src/engine/session';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { handle, initialState } from '../src/worker/handle';

const CI = '.github/workflows/ci.yml';

const TEXT = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
  deploy:
    needs: build
    if: needs.build.result == 'success'
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
`;

function opened(): SessionStore {
  const store = createSessionStore();
  const s = store.getState();
  s.setFiles({ [CI]: TEXT }, { kind: 'folder', name: 'repo', readAt: 0 });
  const loaded = handle(initialState(), { id: 1, type: 'load', files: { [CI]: TEXT } });
  if (loaded.response.type !== 'loaded') throw new Error(JSON.stringify(loaded.response));
  s.projectReady(1, loaded.response.outline, store.getState().files.version);
  s.setEdit(true);
  return store;
}

/** The session's `refs`, answered by the worker's handler over the store's texts now. */
const sessionOf = (store: SessionStore) => ({
  refs: vi.fn(async (target: ReferenceTarget): Promise<FoundRefs> => {
    const s = store.getState();
    const loaded = handle(initialState(), { id: 1, type: 'load', files: s.files.byPath });
    if (loaded.response.type !== 'loaded') throw new Error('not loaded');
    const r = handle(loaded.state, {
      id: 2,
      type: 'refs',
      project: loaded.response.project,
      target,
    }).response;
    if (r.type !== 'refs') throw new Error(JSON.stringify(r));
    return {
      ok: true,
      project: 1,
      files: s.files.version,
      revs: s.files.revs,
      refs: r.refs,
      exact: r.exact,
      notes: r.notes,
    };
  }),
});

afterEach(cleanup);

function mount(store: SessionStore) {
  const added = vi.fn();
  const ui: GestureUi = { open: vi.fn(), confirm: vi.fn(), refused: vi.fn(), added };
  const onClose = vi.fn();
  const session = sessionOf(store);
  render(
    <AppProvider app={{ store, session } as unknown as App}>
      <RenamePopover
        open={{ kind: 'rename', target: { file: CI, rev: store.getState().files.revs[CI]!, job: 'build' } }}
        ui={ui}
        onClose={onClose}
      />
    </AppProvider>,
  );
  return { added, onClose, session };
}

describe('Rename', () => {
  it('holds the id with the focus, and says why a typed id cannot be the new one', async () => {
    const store = opened();
    const { session } = mount(store);
    const input = screen.getByRole('textbox', { name: 'New id for job build' });
    expect(input).toHaveProperty('value', 'build');
    expect(document.activeElement).toBe(input);
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, 'Deploy{Enter}');
    expect(screen.getByText('A job deploy already exists; ids ignore case.')).toBeTruthy();
    await user.clear(input);
    await user.type(input, '9lives{Enter}');
    expect(screen.getByText('Job ids start with a letter or _, then letters, digits, - or _.')).toBeTruthy();
    expect(session.refs).not.toHaveBeenCalled();
  });

  it('lists every line it writes on Enter, then renames with Rename, one entry, the new card asked to take the focus', async () => {
    const store = opened();
    const { added, onClose, session } = mount(store);
    const input = screen.getByRole('textbox', { name: 'New id for job build' });
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, 'compile{Enter}');
    const review = await screen.findByRole('dialog', { name: 'Rename build to compile' });
    expect(session.refs).toHaveBeenCalledWith({ kind: 'job', workflow: CI, job: 'build' });
    expect(review.textContent).toContain(
      '3 places on 3 lines of ci.yml: the key, 1 needs entry and 1 expression read.',
    );
    expect([...review.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '3build:',
      '8needs: build',
      "9if: needs.build.result == 'success'",
    ]);
    const rename = screen.getByRole('button', { name: 'Rename' });
    expect(document.activeElement).toBe(rename);
    await act(() => user.click(rename));
    expect(store.getState().files.byPath[CI]).toBe(
      TEXT.replaceAll('build:', 'compile:')
        .replace('needs: build', 'needs: compile')
        .replace('needs.build', 'needs.compile'),
    );
    expect(store.getState().edit.past.map((t) => t.label)).toEqual(['Renamed job build to compile']);
    expect(added).toHaveBeenCalledWith(`${CI}#compile`, store.getState().files.version);
    expect(onClose).toHaveBeenCalled();
  });

  it('lists again, writing nothing, when the text changed after the list was made', async () => {
    const store = opened();
    const { onClose, session } = mount(store);
    const input = screen.getByRole('textbox', { name: 'New id for job build' });
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, 'compile{Enter}');
    await screen.findByRole('dialog', { name: 'Rename build to compile' });
    act(() => {
      store.getState().typed(CI, [{ from: 0, to: 0, insert: '# CI\n' }], 'paste');
    });
    await act(() => user.click(screen.getByRole('button', { name: 'Rename' })));
    const again = await screen.findByText('ci.yml changed since; this is what the rename changes now.');
    expect(again).toBeTruthy();
    expect(session.refs).toHaveBeenCalledTimes(2);
    expect(store.getState().edit.past.map((t) => t.label)).not.toContain('Renamed job build to compile');
    expect(onClose).not.toHaveBeenCalled();
  });
});
