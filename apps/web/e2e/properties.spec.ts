import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Properties, the Node tab in edit mode (synthesis § 4.4, § 9.2 C4), in a real browser under the deployment's CSP:
 * `i` puts the focus in the selected job's Run if, a condition typed there commits after a pause and the card follows,
 * the field's whole visit is one undo entry that gives back the file's bytes; an aliased `runs-on` shows the reason it
 * cannot be written in place, and its fix is one undo entry too. axe finds nothing in Properties, light or dark.
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

const jobNode = (page: Page, job: string, path = CI): Locator =>
  page.locator(`.react-flow__node-job[data-id="${path}#${job}"]`);
const pane = (page: Page): Locator => page.locator('[data-pane="yaml"]');
const properties = (page: Page): Locator => page.locator('[data-panel="node"]');
const field = (page: Page, key: string): Locator => properties(page).locator(`[data-field="${key}"]`);

async function editMode(page: Page): Promise<void> {
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(page.getByRole('switch', { name: /^Edit/ })).toHaveAttribute('aria-checked', 'true');
}

/** The shown file as the pane's Download hands it over, byte for byte. */
async function downloaded(page: Page): Promise<Buffer> {
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  const downloading = page.waitForEvent('download');
  await pane(page).locator('footer').getByRole('button', { name: 'Download' }).click();
  return readFileSync(await (await downloading).path());
}

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

test('i puts the focus in Run if; a condition typed there skips deploy, and one undo gives back the bytes', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(jobNode(page, 'deploy')).not.toHaveAttribute('aria-label', /^skipped/);
  await editMode(page);
  await jobNode(page, 'deploy').click();
  await page.keyboard.press('i');
  const runIf = field(page, 'if').getByRole('textbox', { name: 'Run if' });
  await expect(runIf).toBeFocused();
  await expect(runIf).toHaveValue("github.event_name == 'push' || inputs.deploy");
  await expect(properties(page).getByText(/^evaluates to/)).toContainText('evaluates to true');
  // The whole text is selected: typing replaces it, and a pause commits it.
  await page.keyboard.type("github.ref == 'refs/heads/release'");
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /^skipped deploy/, { timeout: 3000 });
  await expect(properties(page).getByText(/^evaluates to/)).toContainText('evaluates to false');
  await expect(properties(page).getByText(/^evaluates to/)).toContainText('github.ref is "refs/heads/main"');
  // Leaving the field closes its visit: one entry, however many pauses committed it.
  await page.keyboard.press('Tab');
  await expect(undoButton(page)).toHaveAttribute('aria-label', "Undo Set deploy's if");
  await undoButton(page).click();
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(jobNode(page, 'deploy')).not.toHaveAttribute('aria-label', /^skipped/);
  expect((await downloaded(page)).toString('utf8')).toBe(STARTER_CI);
});

const ALIASED = `on: push
jobs:
  build:
    runs-on: &runner ubuntu-latest
    steps: [{ run: make }]
  deploy:
    needs: build
    runs-on: *runner
    steps: [{ run: ./deploy }]
`;

test('an aliased runs-on shows why it is read-only, and giving deploy its own value is one undo entry', async ({
  page,
}) => {
  await page.goto('/');
  await dropFiles(page, { 'aliased.yml': [...Buffer.from(ALIASED, 'utf8')] });
  const path = '.github/workflows/aliased.yml';
  await expect(jobNode(page, 'deploy', path)).toBeVisible();
  await editMode(page);
  await jobNode(page, 'deploy', path).click();
  await page.getByRole('tab', { name: 'Properties' }).click();
  const runsOn = field(page, 'runs-on');
  await expect(runsOn).toContainText('*runner');
  await expect(runsOn).toContainText('a reference to &runner on line 4.');
  await expect(runsOn.getByRole('textbox')).toHaveCount(0);
  const before = (await downloaded(page)).toString('utf8');
  await runsOn.getByRole('button', { name: "Give deploy's runs-on its own value" }).click();
  await expect(field(page, 'runs-on').getByRole('combobox', { name: 'Runs on' })).toHaveValue(
    'ubuntu-latest',
  );
  const after = (await downloaded(page)).toString('utf8');
  expect(after).toBe(before.replace('    runs-on: *runner\n', '    runs-on: ubuntu-latest\n'));
  await undoButton(page).click();
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect((await downloaded(page)).toString('utf8')).toBe(before);
});

/** axe over the right panel once every transition has run out. */
async function expectPanelAxeClean(page: Page, view: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const { violations } = await new AxeBuilder({ page }).include('[data-panel="node"]').analyze();
  expect(
    violations.map((v) => `${view}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test('axe finds nothing in Properties for a job, a step and a refused field, in light and dark', async ({
  page,
}) => {
  await page.goto('/');
  await dropFiles(page, { 'aliased.yml': [...Buffer.from(ALIASED, 'utf8')] });
  const path = '.github/workflows/aliased.yml';
  await expect(jobNode(page, 'deploy', path)).toBeVisible();
  await editMode(page);
  await jobNode(page, 'deploy', path).click();
  await page.getByRole('tab', { name: 'Properties' }).click();
  await expect(field(page, 'runs-on')).toContainText('a reference to');
  await expectPanelAxeClean(page, 'job with an alias');
  await page.locator('section[aria-label="Steps"] button').first().click();
  await expect(field(page, 'run').getByRole('textbox', { name: 'Run' })).toBeVisible();
  await expectPanelAxeClean(page, 'step');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectPanelAxeClean(page, 'step, dark');
});
