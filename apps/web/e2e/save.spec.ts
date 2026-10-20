import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Saving to the folder (synthesis § 5.3, § 5.4, § 5.7, § 9.5's data gates), in a real browser under the deployment's
 * CSP, on a directory of the origin private file system: the folder picker is stubbed to hand the page an OPFS
 * directory, which Chromium writes through `createWritable` on the main thread as it writes a picked folder. Open,
 * edit, Mod+S, and read the bytes back; a save with no edit writes nothing; a file changed behind the page's back is a
 * conflict, kept as the disk has it or overwritten as the author chooses; refused write access writes nothing and
 * offers the patch; a write that fails before `close()` leaves the old bytes; Reload takes in the disk's change of a
 * clean file and keeps the author's edits; and the replace prompt's Save saves before the sample opens.
 */

const CI = '.github/workflows/ci.yml';
const DEPLOY = '.github/workflows/deploy.yml';
const BOM = [0xef, 0xbb, 0xbf];
const CI_TEXT =
  'name: CI\r\non: push\r\njobs:\r\n  build:\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - run: echo hi\r\n';
const DEPLOY_TEXT =
  'name: Deploy\non: push\njobs:\n  ship:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ship\n';

const bytes = (text: string, bom = false): number[] => [
  ...(bom ? BOM : []),
  ...new TextEncoder().encode(text),
];

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // Open folder hands the page the OPFS directory `repo`.
  await page.addInitScript(() => {
    (
      window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('repo', { create: true });
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

/** The OPFS folder `repo` holding exactly these files, written as bytes. */
async function folderWith(page: Page, files: Record<string, number[]>): Promise<void> {
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('repo', { recursive: true }).catch(() => undefined);
    const repo = await root.getDirectoryHandle('repo', { create: true });
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/');
      const name = parts.pop()!;
      let dir = repo;
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(new Uint8Array(content));
      await writable.close();
    }
  }, files);
}

/** A file of `repo` as bytes, and when it was last written; nothing when it is not there. */
async function fileOf(page: Page, path: string): Promise<{ bytes: number[]; modified: number } | undefined> {
  return page.evaluate(async (path) => {
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('repo');
    const parts = path.split('/');
    const name = parts.pop()!;
    try {
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      const file = await (await dir.getFileHandle(name)).getFile();
      return { bytes: Array.from(new Uint8Array(await file.arrayBuffer())), modified: file.lastModified };
    } catch {
      return undefined;
    }
  }, path);
}

const pane = (page: Page): Locator => page.locator('[data-pane="yaml"]');
const editor = (page: Page): Locator => pane(page).locator('.cm-content');
const said = (page: Page, text: string | RegExp): Locator =>
  page.getByRole('status').filter({ hasText: text });

/** Open folder on `repo`, edit mode on, the pane on ci.yml. */
async function openRepo(page: Page, files: Record<string, number[]>): Promise<void> {
  await page.goto('/');
  await folderWith(page, files);
  await page.getByRole('navigation', { name: 'Source' }).getByRole('button', { name: 'Open folder' }).click();
  await expect(page.getByRole('navigation', { name: 'Source' })).toContainText(/repo · \d files?/);
  await page.getByRole('switch', { name: /^Edit/ }).click();
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  await page.getByRole('tab', { name: 'ci.yml' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
}

/** Types at the end of a line of the shown file. */
async function typeAtEnd(page: Page, line: number, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

test('Mod+S in the editor saves the edit with its BOM and CRLF, and nothing else changes on disk', async ({
  page,
}) => {
  await openRepo(page, { [CI]: bytes(CI_TEXT, true), [DEPLOY]: bytes(DEPLOY_TEXT) });
  const deployBefore = await fileOf(page, DEPLOY);

  // Mod+S with no edit: zero files written.
  const ciBefore = await fileOf(page, CI);
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(said(page, 'Nothing to save')).toBeVisible();
  expect(await fileOf(page, CI)).toEqual(ciBefore);

  await typeAtEnd(page, 1, '!');
  await expect(page.getByRole('navigation', { name: 'Source' })).toContainText('1 unsaved');
  await expect(page.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'false');
  // The page takes the chord, so the browser's Save Page does not open; the gesture's activation reaches the request.
  await page.evaluate(() => {
    window.addEventListener('keydown', (e) => {
      if (e.key === 's')
        (window as unknown as { seen: unknown }).seen = {
          prevented: e.defaultPrevented,
          active: navigator.userActivation.isActive,
        };
    });
  });
  await page.keyboard.press('ControlOrMeta+s');
  await expect(said(page, 'Saved ci.yml')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { seen: unknown }).seen)).toEqual({
    prevented: true,
    active: true,
  });
  const after = await fileOf(page, CI);
  expect(after?.bytes).toEqual(bytes(CI_TEXT.replace('name: CI', 'name: CI!'), true));
  expect(await fileOf(page, DEPLOY)).toEqual(deployBefore);
  await expect(page.getByRole('navigation', { name: 'Source' })).not.toContainText('unsaved');
  await expect(page).toHaveTitle('simulci');
  await expect(page.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
});

test('a file changed on disk is a conflict: keep the disk version, then undo and save mine over it', async ({
  page,
}) => {
  await openRepo(page, { [CI]: bytes(CI_TEXT), [DEPLOY]: bytes(DEPLOY_TEXT) });
  await typeAtEnd(page, 1, '!');
  const theirs = CI_TEXT.replace('echo hi', 'echo theirs');
  await page.evaluate(async (text) => {
    const repo = await (await navigator.storage.getDirectory()).getDirectoryHandle('repo');
    const dir = await (await repo.getDirectoryHandle('.github')).getDirectoryHandle('workflows');
    const w = await (await dir.getFileHandle('ci.yml')).createWritable();
    await w.write(text);
    await w.close();
  }, theirs);
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog', { name: 'Changed on disk' });
  await expect(dialog).toContainText('ci.yml changed on disk since it was opened or last saved.');
  await dialog.getByText('Compare').click();
  await expect(dialog.getByLabel('ci.yml: what the folder changed')).toContainText(
    '+      - run: echo theirs',
  );
  await expect(dialog.getByLabel('ci.yml: what you changed')).toContainText('+name: CI!');
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByLabel('Keep the disk version').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor(page)).toContainText('echo theirs');
  expect((await fileOf(page, CI))?.bytes).toEqual(bytes(theirs));
  await expect(page.getByRole('navigation', { name: 'Source' })).not.toContainText('unsaved');

  // The author's version is one undo away, and then saves over the disk without asking.
  await page.getByRole('button', { name: 'Undo Kept the disk version of ci.yml' }).click();
  await expect(editor(page)).toContainText('name: CI!');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(said(page, 'Saved ci.yml')).toBeVisible();
  expect((await fileOf(page, CI))?.bytes).toEqual(bytes(CI_TEXT.replace('name: CI', 'name: CI!')));
});

test('refused write access writes nothing, keeps the edits and offers the patch', async ({ page }) => {
  await openRepo(page, { [CI]: bytes(CI_TEXT) });
  await typeAtEnd(page, 1, '!');
  await page.evaluate(() => {
    (
      FileSystemHandle.prototype as unknown as { requestPermission: () => Promise<string> }
    ).requestPermission = () => Promise.resolve('denied');
  });
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog', { name: 'Not saved' });
  await expect(dialog).toContainText('Writing to repo was not allowed. Your edits are kept');
  expect((await fileOf(page, CI))?.bytes).toEqual(bytes(CI_TEXT));
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download patch' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('simulci-changes.patch');
  expect(readFileSync(await download.path(), 'utf8')).toContain('+name: CI!\r\n');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('navigation', { name: 'Source' })).toContainText('1 unsaved');
});

test('a write that fails before close leaves the old bytes, and Retry saves', async ({ page }) => {
  await openRepo(page, { [CI]: bytes(CI_TEXT, true) });
  await typeAtEnd(page, 1, '!');
  // The swap file gets the new bytes, then the write fails: the page aborts it.
  await page.evaluate(() => {
    const proto = FileSystemWritableFileStream.prototype as unknown as {
      write: (data: unknown) => Promise<void>;
      original?: (data: unknown) => Promise<void>;
    };
    proto.original = proto.write;
    proto.write = async function (this: unknown, data: unknown) {
      await proto.original!.call(this, data);
      throw new DOMException('the disk went away', 'NoModificationAllowedError');
    };
  });
  await page.keyboard.press('ControlOrMeta+s');
  const dialog = page.getByRole('dialog', { name: 'Not everything was saved' });
  await expect(dialog).toContainText('failed (NoModificationAllowedError, is it open elsewhere?)');
  await expect(said(page, 'ci.yml failed (NoModificationAllowedError, is it open elsewhere?)')).toBeVisible();
  expect((await fileOf(page, CI))?.bytes).toEqual(bytes(CI_TEXT, true));
  await page.evaluate(() => {
    const proto = FileSystemWritableFileStream.prototype as unknown as {
      write: unknown;
      original?: unknown;
    };
    proto.write = proto.original;
  });
  await dialog.getByRole('button', { name: 'Retry' }).click();
  await expect(said(page, 'Saved ci.yml')).toBeVisible();
  expect((await fileOf(page, CI))?.bytes).toEqual(bytes(CI_TEXT.replace('name: CI', 'name: CI!'), true));
});

test('Reload takes the disk’s change of a clean file and keeps the edits of a file the disk did not change', async ({
  page,
}) => {
  await openRepo(page, { [CI]: bytes(CI_TEXT), [DEPLOY]: bytes(DEPLOY_TEXT) });
  await typeAtEnd(page, 1, '!');
  await folderWith(page, {
    [CI]: bytes(CI_TEXT),
    [DEPLOY]: bytes(DEPLOY_TEXT.replace('echo ship', 'echo shipped')),
  });
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('button', { name: 'Undo Reloaded repo' })).toBeVisible();
  await expect(editor(page)).toContainText('name: CI!');
  await page.getByRole('tab', { name: 'deploy.yml' }).click();
  await expect(editor(page)).toContainText('echo shipped');
  await expect(page.getByRole('navigation', { name: 'Source' })).toContainText('1 unsaved');
});

test('the replace prompt’s Save saves before the sample opens', async ({ page }) => {
  await openRepo(page, { [CI]: bytes(CI_TEXT) });
  await typeAtEnd(page, 1, '!');
  await page.getByRole('combobox', { name: 'Sample' }).selectOption({ index: 1 });
  const dialog = page.getByRole('dialog', { name: 'Unsaved edits' });
  await expect(dialog).toContainText('Save writes them to repo first.');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('navigation', { name: 'Source' })).toContainText('sample:');
  expect((await fileOf(page, CI))?.bytes).toEqual(bytes(CI_TEXT.replace('name: CI', 'name: CI!')));
});
