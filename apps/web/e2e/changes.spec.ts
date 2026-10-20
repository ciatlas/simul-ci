import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Reviewing the edits (synthesis § 5.2, § 9.2 A6), in a real browser under the deployment's CSP: an edit of the
 * sample shows in the Changes dialog, opened by Mod+Shift+D from inside the editor, with its counts and its diff;
 * Download patch hands over `simulci-changes.patch`; Revert puts the file back, and the file is clean, its plan and
 * its bytes the sample's again. Axe finds nothing in the open dialog.
 */

const CI = '.github/workflows/ci.yml';
const STARTER_CI = readFileSync(join(import.meta.dirname, '../src/samples/starter/ci.yml'), 'utf8');
/** Line 43 of the starter's CI: deploy's `if:`, whose condition runs it on a push. */
const DEPLOY_IF = "github.event_name == 'push' || inputs.deploy";

let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const jobNode = (page: Page, job: string): Locator =>
  page.locator(`.react-flow__node-job[data-id="${CI}#${job}"]`);
const pane = (page: Page): Locator => page.locator('[data-pane="yaml"]');
const editor = (page: Page): Locator => pane(page).locator('.cm-content');
const footer = (page: Page): Locator => pane(page).locator('footer');

test('an edit of the sample shows in Changes with its diff and its patch, and Revert leaves the file clean', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(jobNode(page, 'deploy')).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');

  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 1; i < 43; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  for (let i = 0; i < DEPLOY_IF.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.type('false');
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/, { timeout: 2000 });
  await expect(page.getByRole('button', { name: 'Changes (1)' })).toBeVisible();

  // Mod+Shift+D in the editor opens the dialog.
  await page.keyboard.press('ControlOrMeta+Shift+D');
  const dialog = page.getByRole('dialog', { name: 'Changes' });
  await expect(dialog).toBeVisible();
  const file = dialog.getByRole('region', { name: CI });
  await expect(file).toContainText('+1 −1');
  const diff = file.getByLabel(`Changes to ${CI}`);
  await expect(diff).toContainText('@@ -40,7 +40,7 @@');
  await expect(diff).toContainText(`-    if: ${DEPLOY_IF}`);
  await expect(diff).toContainText('+    if: false');
  expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
  // Since opened says the same until a save moves the base.
  await dialog.getByLabel('Since opened').check();
  await expect(file).toContainText('+1 −1');

  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download patch' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('simulci-changes.patch');
  expect(readFileSync(await download.path(), 'utf8')).toBe(
    [
      `diff --git a/${CI} b/${CI}`,
      `--- a/${CI}`,
      `+++ b/${CI}`,
      '@@ -40,7 +40,7 @@',
      ...STARTER_CI.split('\n')
        .slice(39, 46)
        .map((line, i) => (i === 3 ? `-${line}\n+    if: false` : ` ${line}`)),
      '',
    ].join('\n'),
  );

  await file.getByRole('button', { name: `Revert ${CI}` }).click();
  await expect(dialog).toContainText('Nothing changed since the files were opened.');
  await expect(dialog.getByRole('status')).toContainText('Reverted ci.yml.');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(footer(page)).not.toContainText('● unsaved');
  await expect(page).toHaveTitle('simulci');
  await expect(page.getByRole('button', { name: 'Changes' })).toBeVisible();
  await expect(jobNode(page, 'deploy')).not.toHaveAttribute('aria-label', /^skipped/);
  const saving = page.waitForEvent('download');
  await footer(page).getByRole('button', { name: 'Download' }).click();
  expect(readFileSync(await (await saving).path(), 'utf8')).toBe(STARTER_CI);

  // The revert is one undoable entry.
  await page.getByRole('button', { name: 'Undo Reverted ci.yml' }).click();
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/);
});
