import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * The run graph in a real browser, over the bundled starter sample: both workers run, the canvas tells each job's
 * run state as the text view tells it, a job picked on the canvas or in the outline is the URL's `sel` and the
 * selected card, the canvas keys walk the graph from a Tab into it and keep the focus on the card they move to, and
 * the viewport stays where the author put it.
 */

const CI = '.github/workflows/ci.yml';
/** The mark's accessible name (graph/Mark.tsx) as the text view's glyph. */
const GLYPH: Record<string, string> = { runs: '●', skipped: '○', 'might run': '◐' };
/** React Flow's class for a selected node, which the model sets from the store's selection. */
const SELECTED = /(?:^|\s)selected(?:\s|$)/;

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

const canvasOf = (page: Page): Locator => page.getByRole('region', { name: 'The run graph' });
const jobNode = (page: Page, job: string): Locator =>
  page.locator(`.react-flow__node-job[data-id="${CI}#${job}"]`);
const workflowNode = (page: Page): Locator => page.locator(`.react-flow__node-workflow[data-id="${CI}"]`);
const treeItem = (page: Page, label: string): Locator =>
  page.getByRole('treeitem', { name: new RegExp(`^${label}, `) });
const viewButton = (page: Page, name: 'Graph' | 'Text'): Locator =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name, exact: true });
const sel = (page: Page): string | null => new URL(page.url()).searchParams.get('sel');
const transform = (page: Page): Promise<string> =>
  page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
const scaleOf = (t: string): number => Number(/scale\(([\d.]+)\)/.exec(t)![1]);
const ORIGIN = 'translate(0px, 0px) scale(1)';

/** The transform once it has not moved for a few frames, so an animation has run out. */
async function settled(page: Page): Promise<string> {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = await transform(page);
    if (now === last) return now;
    last = now;
    await page.waitForTimeout(100);
  }
  return last;
}

/** Tab from the page until the focus is inside the canvas. */
async function tabIntoCanvas(page: Page): Promise<void> {
  const canvas = canvasOf(page);
  for (let i = 0; i < 30 && (await canvas.locator(':focus').count()) === 0; i++)
    await page.keyboard.press('Tab');
}

/** The empty page, the starter sample, and the first graph laid out. */
async function openStarter(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /^Starter/ }).click();
  await expect(jobNode(page, 'deploy')).toBeVisible();
}

/** Each job card's mark by node id (`path#job`), as the canvas shows it. */
function canvasMarks(page: Page): Promise<Record<string, string>> {
  return canvasOf(page)
    .locator('.react-flow__node-job')
    .evaluateAll((nodes, glyph) => {
      const marks: Record<string, string> = {};
      for (const node of nodes) {
        const mark = node.querySelector('.sc-card-header [role="img"]')?.getAttribute('aria-label') ?? '';
        marks[node.getAttribute('data-id') ?? ''] = glyph[mark] ?? mark;
      }
      return marks;
    }, GLYPH);
}

/**
 * Each job line's mark by `path#job`, as `simulci plan` prints it: a workflow line has no indent and the path after
 * its mark, its jobs sit one level under it with the job id after theirs; legs, steps and callees sit deeper.
 */
function textMarks(text: string): Record<string, string> {
  const marks: Record<string, string> = {};
  let workflow: string | undefined;
  for (const line of text.split('\n')) {
    const m = /^( *)([●○◐]) (\S+)/.exec(line);
    if (!m) continue;
    const [, indent, mark, name] = m;
    if (indent === '') workflow = name;
    else if (indent === '  ' && workflow !== undefined) marks[`${workflow}#${name}`] = mark!;
  }
  return marks;
}

/** The canvas's marks, then the text view's through the toggle, and back to the graph. */
async function expectMarksMatchText(page: Page): Promise<Record<string, string>> {
  const shown = await canvasMarks(page);
  await viewButton(page, 'Text').click();
  const text = await page.getByLabel('The plan').innerText();
  await viewButton(page, 'Graph').click();
  await expect(jobNode(page, 'deploy')).toBeVisible();
  expect(shown).toEqual(textMarks(text));
  return shown;
}

