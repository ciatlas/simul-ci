import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * A job's steps as the builder edits them (synthesis § 4.2, § 4.5, § 4.8, § 9.2 C5), in a real browser under the
 * deployment's CSP: Alt+↓ moves the selected step on the canvas; `s` opens the palette, which inserts `uses:` and
 * nothing else after the selected step and selects it with Properties open; Run a script puts the focus in its Run;
 * Change… swaps a step's action; Delete on a step whose id is still read asks first; and undoing each gives the file's
 * bytes back.
 */

const PATH = '.github/workflows/ci.yml';

const CI = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - id: detect
        run: echo "changed=true" >> "$GITHUB_OUTPUT"
      - run: npm run build
        if: steps.detect.outputs.changed == 'true'
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm test
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
  page.locator(`.react-flow__node-job[data-id="${PATH}#${job}"]`);
const pane = (page: Page): Locator => page.locator('[data-pane="yaml"]');
const sentence = (page: Page): Locator => page.getByRole('contentinfo').locator('[aria-live]');
const properties = (page: Page): Locator => page.locator('[data-panel="node"]');

async function dropFiles(page: Page, files: Record<string, string>): Promise<void> {
  const transfer = await page.evaluateHandle((given) => {
    const dt = new DataTransfer();
    for (const [name, text] of Object.entries(given)) dt.items.add(new File([text], name));
    return dt;
  }, files);
  await page.dispatchEvent('header', 'drop', { dataTransfer: transfer });
}

/** The CI file dropped and laid out in edit mode, build's step list open and its first step selected by the keys. */
async function firstStep(page: Page): Promise<void> {
  await page.goto('/');
  await dropFiles(page, { 'ci.yml': CI });
  await expect(jobNode(page, 'test')).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(page.getByRole('button', { name: '+ Add job' })).toBeAttached();
  await jobNode(page, 'build').click();
  await page.keyboard.press(' ');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/sel=build\.%231/);
}

async function downloaded(page: Page): Promise<string> {
  // The pane's key is the page's: not a field's, which would take it as text.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  const downloading = page.waitForEvent('download');
  await pane(page).locator('footer').getByRole('button', { name: 'Download' }).click();
  return readFileSync(await (await downloading).path(), 'utf8');
}

async function undoAll(page: Page): Promise<void> {
  const undo = page.getByRole('button', { name: /^Undo/ }).first();
  while ((await undo.getAttribute('aria-disabled')) !== 'true') await undo.click();
}

/** The open list's rows, by label. */
const rows = (page: Page): Promise<string[]> =>
  jobNode(page, 'build').locator('.sc-list-label').allTextContents();

test('Alt+↓ moves the selected step, the selection following it, and undo gives the bytes back', async ({
  page,
}) => {
  await firstStep(page);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(sentence(page)).toHaveText(
    'Moved step 1 of build (actions/checkout@v4) down: no verdict changed',
    { timeout: 3000 },
  );
  await expect(page).toHaveURL(/sel=build\.%232/);
  expect(await rows(page)).toEqual(['detect', 'actions/checkout@v4', '~npm-run-build']);
  expect(await downloaded(page)).toContain(
    '    steps:\n      - id: detect\n        run: echo "changed=true" >> "$GITHUB_OUTPUT"\n      - uses: actions/checkout@v4\n',
  );
  await undoAll(page);
  expect(await downloaded(page)).toBe(CI);
});

test('s opens the palette; an action picked is inserted after the selected step and selected, Properties open', async ({
  page,
}) => {
  await firstStep(page);
  await page.keyboard.press('s');
  const palette = page.getByRole('dialog', { name: 'Add a step to build' });
  const box = palette.getByRole('combobox', { name: 'Steps to add' });
  await expect(box).toBeFocused();
  await expect(palette.getByRole('group', { name: /used here/i })).toContainText('actions/checkout@v4');
  await page.keyboard.type('setup-node');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page).toHaveURL(/sel=build\.%232/, { timeout: 3000 });
  await expect(
    properties(page).getByRole('heading', { name: 'actions/setup-node@v4' }).first(),
  ).toBeVisible();
  expect(await downloaded(page)).toContain(
    '      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - id: detect\n',
  );
  // Change… picks another action for it, writing its uses: alone.
  await properties(page).getByRole('button', { name: 'Change…' }).click();
  const change = page.getByRole('dialog', { name: /^Change the action of step 2 of build/ });
  await page.keyboard.type('checkout');
  await page.keyboard.press('Enter');
  await expect(change).toHaveCount(0);
  await expect(properties(page).getByRole('textbox', { name: 'Uses', exact: true })).toHaveValue(
    'actions/checkout@v4',
    {
      timeout: 3000,
    },
  );
  await undoAll(page);
  expect(await downloaded(page)).toBe(CI);
});

test('Run a script inserts a run: step and puts the focus in its Run', async ({ page }) => {
  await firstStep(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('run a');
  await page.keyboard.press('Enter');
  const run = properties(page).getByRole('textbox', { name: 'Run', exact: true });
  await expect(run).toBeFocused({ timeout: 3000 });
  await page.keyboard.type('npm run lint');
  await page.keyboard.press('Tab');
  expect(await downloaded(page)).toContain(
    '      - uses: actions/checkout@v4\n      - run: npm run lint\n      - id: detect\n',
  );
  await undoAll(page);
  expect(await downloaded(page)).toBe(CI);
});

test('Delete on a step whose id is still read asks first; Undo in the notice gives the bytes back', async ({
  page,
}) => {
  await firstStep(page);
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(/sel=build\.detect/);
  await page.keyboard.press('Delete');
  const ask = page.getByRole('dialog', { name: /^Remove step 2 of build/ });
  await expect(ask).toContainText('still reads steps.detect');
  await ask.getByRole('button', { name: 'Remove the step' }).click();
  await expect.poll(() => rows(page), { timeout: 3000 }).toEqual(['actions/checkout@v4', '~npm-run-build']);
  const notice = page.getByRole('status').filter({ hasText: /^Removed step 2 of build/ });
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(() => rows(page), { timeout: 3000 })
    .toEqual(['actions/checkout@v4', 'detect', '~npm-run-build']);
  expect(await downloaded(page)).toBe(CI);
});
