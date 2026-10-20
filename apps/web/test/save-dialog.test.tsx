// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { createReplacePrompt } from '../src/app/replace';
import { ReplacePrompt } from '../src/app/ReplaceDialog';
import { SaveButton, SaveDialogs, SaveLine } from '../src/app/SaveDialog';
import { COPY_NOTE, createSaver, type Saver } from '../src/app/saver';
import { type Choices, diskStamp, type DiskConflict } from '../src/input/save';
import type { ReplaceChoice } from '../src/input/sources';
import { createSessionStore, type SessionStore } from '../src/state/store';
import { fakeFolder } from './fake-folder';

/**
 * The save's controls over a store: Save beside the unsaved count, the replace prompt's Save, the conflicts dialog that
 * writes nothing until every file has a choice, and the report of a save that left something unsaved.
 */

const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';

afterEach(cleanup);

function folderStore(handle?: FileSystemDirectoryHandle): SessionStore {
  const store = createSessionStore();
  const source = { kind: 'folder' as const, name: 'repo', readAt: 0, ...(handle ? { handle } : {}) };
  store.getState().setFiles({ [CI]: 'on: push\n', [RELEASE]: 'on: release\n' }, source);
  return store;
}

const edit = (store: SessionStore, path = CI): void => {
  act(() => {
    store
      .getState()
      .transact({ label: 'Op', origin: 'op', files: [{ path, edits: [{ from: 0, to: 0, insert: '#' }] }] });
  });
};

const renderWith = (store: SessionStore, app: Partial<App> = {}) =>
  render(
    <AppProvider app={{ store, ...app } as unknown as App}>
      <SaveButton />
      <SaveLine />
      <SaveDialogs />
      <ReplacePrompt />
    </AppProvider>,
  );

/** A saver that only counts its saves; its conflicts are answered through the real one's prompt. */
function countingSaver(store: SessionStore): Saver & { saves: number } {
  const real = createSaver({ store, now: () => 0 });
  const saver = {
    ...real,
    saves: 0,
    save: () => {
      saver.saves++;
      return Promise.resolve(true);
    },
  };
  return saver;
}

describe('Save', () => {
  it('shows for a folder opened with a handle only, the main button while something is unsaved', async () => {
    renderWith(folderStore());
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
    cleanup();
    const store = folderStore(fakeFolder({}).handle);
    const saver = countingSaver(store);
    renderWith(store, { saver });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.getAttribute('aria-keyshortcuts')).toBe('Control+S Meta+S');
    await userEvent.click(save);
    expect(saver.saves).toBe(0);
    edit(store);
    expect(save.getAttribute('aria-disabled')).toBe('false');
    expect(save.className).toContain('bg-accent');
    await userEvent.click(save);
    expect(saver.saves).toBe(1);
  });

  it('says “Save…” when the browser will ask for write access first', async () => {
    const store = folderStore(fakeFolder({}, { query: 'prompt' }).handle);
    renderWith(store, { saver: countingSaver(store) });
    edit(store);
    expect(await screen.findByRole('button', { name: 'Save…' })).toBeTruthy();
  });

  it('is the main answer of the replace prompt when the files can be saved', async () => {
    const store = folderStore(fakeFolder({}).handle);
    const prompt = createReplacePrompt(store);
    renderWith(store, { prompt, saver: countingSaver(store) });
    let answered: Promise<ReplaceChoice> = Promise.resolve('cancel');
    act(() => {
      answered = prompt.ask('Opening the monorepo sample', [CI, RELEASE]);
    });
    const dialog = screen.getByRole('dialog', { name: 'Unsaved edits' });
    expect(dialog.textContent).toContain('Save writes them to repo first.');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Discard edits', 'Download patch', 'Save']);
    expect(buttons.at(-1)!.className).toContain('bg-accent');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await answered).toBe('save');
  });
});

