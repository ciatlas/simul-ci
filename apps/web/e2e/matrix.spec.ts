import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The matrix editor (synthesis § 4.7, § 9.2 C7), in a real browser under the deployment's CSP: + dimension `os` with
 * two values doubles the card's leg grid, and the status line names the check names that go and come; `3.10` is
 * written as a string; + value adds values in one undo entry; removing a job's last dimension removes the `strategy:`
 * it empties; undoing everything gives back the file's bytes. axe finds nothing in the editor, light or dark.
 */

const CI = '.github/workflows/ci.yml';
const STARTER_CI = readFileSync(join(import.meta.dirname, '../src/samples/starter/ci.yml'), 'utf8');

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
const matrix = (page: Page): Locator => page.locator('[data-panel="node"] section[aria-label="Matrix"]');
const legLine = (page: Page): Locator => matrix(page).locator('[data-leg-line]');
const sentence = (page: Page): Locator => page.getByRole('contentinfo').locator('[aria-live="polite"]');
const undoButton = (page: Page): Locator => page.getByRole('button', { name: /^Undo/ });

/** The starter in edit mode, with a job's Properties open. */
async function openJob(page: Page, job: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(jobNode(page, job)).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(page.getByRole('switch', { name: /^Edit/ })).toHaveAttribute('aria-checked', 'true');
  await jobNode(page, job).click();
  await page.getByRole('tab', { name: 'Properties' }).click();
}

/** The shown file as the pane's Download hands it over. */
async function downloaded(page: Page): Promise<string> {
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  const downloading = page.waitForEvent('download');
  await pane(page).locator('footer').getByRole('button', { name: 'Download' }).click();
  return readFileSync(await (await downloading).path(), 'utf8');
}

/** + dimension, its name and values typed, Enter. */
async function addDimension(page: Page, name: string, values: string): Promise<void> {
  await matrix(page).getByRole('button', { name: '+ dimension' }).click();
  await page.getByRole('textbox', { name: 'Name of the new dimension' }).fill(name);
  await page.getByRole('textbox', { name: 'Values of the new dimension' }).fill(values);
  await page.keyboard.press('Enter');
}

/** Undo until there is nothing left to undo. */
async function undoAll(page: Page): Promise<void> {
  while ((await undoButton(page).getAttribute('aria-disabled')) !== 'true') {
    const label = await undoButton(page).getAttribute('aria-label');
    await undoButton(page).click();
    await expect(undoButton(page)).not.toHaveAttribute('aria-label', label!);
  }
}

test('+ dimension os doubles the leg grid and names the new checks; 3.10 stays a string; undo gives the bytes back', async ({
  page,
}) => {
  await openJob(page, 'test');
  await expect(legLine(page)).toHaveText('2 legs: 2 might run');
  await expect(jobNode(page, 'test').locator('[data-leg]')).toHaveCount(2);

  await addDimension(page, 'os', 'ubuntu-latest, windows-latest');
  await expect(jobNode(page, 'test').locator('[data-leg]')).toHaveCount(4, { timeout: 3000 });
  await expect(legLine(page)).toHaveText('4 legs: 4 might run');
  await expect(matrix(page).locator('[data-legs] [data-leg]')).toHaveCount(4);
  // Renamed checks break required checks, so the sentence names them.
  await expect(sentence(page)).toContainText("Set test's matrix os: check 'test (22)' removed");
  await expect(sentence(page)).toContainText("check 'test (22, ubuntu-latest)' added");
  await expect(undoButton(page)).toHaveAttribute('aria-label', "Undo Set test's matrix os");
  expect(await downloaded(page)).toBe(
    STARTER_CI.replace(
      '        node: [22, 24]\n',
      '        node: [22, 24]\n        os: [ubuntu-latest, windows-latest]\n',
    ),
  );

  // A value YAML would read as a number is written as the string typed.
  await addDimension(page, 'python', '3.10');
  await expect(matrix(page).getByRole('list', { name: 'Values of python' })).toContainText("'3.10'");
  expect(await downloaded(page)).toContain(
    "        os: [ubuntu-latest, windows-latest]\n        python: ['3.10']\n",
  );
  await expect(legLine(page)).toHaveText('4 legs: 4 might run');

  // A dimension's name again would replace its values: the row says so and writes nothing.
  const before = await downloaded(page);
  await addDimension(page, 'Node', '18');
  await expect(matrix(page).getByRole('group', { name: 'New dimension' })).toContainText(
    'node is a dimension already',
  );
  await page.keyboard.press('Escape');
  expect(await downloaded(page)).toBe(before);

  await undoAll(page);
  await expect(jobNode(page, 'test').locator('[data-leg]')).toHaveCount(2);
  expect(await downloaded(page)).toBe(STARTER_CI);
});

