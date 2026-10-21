import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import type { ScenarioInput } from '@simulci/engine';
import { parse } from 'yaml';
import { type NodeCase, nodeCase, nodePlan } from './node-run';

/**
 * Copy as test case in a real browser, over the bundled starter sample: the top bar's button and the `c` key wait
 * for a plan; the dialog opens on the jobs case with its maybe comment and `allowMaybe`, names where the case belongs
 * and what runs it, and puts on the clipboard exactly the text it shows, a text the test file schema and `simulci
 * test` in Node take and pass at either detail; a clipboard the browser refuses leaves the whole text selected and
 * the download hands over the same text; the plan formats are the plan `simulci plan` prints; and Escape gives the
 * focus back to the button the dialog was opened from.
 */

const CI = '.github/workflows/ci.yml';
/** The starter's default scenario: a push to the branch CI's push filter names. */
const STARTER: ScenarioInput = { event: 'push', branch: 'main' };

/** Every page error and console error, so a test that passes on screen still fails on a thrown handler. */
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

/** The top bar's button; `exact` keeps the dialog's own Copy out. */
const caseButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Copy as test case', exact: true });
const caseDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Copy as test case' });
const textOf = (dialog: Locator): Locator => dialog.getByRole('textbox', { name: 'Text to copy' });
const format = (dialog: Locator, label: string): Locator => dialog.getByRole('radio', { name: label });
const copyButton = (dialog: Locator): Locator => dialog.getByRole('button', { name: 'Copy', exact: true });

/** The empty page, the starter sample, and its first plan: the button is enabled once there is one. */
async function openStarter(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(page.locator(`.react-flow__node-job[data-id="${CI}#deploy"]`)).toBeVisible();
  await expect(caseButton(page)).toBeEnabled();
}

/**
 * The dialog's text once the newest answer has landed: the text of the format picked before stays on screen, busy,
 * while the worker writes the new one.
 */
async function shownText(dialog: Locator): Promise<string> {
  const area = textOf(dialog);
  await expect(area).toHaveAttribute('aria-busy', 'false');
  return area.inputValue();
}

/** The schema takes the file and its one case passes in CI, as the dialog says `simulci test` will. */
function expectPasses(result: NodeCase): void {
  expect(result).toMatchObject({ schema: { success: true, issues: [] }, exitCode: 0 });
  expect(result.summary).toEqual({ passed: 1, failed: 0, invalid: 0, skipped: 0 });
}

/** Copy says so, and the clipboard holds the text the dialog shows. */
async function expectCopied(page: Page, dialog: Locator, text: string): Promise<void> {
  await copyButton(dialog).click();
  await expect(dialog.getByRole('status')).toHaveText('Copied to the clipboard.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
}

test('before any files the button is disabled and c opens nothing, not even once a plan arrives', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Starter/ })).toBeVisible();
  await expect(caseButton(page)).toBeDisabled();
  await page.keyboard.press('c');
  await expect(caseDialog(page)).toHaveCount(0);

  // A c the page had taken would show the dialog as soon as a plan made a case possible.
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(caseButton(page)).toBeEnabled();
  await expect(caseDialog(page)).toHaveCount(0);
});

test('c opens the jobs case, Copy puts exactly that text on the clipboard, and simulci test passes it; so for steps', async ({
  page,
  context,
}) => {
  await openStarter(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.keyboard.press('c');
  const dialog = caseDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(CI);
  await expect(format(dialog, 'Test case (jobs)')).toBeChecked();

  const jobs = await shownText(dialog);
  expect(jobs).toContain('workflow: ci.yml');
  expect(jobs).toContain('# ci.yml: maybe — scenario.changed → pin:');
  expect(jobs).toContain('allowMaybe: true');
  // The case is about the page's scenario, as the author gave it.
  expect((parse(jobs) as { cases: { when: unknown }[] }).cases[0]?.when).toEqual(STARTER);
  await expect(dialog).toContainText('A new .github/simulci/tests/ci.test.yml, where simulci test runs it.');
  await expectCopied(page, dialog, jobs);
  expectPasses(nodeCase(jobs));

  await format(dialog, 'Test case (steps)').check();
  await expect(dialog.getByRole('status')).toHaveText('');
  const steps = await shownText(dialog);
  expect(steps).toContain('units:');
  expect(steps).toContain('allowMaybe: true');
  await expectCopied(page, dialog, steps);
  expectPasses(nodeCase(steps));
});

test('a clipboard the browser refuses leaves the whole text selected, and the download is that text', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError')),
    });
  });
  await openStarter(page);
  await caseButton(page).click();
  const dialog = caseDialog(page);
  const text = await shownText(dialog);

  await copyButton(dialog).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    /^The browser refused the clipboard\. The text is selected/,
  );
  await expect(dialog.getByRole('status')).toHaveText('');
  const area = textOf(dialog);
  await expect(area).toBeFocused();
  expect(await area.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([
    0,
    text.length,
  ]);

  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download ci.test.yml' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('ci.test.yml');
  expect(readFileSync(await download.path(), 'utf8')).toBe(text);
});

test('the plan as text is the plan simulci plan prints, and the plan as Mermaid is a flowchart to download', async ({
  page,
}) => {
  await openStarter(page);
  await caseButton(page).click();
  const dialog = caseDialog(page);
  await shownText(dialog);

  await format(dialog, 'Plan as text').check();
  await expect(dialog.getByRole('button', { name: 'Download plan.txt' })).toBeVisible();
  expect(await shownText(dialog)).toBe(nodePlan(STARTER));

  await format(dialog, 'Plan as Mermaid').check();
  const mermaid = await shownText(dialog);
  expect(mermaid).toMatch(/^flowchart/);
  await expect(dialog.getByRole('button', { name: 'Download plan.mmd' })).toBeEnabled();
});

test('Escape closes the dialog and gives the focus back to the button it was opened from', async ({
  page,
}) => {
  await openStarter(page);
  const button = caseButton(page);
  await button.click();
  const dialog = caseDialog(page);
  await expect(format(dialog, 'Test case (jobs)')).toBeFocused();
  await shownText(dialog);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
});
