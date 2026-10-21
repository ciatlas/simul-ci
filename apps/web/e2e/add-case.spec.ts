import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { parse } from 'yaml';
import { nodeCase } from './node-run';
import { fileOf, folderWith, useOpfsFolder } from './opfs';

/**
 * A generated case added to the repository (synthesis § 4.9) in a real browser, under the deployment's CSP, on a folder
 * of the origin private file system that holds the starter's workflows and no route test: Copy as test case → Create
 * ci.test.yml writes the case into a new file, which the YAML pane shows in its Tests group, unsaved, in edit mode;
 * Mod+S creates `.github/simulci/tests` and the file; and `simulci test`, run in Node on the bytes the folder holds,
 * passes it. A second case goes into the file the folder now has, under a name it does not have yet, and the saved
 * file passes with both.
 */

const CI = '.github/workflows/ci.yml';
const TEST = '.github/simulci/tests/ci.test.yml';
const sample = (name: string): number[] => [
  ...new TextEncoder().encode(
    readFileSync(join(import.meta.dirname, '../src/samples/starter', name), 'utf8'),
  ),
];
/** The starter at the paths the page gives its files (src/input/samples.ts). */
const STARTER = {
  [CI]: sample('ci.yml'),
  '.github/workflows/release.yml': sample('release.yml'),
  '.github/actions/setup/action.yml': sample('setup-action.yml'),
};

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await useOpfsFolder(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const caseButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Copy as test case', exact: true });
const caseDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Copy as test case' });
const source = (page: Page): Locator => page.getByRole('navigation', { name: 'Source' });

/** The test file as the folder holds it now. */
async function saved(page: Page): Promise<string> {
  const file = await fileOf(page, TEST);
  expect(file).toBeDefined();
  return new TextDecoder().decode(new Uint8Array(file!.bytes));
}

test('a case created in a new test file, saved to the folder, passes simulci test; so does a second added to it', async ({
  page,
}) => {
  await page.goto('/');
  await folderWith(page, STARTER);
  await source(page).getByRole('button', { name: 'Open folder' }).click();
  await expect(source(page)).toContainText('repo · 3 files');
  await expect(caseButton(page)).toBeEnabled();

  // Create: one entry, the dialog closes on the case in the pane, in edit mode, unsaved.
  await caseButton(page).click();
  const dialog = caseDialog(page);
  await expect(dialog).toContainText('A new .github/simulci/tests/ci.test.yml, where simulci test runs it.');
  const create = dialog.getByRole('button', { name: 'Create ci.test.yml' });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(dialog).toHaveCount(0);
  const tab = page.getByRole('tab', { name: 'ci.test.yml, route test, unsaved' });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-pane="yaml"]').getByText('Tests', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: /^Edit/ })).toBeChecked();
  await expect(source(page)).toContainText('1 unsaved');
  expect(await fileOf(page, TEST)).toBeUndefined();

  // Saved: the directories and the file are made, and the CLI passes the case.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(source(page)).not.toContainText('unsaved');
  const first = await saved(page);
  expect(parse(first)).toMatchObject({
    workflow: 'ci.yml',
    cases: [{ when: { event: 'push', branch: 'main' } }],
  });
  const one = nodeCase(first);
  expect(one).toMatchObject({ schema: { success: true, issues: [] }, exitCode: 0 });
  expect(one.summary).toEqual({ passed: 1, failed: 0, invalid: 0, skipped: 0 });
  await expect(page.getByRole('tab', { name: 'ci.test.yml, route test' })).toBeVisible();

  // A second case, into the file the folder now holds, under the name its first case has not taken.
  await caseButton(page).click();
  await expect(dialog).toContainText('Into .github/simulci/tests/ci.test.yml (1 case)');
  await expect(dialog).toContainText('this one is added as');
  const add = dialog.getByRole('button', { name: 'Add to ci.test.yml' });
  await expect(add).toBeEnabled();
  await add.click();
  await expect(dialog).toHaveCount(0);
  await expect(source(page)).toContainText('1 unsaved');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(source(page)).not.toContainText('unsaved');
  const second = await saved(page);
  expect(second.startsWith(first)).toBe(true);
  const two = nodeCase(second);
  expect(two).toMatchObject({ schema: { success: true, issues: [] }, exitCode: 0 });
  expect(two.summary).toEqual({ passed: 2, failed: 0, invalid: 0, skipped: 0 });
  const [name] = (parse(first) as { cases: { name: string }[] }).cases.map((c) => c.name);
  expect(two.cases.map((c) => c.name)).toEqual([name, `${name} (2)`]);
});