/** `sel` in the URL, React Flow's selected node, the card's own attribute and the outline row all name the job. */
async function expectSelected(page: Page, job: string): Promise<void> {
  await expect.poll(() => sel(page)).toBe(job);
  await expect(jobNode(page, job)).toHaveClass(SELECTED);
  await expect(jobNode(page, job).locator('.sc-card')).toHaveAttribute('data-selected', 'self');
  await expect(treeItem(page, job)).toHaveAttribute('aria-selected', 'true');
}

test('every job card shows the mark the text view gives that job, for the default scenario and a changed file', async ({
  page,
}) => {
  await openStarter(page);
  const first = await expectMarksMatchText(page);
  expect(Object.keys(first)).toHaveLength(4);
  expect(new Set(Object.values(first))).toEqual(new Set(['◐', '○']));

  // A changed source file passes CI's paths-ignore: the workflow runs, and test with it.
  await page.getByLabel(/^Changed files/).fill('src/index.ts');
  await expect(workflowNode(page)).toHaveAttribute('aria-label', /^runs CI/);
  const second = await expectMarksMatchText(page);
  expect(second[`${CI}#test`]).toBe('●');
});

test('a job picked on the canvas or in the outline becomes sel in the URL and the selected card', async ({
  page,
}) => {
  await openStarter(page);
  await expect(workflowNode(page)).toHaveClass(SELECTED);

  await jobNode(page, 'deploy').locator('.sc-card-label').click();
  await expectSelected(page, 'deploy');
  await expect(workflowNode(page)).not.toHaveClass(SELECTED);

  await treeItem(page, 'test').click();
  await expectSelected(page, 'test');
  await expect(jobNode(page, 'deploy')).not.toHaveClass(SELECTED);

  await treeItem(page, 'deploy').click();
  await expectSelected(page, 'deploy');
  await expect(jobNode(page, 'test')).not.toHaveClass(SELECTED);
});

test('the keys walk the graph from a Tab into it: Enter goes in, ↓ to the next job, Esc back out', async ({
  page,
}) => {
  await openStarter(page);
  const canvas = canvasOf(page);
  await tabIntoCanvas(page);
  await expect(workflowNode(page)).toBeFocused();

  await page.keyboard.press('Enter');
  await expectSelected(page, 'test');
  await expect(jobNode(page, 'test')).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expectSelected(page, 'build');
  await expect(jobNode(page, 'build')).toBeFocused();

  // Into build's steps: the card keeps the selection inside it, the outline names the step.
  await page.keyboard.press('Enter');
  await expect.poll(() => sel(page)).toMatch(/^build\./);
  await expect(jobNode(page, 'build').locator('.sc-card')).toHaveAttribute('data-selected', 'inner');
  await expect(page.getByRole('treeitem', { selected: true })).toHaveAccessibleName(
    /^actions\/checkout@v4, /,
  );

  await page.keyboard.press('Escape');
  await expectSelected(page, 'build');

  await page.keyboard.press('Escape');
  await expect.poll(() => sel(page)).toBeNull();
  await expect(workflowNode(page)).toHaveClass(SELECTED);
  await expect(workflowNode(page)).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(canvas.locator(':focus')).toHaveCount(0);
});

test('a Tab into the canvas lands on the selected card, the only card Tab reaches, and the keys act from it', async ({
  page,
}) => {
  await openStarter(page);
  await treeItem(page, 'deploy').click();
  await expectSelected(page, 'deploy');
  await page.keyboard.press('Tab');
  await expect(jobNode(page, 'deploy')).toBeFocused();
  await expect(canvasOf(page).locator('.react-flow__node[tabindex="0"]')).toHaveCount(1);

  // ← follows deploy's first need; the focus goes with the selection.
  await page.keyboard.press('ArrowLeft');
  await expectSelected(page, 'test');
  await expect(jobNode(page, 'test')).toBeFocused();

  // A card clicked takes the focus and the selection together, and Esc goes up from it.
  await jobNode(page, 'build').locator('.sc-card-label').click();
  await expectSelected(page, 'build');
  await page.keyboard.press('Escape');
  await expect.poll(() => sel(page)).toBeNull();
  await expect(workflowNode(page)).toBeFocused();
});

