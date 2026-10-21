// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { ChangesButton } from '../src/app/ChangesButton';
import { AppProvider } from '../src/app/providers';
import { createReplacePrompt } from '../src/app/replace';
import { ReplacePrompt } from '../src/app/ReplaceDialog';
import type { ReplaceChoice } from '../src/input/sources';
import { createSessionStore, dirtyPaths, type SessionStore } from '../src/state/store';

/**
 * The Changes dialog over a store: the top bar's button with the unsaved count, each changed file with its counts and
 * diff, Revert as an undoable entry with Undo beside it; and the replace prompt, whose main answer is one patch once
 * several files would be dropped.
 */

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';

afterEach(cleanup);

function edited(): SessionStore {
  const store = createSessionStore();
  store
    .getState()
    .setFiles(
      { [CI]: 'name: CI\non: push\njobs: {}\n', [RELEASE]: 'on: release\n' },
      { kind: 'folder', name: 'repo', readAt: 0 },
    );
  store.getState().transact({
    label: 'Op',
    origin: 'op',
    files: [{ path: CI, edits: [{ from: 13, to: 17, insert: '[push, pull_request]' }] }],
  });
  return store;
}

const renderWith = (store: SessionStore, app: Partial<App> = {}) =>
  render(
    <AppProvider app={{ store, ...app } as unknown as App}>
      <ChangesButton />
      <ReplacePrompt />
    </AppProvider>,
  );

describe('the Changes dialog', () => {
  it('shows nothing outside edit mode while nothing is unsaved', () => {
    const store = createSessionStore();
    renderWith(store);
    expect(screen.queryByRole('button', { name: /^Changes/ })).toBeNull();
    act(() => store.getState().setEdit(true));
    expect(screen.getByRole('button', { name: 'Changes' })).toBeTruthy();
  });

  it('lists a changed file with its counts and diff, reverts it as one undoable entry, and undoes that', async () => {
    const store = edited();
    renderWith(store);
    await userEvent.click(screen.getByRole('button', { name: 'Changes (1)' }));
    // The dialog is in the dialogs chunk, which the first open fetches.
    const dialog = await screen.findByRole('dialog', { name: 'Changes' });
    const file = within(dialog).getByRole('region', { name: CI });
    expect(file.textContent).toContain('1 line added, 1 removed');
    expect(within(file).getByLabelText(`Changes to ${CI}`).textContent).toBe(
      '@@ -1,3 +1,3 @@ name: CI-on: push+on: [push, pull_request] jobs: {}',
    );
    await userEvent.click(within(file).getByRole('button', { name: `Revert ${CI}` }));
    expect(dirtyPaths(store.getState().files)).toEqual([]);
    expect(dialog.textContent).toContain('Nothing changed since the files were last saved.');
    expect(within(dialog).getByRole('status').textContent).toContain('Reverted ci.yml.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(store.getState().files.byPath[CI]).toBe('name: CI\non: [push, pull_request]\njobs: {}\n');
    expect(within(dialog).getByRole('status').textContent).toBe('');
    expect(within(dialog).getByRole('region', { name: CI })).toBeTruthy();
  });

  it('marks a file created since and one removed since, and offers no download of a removed file', async () => {
    const store = edited();
    store.getState().transact({
      label: 'Op',
      origin: 'op',
      files: [
        { path: RELEASE, edits: [], remove: true },
        {
          path: '.github/workflows/new.yml',
          edits: [{ from: 0, to: 0, insert: 'on: push\n' }],
          create: true,
        },
      ],
    });
    renderWith(store);
    await userEvent.click(screen.getByRole('button', { name: 'Changes (3)' }));
    const removed = await screen.findByRole('region', { name: RELEASE });
    expect(removed.textContent).toContain('removed');
    expect(within(removed).queryByRole('button', { name: /^Download/ })).toBeNull();
    const created = screen.getByRole('region', { name: '.github/workflows/new.yml' });
    expect(created.textContent).toContain('created');
    expect(within(created).getByRole('button', { name: 'Download .github/workflows/new.yml' })).toBeTruthy();
  });
});

describe('the replace prompt', () => {
  async function ask(
    paths: string[],
  ): Promise<{ main: string; answer: (name: string) => Promise<ReplaceChoice> }> {
    const store = createSessionStore();
    const prompt = createReplacePrompt(store);
    renderWith(store, { prompt });
    let answered: Promise<ReplaceChoice> = Promise.resolve('cancel');
    act(() => {
      answered = prompt.ask('Opening the monorepo sample', paths);
    });
    const dialog = screen.getByRole('dialog', { name: 'Unsaved edits' });
    const main = within(dialog)
      .getAllByRole('button')
      .find((b) => b.className.includes('bg-accent'))!.textContent;
    return {
      main,
      answer: async (name) => {
        await userEvent.click(within(dialog).getByRole('button', { name }));
        return answered;
      },
    };
  }

  it('makes one patch the main answer when several files have unsaved edits', async () => {
    const several = await ask([CI, RELEASE]);
    expect(several.main).toBe('Download patch');
    expect(await several.answer('Download patch')).toBe('patch');
    cleanup();
    const one = await ask([CI]);
    expect(one.main).toBe('Download it first');
    expect(await one.answer('Download patch')).toBe('patch');
  });
});