test('+ matrix on a job without one, + value in one undo entry, and the last dimension removed takes strategy with it', async ({
  page,
}) => {
  await openJob(page, 'build');
  await expect(matrix(page)).toHaveCount(0);
  await page.locator('[data-panel="node"]').getByRole('button', { name: '+ matrix' }).click();
  // + matrix opens the editor on its first dimension.
  await expect(page.getByRole('textbox', { name: 'Name of the new dimension' })).toBeFocused();
  await page.keyboard.type('os');
  await page.getByRole('textbox', { name: 'Values of the new dimension' }).fill('ubuntu-latest');
  await page.keyboard.press('Enter');
  await expect(legLine(page)).toHaveText('1 leg: 1 might run', { timeout: 3000 });
  // In the canonical order the new key follows the highest-ranked key the job writes below it: here `needs`.
  const withMatrix = STARTER_CI.replace(
    '  build:\n    needs: test\n',
    '  build:\n    needs: test\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n',
  );
  expect(await downloaded(page)).toBe(withMatrix);

  // Two values added in one visit to + value are one undo entry.
  const add = matrix(page).getByRole('textbox', { name: 'New value of os' });
  await add.fill('macos-latest');
  await add.press('Enter');
  await expect(add).toHaveValue('');
  await add.fill('windows-latest');
  await add.press('Enter');
  await expect(jobNode(page, 'build').locator('[data-leg]')).toHaveCount(3, { timeout: 3000 });
  await add.press('Tab');
  await expect(undoButton(page)).toHaveAttribute('aria-label', "Undo Set build's matrix os");
  await undoButton(page).click();
  await expect(legLine(page)).toHaveText('1 leg: 1 might run', { timeout: 3000 });
  expect(await downloaded(page)).toBe(withMatrix);

  await matrix(page).getByRole('button', { name: 'Remove the dimension os' }).click();
  await expect(matrix(page)).toHaveCount(0);
  expect(await downloaded(page)).toBe(STARTER_CI);
  await undoAll(page);
  expect(await downloaded(page)).toBe(STARTER_CI);
});

const DYNAMIC = `on: push
jobs:
  setup:
    runs-on: ubuntu-latest
    outputs:
      matrix: \${{ steps.m.outputs.matrix }}
    steps: [{ id: m, run: ./matrix.sh }]
  test:
    needs: setup
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: \${{ fromJSON(needs.setup.outputs.matrix) }}
    steps: [{ run: npm test }]
`;

/** Drops loose files on the page, as the author drags them in: they become pasted workflows by their names. */
async function dropFiles(page: Page, files: Record<string, string>): Promise<void> {
  const transfer = await page.evaluateHandle((given) => {
    const dt = new DataTransfer();
    for (const [name, text] of Object.entries(given)) dt.items.add(new File([text], name));
    return dt;
  }, files);
  await page.dispatchEvent('header', 'drop', { dataTransfer: transfer });
}

test('a matrix set at run time is read-only, with a link to edit it in YAML', async ({ page }) => {
  await page.goto('/');
  await dropFiles(page, { 'dynamic.yml': DYNAMIC });
  const card = page.locator('.react-flow__node-job[data-id=".github/workflows/dynamic.yml#test"]');
  await expect(card).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await card.click();
  await page.getByRole('tab', { name: 'Properties' }).click();
  await expect(matrix(page).locator('[data-fixed="matrix"]')).toContainText('Set at run time; edit in YAML');
  await expect(matrix(page).getByRole('button', { name: '+ dimension' })).toHaveCount(0);
  await expect(legLine(page)).toHaveText('The legs are set at run time.');
  // The strategy's own fields stay editable.
  await expect(matrix(page).getByRole('switch', { name: 'Fail fast' })).not.toBeChecked();
  await expect(matrix(page).getByRole('textbox', { name: 'Max parallel' })).toBeEditable();
  await matrix(page).getByRole('button', { name: 'edit in YAML' }).click();
  await expect(pane(page).locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
});

/** axe over the matrix editor once every transition has run out. */
async function expectAxeClean(page: Page, view: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const { violations } = await new AxeBuilder({ page }).include('[data-panel="node"]').analyze();
  expect(
    violations.map((v) => `${view}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test('axe finds nothing in the matrix editor, light or dark', async ({ page }) => {
  await openJob(page, 'test');
  await expect(legLine(page)).toHaveText('2 legs: 2 might run');
  await matrix(page).getByRole('button', { name: '+ dimension' }).click();
  await expectAxeClean(page, 'matrix');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAxeClean(page, 'matrix, dark');
});