describe('the conflicts dialog', () => {
  const conflicts: DiskConflict[] = [
    {
      path: CI,
      reason: 'changed-on-disk',
      base: 'on: push\n',
      mine: '#on: push\n',
      disk: { text: 'on: pull_request\n', meta: { bom: false, eol: 'lf', utf8: true } },
    },
    { path: RELEASE, reason: 'deleted-on-disk', base: 'on: release\n', mine: '#on: release\n' },
  ];

  it('goes on only once every file has a choice, with the stamp of the folder’s file it was made against', async () => {
    const store = folderStore(fakeFolder({}).handle);
    const saver = createSaver({ store });
    renderWith(store, { saver });
    let answer: Promise<Choices | undefined> = Promise.resolve(undefined);
    act(() => {
      answer = saver.settle('save', 'repo', conflicts);
    });
    const dialog = screen.getByRole('dialog', { name: 'Changed on disk' });
    const ci = within(dialog).getByRole('region', { name: CI });
    expect(ci.textContent).toContain('ci.yml changed on disk since it was opened or last saved.');
    expect(within(dialog).getByRole('region', { name: RELEASE }).textContent).toContain(
      'release.yml is gone from the folder.',
    );
    expect(within(ci).getByLabelText('ci.yml: what the folder changed').textContent).toContain(
      '+on: pull_request',
    );
    expect(within(ci).getByLabelText('ci.yml: what you changed').textContent).toContain('+#on: push');
    const go = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await userEvent.click(within(ci).getByLabelText('Overwrite with mine'));
    expect(go.disabled).toBe(true);
    await userEvent.click(
      within(within(dialog).getByRole('region', { name: RELEASE })).getByLabelText('Keep the disk version'),
    );
    expect(go.disabled).toBe(false);
    await userEvent.click(go);
    expect(await answer).toEqual({
      [CI]: { choice: 'mine', stamp: diskStamp(conflicts[0]!.disk) },
      [RELEASE]: { choice: 'disk', stamp: '-' },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('answers nothing on Cancel, and names the reload’s choices as a reload', async () => {
    const store = folderStore(fakeFolder({}).handle);
    const saver = createSaver({ store });
    renderWith(store, { saver });
    let answer: Promise<Choices | undefined> = Promise.resolve({});
    act(() => {
      answer = saver.settle('reload', 'repo', conflicts.slice(0, 1));
    });
    const dialog = screen.getByRole('dialog', { name: 'Reload repo: changed on both sides' });
    expect(within(dialog).getByLabelText('Keep mine')).toBeTruthy();
    expect(within(dialog).getByLabelText('Take the disk version')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await answer).toBeUndefined();
    expect(store.getState().settling).toBeUndefined();
  });
});

describe('the save report', () => {
  it('lists each file when one is not saved, in the dialog and the status line; Retry saves again', async () => {
    const store = folderStore(fakeFolder({}).handle);
    const saver = countingSaver(store);
    renderWith(store, { saver });
    edit(store, RELEASE);
    act(() =>
      store.getState().setSaving({
        status: 'done',
        folder: 'repo',
        at: 0,
        files: [
          { path: CI, status: 'saved' },
          { path: RELEASE, status: 'failed', error: 'NoModificationAllowedError' },
        ],
        sentence: 'Saved ci.yml; release.yml failed (NoModificationAllowedError, is it open elsewhere?)',
        open: true,
      }),
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Saved ci.yml; release.yml failed (NoModificationAllowedError, is it open elsewhere?)',
    );
    const dialog = screen.getByRole('dialog', { name: 'Not everything was saved' });
    const files = within(dialog).getByRole('list', { name: 'Files' });
    expect(
      within(files)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([`${CI}saved`, `${RELEASE}failed (NoModificationAllowedError, is it open elsewhere?)`]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(saver.saves).toBe(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(store.getState().saving).toMatchObject({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says write access was refused, and offers the patch', () => {
    const store = folderStore(fakeFolder({}).handle);
    renderWith(store, { saver: countingSaver(store) });
    edit(store);
    act(() =>
      store.getState().setSaving({
        status: 'done',
        folder: 'repo',
        at: 0,
        denied: true,
        files: [],
        sentence: 'Saving to repo was not allowed: nothing was written',
        open: true,
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Not saved' });
    expect(dialog.textContent).toContain('Writing to repo was not allowed. Your edits are kept');
    expect(within(dialog).getByRole('button', { name: 'Download patch' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

describe('a copy of a folder', () => {
  it('says once, at its first edit, that Open folder saves in place', () => {
    const store = folderStore();
    createSaver({ store });
    edit(store);
    edit(store, RELEASE);
    store.getState().setFiles({ [CI]: 'on: push\n' }, { kind: 'folder', name: 'other', readAt: 0 });
    edit(store);
    expect(store.getState().notices.map((n) => n.text)).toEqual([COPY_NOTE]);
  });
});
