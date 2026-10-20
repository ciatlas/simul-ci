import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The canvas as the builder (synthesis § 4.2, § 4.5, § 9.2 C5), in a real browser under the deployment's CSP: `a` and
 * Enter add a job that is laid out, selected, focused and runs; a drag from one card's handle onto another's writes the
 * need in the file's style; a drag that would loop draws nothing and says why; deleting a job that others need asks,
 * then takes their needs with it; and undoing each gives the file's bytes back.
 */

const PATH = '.github/workflows/ci.yml';

const CI = `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  build:
    needs:
      - test
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
  deploy:
    needs:
      - build
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
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
const status = (page: Page): Locator => page.getByRole('contentinfo');

/** Drops loose files on the page, as the author drags them in: they become pasted workflows by their names. */
async function dropFiles(page: Page, files: Record<string, string>): Promise<void> {
  const transfer = await page.evaluateHandle((given) => {
    const dt = new DataTransfer();
    for (const [name, text] of Object.entries(given)) dt.items.add(new File([text], name));
    return dt;
  }, files);
  await page.dispatchEvent('header', 'drop', { dataTransfer: transfer });
}

/** The CI file dropped, laid out, in edit mode. */
async function opened(page: Page): Promise<void> {
  await page.goto('/');
  await dropFiles(page, { 'ci.yml': CI });
  await expect(jobNode(page, 'lint')).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  await expect(page.getByRole('switch', { name: /^Edit/ })).toHaveAttribute('aria-checked', 'true');
  // The canvas offers its gestures once the edit runtime is in.
  await expect(page.getByRole('button', { name: '+ Add job' })).toBeAttached();
}

/** The file as the pane's Download hands it over, byte for byte. */
async function downloaded(page: Page): Promise<string> {
  if ((await pane(page).count()) === 0) await page.keyboard.press('\\');
  const downloading = page.waitForEvent('download');
  await pane(page).locator('footer').getByRole('button', { name: 'Download' }).click();
  return readFileSync(await (await downloading).path(), 'utf8');
}

/** Undoes every entry with the top bar's button. */
async function undoAll(page: Page): Promise<void> {
  const undo = page.getByRole('button', { name: /^Undo/ }).first();
  while ((await undo.getAttribute('aria-disabled')) !== 'true') await undo.click();
}

/** The centre of a card's handle: `source` on its right edge, `target` on its left. */
async function handleOf(page: Page, job: string, kind: 'source' | 'target') {
  const box = await jobNode(page, job).locator(`.react-flow__handle.${kind}`).boundingBox();
  if (!box) throw new Error(`no ${kind} handle on ${job}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A drag from one card's source handle onto another's target handle, as a hand makes it. */
