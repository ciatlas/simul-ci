import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Renames (synthesis § 4.2, § 9.2 C11) in a real browser under the deployment's CSP: F2 opens an input over the
 * selected card's title, Enter lists every line the rename writes, Enter renames; the card, the selection and the URL
 * follow the new id while the viewport stays where it was; one undo gives the file's bytes back. A double-click on a
 * card's title in edit mode renames too, and does not zoom.
 */

const PATH = '.github/workflows/ci.yml';

const CI = `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: unit
        run: npm test
      - run: echo "\${{ steps.unit.outcome }}"
  build:
    needs:
      - test
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
  deploy:
    needs: [build, test]
    if: needs.build.result == 'success'
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
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
const transform = (page: Page): Promise<string> =>
  page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);

async function dropFiles(page: Page, files: Record<string, string>): Promise<void> {
  const transfer = await page.evaluateHandle((given) => {
    const dt = new DataTransfer();
    for (const [name, text] of Object.entries(given)) dt.items.add(new File([text], name));
    return dt;
  }, files);
  await page.dispatchEvent('header', 'drop', { dataTransfer: transfer });
}

/** The CI file dropped, laid out, in edit mode, with the edit runtime in. */
async function opened(page: Page): Promise<void> {
  await page.goto('/');
  await dropFiles(page, { 'ci.yml': CI });
  await expect(jobNode(page, 'deploy')).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(page.getByRole('button', { name: '+ Add job' })).toBeAttached();
}

/** The file as the pane's Download hands it over, byte for byte. */
async function downloaded(page: Page): Promise<string> {
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  const downloading = page.waitForEvent('download');
  await pane(page).locator('footer').getByRole('button', { name: 'Download' }).click();
  return readFileSync(await (await downloading).path(), 'utf8');
}

test('F2 renames the selected job with its references; the selection and the URL follow, the viewport stays', async ({
  page,
}) => {
  await opened(page);
  await jobNode(page, 'build').click();
  await expect(page).toHaveURL(/sel=build/);
  const before = await transform(page);
  await page.keyboard.press('F2');
  const input = page.getByRole('textbox', { name: 'New id for job build' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('build');
  await page.keyboard.type('compile');
  await page.keyboard.press('Enter');
  const review = page.getByRole('dialog', { name: 'Rename build to compile' });
  await expect(review).toContainText(
    '3 places on 3 lines of ci.yml: the key, 1 needs entry and 1 expression read.',
  );
  await expect(review.getByRole('button', { name: 'Rename' })).toBeFocused();
  const { violations } = await new AxeBuilder({ page }).include('[popover]').analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(review).toBeHidden();
  await expect(jobNode(page, 'compile')).toBeVisible();
  await expect(jobNode(page, 'build')).toHaveCount(0);
  await expect(jobNode(page, 'compile').locator('.sc-card')).toHaveAttribute('data-selected', 'self');
  await expect(page).toHaveURL(/sel=compile/);
  await expect(jobNode(page, 'compile')).toBeFocused();
  expect(await transform(page)).toBe(before);
  await expect(page.getByRole('contentinfo')).toContainText('Renamed job build to compile');
  const renamed = CI.replace('  build:', '  compile:')
    .replace('needs: [build, test]', 'needs: [compile, test]')
    .replace('needs.build.result', 'needs.compile.result');
  expect(await downloaded(page)).toBe(renamed);
  // One undo takes back every reference, byte for byte, and the selection goes back with it.
  await page.getByRole('button', { name: /^Undo/ }).first().click();
  await expect(jobNode(page, 'build')).toBeVisible();
  await expect(page).toHaveURL(/sel=build/);
  expect(await downloaded(page)).toBe(CI);
});

test('a double-click on a card’s title renames it in edit mode and does not zoom; F2 renames a step’s id', async ({
  page,
}) => {
  await opened(page);
  const before = await transform(page);
  await jobNode(page, 'test').locator('.sc-card-label').dblclick();
  const input = page.getByRole('textbox', { name: 'New id for job test' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('test');
  expect(await transform(page)).toBe(before);
  // Escape leaves it as it was.
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  // The step with an id: selected from the strip, renamed with its read.
  await jobNode(page, 'test').locator('[data-step$="/steps.unit"]').click();
  await expect(page).toHaveURL(/sel=test\.unit/);
  await page.keyboard.press('F2');
  const step = page.getByRole('textbox', { name: 'New id for the id of step 1 of test' });
  await expect(step).toHaveValue('unit');
  await page.keyboard.type('unit-tests');
  await page.keyboard.press('Enter');
  const review = page.getByRole('dialog', { name: 'Rename unit to unit-tests' });
  await expect(review).toContainText('2 places on 2 lines of ci.yml: the id and 1 expression read.');
  await review.getByRole('button', { name: 'Rename' }).click();
  await expect(page).toHaveURL(/sel=test\.unit-tests/);
  expect(await downloaded(page)).toBe(
    CI.replace('id: unit', 'id: unit-tests').replace('steps.unit.outcome', 'steps.unit-tests.outcome'),
  );
  expect(await transform(page)).toBe(before);
});
