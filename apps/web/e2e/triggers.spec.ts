import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The triggers editor (synthesis § 4.6, § 9.2 C6), in a real browser under the deployment's CSP: in edit mode the
 * focused workflow's `on:` is rows above the scenario fields. A branch filter added to `on: push` writes the map form,
 * and with the scenario on another branch the row says ✗ and the status line that CI is no longer triggered; a
 * schedule reads in GitHub's words once the worker has outlined it; a dispatch input is added and typed in place.
 * Undoing everything gives back the file's bytes. axe finds nothing in the rows, light or dark.
 */

const CI = '.github/workflows/ci.yml';
const TEXT = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`;

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
const triggers = (page: Page): Locator => page.getByRole('region', { name: 'Triggers' });
const eventRow = (page: Page, event: string): Locator => triggers(page).locator(`[data-event="${event}"]`);
const pane = (page: Page): Locator => page.locator('[data-pane="yaml"]');
const undoButton = (page: Page): Locator => page.getByRole('button', { name: /^Undo/ });

/** Drops loose files on the page, as the author drags them in: they become pasted workflows by their names. */
async function dropFiles(page: Page, files: Record<string, number[]>): Promise<void> {
  const transfer = await page.evaluateHandle((given) => {
    const dt = new DataTransfer();
    for (const [name, bytes] of Object.entries(given)) dt.items.add(new File([new Uint8Array(bytes)], name));
    return dt;
  }, files);
  await page.dispatchEvent('header', 'drop', { dataTransfer: transfer });
}

async function openCi(page: Page): Promise<void> {
  await page.goto('/');
  await dropFiles(page, { 'ci.yml': [...Buffer.from(TEXT, 'utf8')] });
  await expect(jobNode(page, 'build')).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(triggers(page)).toBeVisible();
}

/** The shown file as the pane's Download hands it over, as text. */
async function downloaded(page: Page): Promise<string> {
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  const downloading = page.waitForEvent('download');
  await pane(page).locator('footer').getByRole('button', { name: 'Download' }).click();
  return readFileSync(await (await downloading).path(), 'utf8');
}

test('a branch filter added to push untriggers CI on dev, says so, and undoing it gives back the bytes', async ({
  page,
}) => {
  await openCi(page);
  await expect(page.getByRole('radio', { name: 'push' })).toBeChecked();
  // The scenario's branch first, and its plan in, so the filter is what stops the run.
  const sentence = page.getByRole('contentinfo').locator('[aria-live="polite"]');
  await page.getByRole('textbox', { name: 'Branch' }).fill('dev');
  await expect(sentence).toHaveText(/^push to dev: 1 of 1 workflow triggered/, { timeout: 3000 });

  await triggers(page).getByRole('combobox', { name: 'Add a filter to push' }).selectOption('branches');
  await page.keyboard.type('main');
  await page.keyboard.press('Enter');
  await expect(eventRow(page, 'push').locator('[data-check="no"]')).toHaveText('✗ dev matches none', {
    timeout: 3000,
  });
  await expect(sentence).toHaveText("Set push's branches: CI is no longer triggered", { timeout: 3000 });
  await expect(triggers(page).locator('[aria-live="polite"]')).toHaveText("added main to push's branches");
  expect(await downloaded(page)).toBe(TEXT.replace('on: push\n', 'on:\n  push:\n    branches: [main]\n'));

  // Back on main the row turns ✓.
  await page.getByRole('textbox', { name: 'Branch' }).fill('main');
  await expect(eventRow(page, 'push').locator('[data-check="yes"]')).toHaveText('✓ main matches', {
    timeout: 3000,
  });

  await undoButton(page).click();
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(await downloaded(page)).toBe(TEXT);
});

test('a schedule shows its cron in words, a dispatch input is added and typed in place, and undo gives back the bytes', async ({
  page,
}) => {
  await openCi(page);
  await triggers(page).getByRole('combobox', { name: 'Add an event' }).selectOption('schedule');
  await page.keyboard.type('0 6 * * 1');
  await page.keyboard.press('Enter');
  await expect(eventRow(page, 'schedule')).toContainText('Runs at 06:00, only on Monday', { timeout: 3000 });

  await triggers(page).getByRole('combobox', { name: 'Add an event' }).selectOption('workflow_dispatch');
  const dispatch = eventRow(page, 'workflow_dispatch');
  await dispatch.getByRole('button', { name: "Add an input to workflow_dispatch's inputs" }).click();
  await page.keyboard.type('environment');
  await page.keyboard.press('Enter');
  await dispatch.getByRole('combobox', { name: 'Type of environment' }).selectOption('choice');
  await dispatch.getByRole('button', { name: "Add an option to environment's options" }).click();
  await page.keyboard.type('staging');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(dispatch.getByRole('list', { name: "environment's options" })).toContainText('staging');
  expect(await downloaded(page)).toBe(
    TEXT.replace(
      'on: push\n',
      "on:\n  push:\n  schedule:\n    - cron: '0 6 * * 1'\n  workflow_dispatch:\n    inputs:\n      environment:\n        type: choice\n        options: [staging]\n",
    ),
  );
  // The rows pass axe, light and dark.
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const { violations } = await new AxeBuilder({ page }).include('[aria-label="Triggers"]').analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual(
      [],
    );
  }

  while ((await undoButton(page).getAttribute('aria-disabled')) !== 'true') await undoButton(page).click();
  expect(await downloaded(page)).toBe(TEXT);
});