test('a key that moves to a card out of view keeps the focus on that card while the view pans to it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 420 });
  await openStarter(page);
  const zoomIn = page.getByRole('button', { name: 'Zoom In' });
  for (let i = 0; i < 10 && (await zoomIn.isEnabled()); i++) await zoomIn.click();
  expect(scaleOf(await settled(page))).toBe(2);

  // Back from the zoom buttons to the canvas's one tab stop, the selected workflow.
  await page.keyboard.press('Shift+Tab');
  await expect(workflowNode(page)).toBeFocused();
  await settled(page);
  const release = page.locator('.react-flow__node-workflow[data-id=".github/workflows/release.yml"]');
  await expect(release).not.toBeInViewport();
  await page.keyboard.press('ArrowDown');
  await expect(release).toBeFocused();
  await settled(page);
  await expect(release).toBeFocused();
  await expect(release).toBeInViewport();

  await page.keyboard.press('ArrowUp');
  await expect(workflowNode(page)).toBeFocused();
  await expect(workflowNode(page)).toHaveClass(SELECTED);
});

test('the graph opens where the author left it after the text view, and a newly loaded sample is fitted', async ({
  page,
}) => {
  await openStarter(page);
  const fitted = await settled(page);
  expect(fitted).not.toBe(ORIGIN);
  await page.getByRole('button', { name: 'Zoom In' }).click();
  const moved = await settled(page);
  expect(moved).not.toBe(fitted);

  await viewButton(page, 'Text').click();
  await viewButton(page, 'Graph').click();
  await expect(jobNode(page, 'deploy')).toBeVisible();
  expect(await settled(page)).toBe(moved);

  await page.getByLabel('Sample').selectOption('monorepo');
  await expect(jobNode(page, 'gate')).toBeVisible();
  expect(await settled(page)).not.toBe(ORIGIN);
});

test('a double-click zooms in at once for an author who asked for less motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openStarter(page);
  const before = scaleOf(await settled(page));
  const box = (await canvasOf(page).boundingBox())!;
  await page.mouse.dblclick(box.x + 6, box.y + 6);
  const at = await transform(page);
  expect(scaleOf(at)).toBeCloseTo(Math.min(2, before * 2));
  await page.waitForTimeout(300);
  expect(await transform(page)).toBe(at);
});

test('names each needs edge by who needs whom and the needed job’s run state', async ({ page }) => {
  await openStarter(page);
  await expect(canvasOf(page).getByRole('img', { name: 'build needs test (might run)' })).toBeAttached();
  await expect(jobNode(page, 'deploy')).toHaveAccessibleName(/, needs test, build$/);
});

test('a hover and a click redraw the cards they touch and no edge', async ({ page }) => {
  await openStarter(page);
  await canvasOf(page)
    .locator('.react-flow__edges')
    .evaluate((edges) => {
      const w = window as unknown as { removedEdges: number };
      w.removedEdges = 0;
      new MutationObserver((records) => {
        for (const r of records) w.removedEdges += r.removedNodes.length;
      }).observe(edges, { childList: true, subtree: true });
    });
  await jobNode(page, 'build').hover();
  await expect(page.locator('.sc-hover').filter({ hasText: 'needs: test' })).toBeVisible();
  await page.mouse.move(0, 0);
  await jobNode(page, 'deploy').locator('.sc-card-label').click();
  await expectSelected(page, 'deploy');
  expect(await page.evaluate(() => (window as unknown as { removedEdges: number }).removedEdges)).toBe(0);
});

test('a card off the selected job’s path keeps its text at 4.5:1 or more', async ({ page }) => {
  await openStarter(page);
  await jobNode(page, 'deploy').locator('.sc-card-label').click();
  const preview = jobNode(page, 'preview').locator('.sc-card');
  await expect(preview).toHaveAttribute('data-path', 'off');
  const ratio = await preview.evaluate((card) => {
    const rgb = (c: string) =>
      c
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const label = card.querySelector('.sc-card-label')!;
    const [a, b] = [lum(getComputedStyle(label).color), lum(getComputedStyle(card).backgroundColor)];
    let faded = 1;
    for (let el: Element | null = card; el; el = el.parentElement)
      faded *= Number(getComputedStyle(el).opacity);
    return { contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), faded };
  });
  expect(ratio.faded).toBe(1);
  expect(ratio.contrast).toBeGreaterThanOrEqual(4.5);
});