async function connect(page: Page, from: string, to: string): Promise<void> {
  const start = await handleOf(page, from, 'source');
  const end = await handleOf(page, to, 'target');
  await jobNode(page, from).hover();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

test('a and Enter add a job after the selected one that is laid out, selected, focused and runs', async ({
  page,
}) => {
  await opened(page);
  await jobNode(page, 'build').click();
  await page.keyboard.press('a');
  const popover = page.getByRole('dialog', { name: 'Add a job after build' });
  await expect(popover.getByRole('textbox', { name: 'Id' })).toBeFocused();
  await expect(popover.getByRole('textbox', { name: 'Id' })).toHaveValue('job');
  await page.keyboard.press('Enter');
  await expect(popover).toBeHidden();
  const card = jobNode(page, 'job');
  await expect(card).toHaveAttribute('aria-label', /^runs job, needs build$/);
  await expect(card.locator('.sc-card')).toHaveAttribute('data-selected', 'self');
  await expect(card).toBeFocused();
  await expect(status(page).locator('[aria-live]')).toHaveText(
    'Added job job after build: new job job runs',
    {
      timeout: 3000,
    },
  );
  const written = await downloaded(page);
  expect(written).toContain(
    '      - run: npm run build\n  job:\n    runs-on: ubuntu-latest\n    needs:\n      - build\n    steps:\n      - uses: actions/checkout@v5\n  deploy:\n',
  );
  await undoAll(page);
  expect(await downloaded(page)).toBe(CI);
});

test('a drag from one card’s handle onto another’s writes the need in the file’s style', async ({ page }) => {
  await opened(page);
  await connect(page, 'lint', 'deploy');
  await expect(jobNode(page, 'deploy')).toHaveAttribute('aria-label', /needs build, lint$/, {
    timeout: 3000,
  });
  expect(await downloaded(page)).toContain('  deploy:\n    needs:\n      - build\n      - lint\n');
  await undoAll(page);
  expect(await downloaded(page)).toBe(CI);
});

test('a drag that would loop draws no need and says why', async ({ page }) => {
  await opened(page);
  await connect(page, 'deploy', 'test');
  const sentence = 'deploy already needs test through build; test needing deploy would loop.';
  await expect(status(page).getByRole('status')).toContainText(sentence);
  await expect(page.getByRole('note', { name: 'Refused' })).toContainText(sentence);
  await expect(page.getByRole('button', { name: /^Undo/ }).first()).toHaveAttribute('aria-disabled', 'true');
  expect(await downloaded(page)).toBe(CI);
});

test('deleting a job others need asks, then takes their needs with it; Undo in the notice gives the bytes back', async ({
  page,
}) => {
  await opened(page);
  await jobNode(page, 'build').click();
  await page.keyboard.press('Delete');
  const ask = page.getByRole('dialog', { name: 'Remove job build?' });
  await expect(ask).toContainText('deploy needs it: its need on build goes too.');
  await expect(ask.getByRole('button', { name: 'Remove build' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ask).toBeHidden();
  // Nothing was written, and the focus is back on the card.
  await expect(jobNode(page, 'build')).toBeFocused();
  await page.keyboard.press('Delete');
  await ask.getByRole('button', { name: 'Remove build' }).click();
  await expect(jobNode(page, 'build')).toHaveCount(0, { timeout: 3000 });
  const notice = page.getByRole('status').filter({ hasText: "Removed build and deploy's need on it" });
  await expect(notice).toBeVisible();
  const written = await downloaded(page);
  expect(written).not.toContain('build');
  expect(written).toContain('  deploy:\n    runs-on: ubuntu-latest\n');
  // test was before build: it holds the selection now.
  await expect(jobNode(page, 'test').locator('.sc-card')).toHaveAttribute('data-selected', 'self');
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(jobNode(page, 'build')).toBeVisible();
  expect(await downloaded(page)).toBe(CI);
});

test('Delete on a focused edge removes its need; ✕ beside it does the same', async ({ page }) => {
  await opened(page);
  const edge = page.locator(`.react-flow__edge[data-id="${PATH}#test->${PATH}#build"]`);
  await edge.focus();
  await expect(page.getByRole('button', { name: 'Remove the need: build needs test' })).toHaveAttribute(
    'data-hot',
    'true',
  );
  await page.keyboard.press('Delete');
  await expect(jobNode(page, 'build')).not.toHaveAttribute('aria-label', /needs/, { timeout: 3000 });
  await page.getByRole('button', { name: /^Undo/ }).first().click();
  await expect(jobNode(page, 'build')).toHaveAttribute('aria-label', /needs test$/);
  // The pointer on the line's middle, then on its ✕, which the line's hover shows.
  const line = page.locator(
    `.react-flow__edge[data-id="${PATH}#build->${PATH}#deploy"] .react-flow__edge-interaction`,
  );
  const middle = await line.evaluate((path: SVGPathElement) => {
    const at = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f };
  });
  await page.mouse.move(middle.x, middle.y);
  const remove = page.getByRole('button', { name: 'Remove the need: deploy needs build' });
  await expect(remove).toHaveAttribute('data-hot', 'true');
  await remove.click();
  await expect(jobNode(page, 'deploy')).not.toHaveAttribute('aria-label', /needs/, { timeout: 3000 });
  await undoAll(page);
  expect(await downloaded(page)).toBe(CI);
});
