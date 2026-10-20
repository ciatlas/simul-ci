import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

/**
 * The latency gate (synthesis § 7.5, § 9.5) over flowpact's nine workflows (MIT, `fixtures/flowpact`, 1.6k lines):
 * a key typed into the pane reaches the plan in the store (`edit:plan`) and the canvas's next frame (`edit:painted`)
 * within twice the targets at the 95th percentile, a burst of 40 keys runs no task over 50 ms on the main thread, and
 * no plan that comes while the author types moves the cursor.
 * The marks are the page's own (`src/lib/marks.ts`). The figures go to the run's step summary.
 */

const DIR = join(import.meta.dirname, 'fixtures/flowpact');
const FILES = Object.fromEntries(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => [f, [...readFileSync(join(DIR, f))]]),
);

/** § 7.5's target for a key to the plan on screen, p95, at up to 2k lines; the gate blocks at twice it. */
const TARGET_MS = 250;
const SAMPLES = 20;

/** Every task over 50 ms the browser reports, from the first script on. */
async function watchLongTasks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { longTasks: { start: number; ms: number }[] };
    w.longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.longTasks.push({ start: e.startTime, ms: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
}

/** The newest mark of an edit stage, with the files version it is for. */
const markOf = (page: Page, name: string) =>
  page.evaluate((n) => {
    const m = performance.getEntriesByName(n).at(-1) as PerformanceMark | undefined;
    return m ? { at: m.startTime, files: (m.detail as { files: number }).files } : undefined;
  }, name);

/** Milliseconds from the newest key to the first `stage` mark of its texts or newer. */
async function waitFor(page: Page, stage: string, tx: { at: number; files: number }): Promise<number> {
  let mark = await markOf(page, stage);
  for (let i = 0; i < 400 && !(mark && mark.files >= tx.files); i++) {
    await page.waitForTimeout(10);
    mark = await markOf(page, stage);
  }
  if (!mark || mark.files < tx.files) throw new Error(`no ${stage} for files ${tx.files}`);
  return mark.at - tx.at;
}

const p95 = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
};

test('a key reaches the plan on screen within twice the target, and a burst of keys blocks the page for no long task', async ({
  page,
}) => {
  await watchLongTasks(page);
  await page.goto('/');
  const transfer = await page.evaluateHandle((given) => {
    const dt = new DataTransfer();
    for (const [name, bytes] of Object.entries(given)) dt.items.add(new File([new Uint8Array(bytes)], name));
    return dt;
  }, FILES);
  await page.dispatchEvent('header', 'drop', { dataTransfer: transfer });
  await expect(page.locator('.react-flow__node-job').first()).toBeVisible();
  await page.getByRole('switch', { name: /^Edit/ }).click();
  if ((await page.locator('[data-pane="yaml"]').count()) === 0) await page.keyboard.press('\\');
  await page.getByRole('tab', { name: /^release\.yml/ }).click();
  const editor = page.locator('[data-pane="yaml"] .cm-content');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('End');
  await page.keyboard.type(' #');

  // One key at a time: each answered before the next.
  const toPlan: number[] = [];
  const toPaint: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    await page.keyboard.type('x');
    const tx = (await markOf(page, 'edit:tx'))!;
    toPlan.push(await waitFor(page, 'edit:plan', tx));
    toPaint.push(await waitFor(page, 'edit:painted', tx));
  }

  // A burst of 40 keys, 50 ms apart: no task on the main thread over 50 ms while it lasts.
  const from = await page.evaluate(() => performance.now());
  await page.keyboard.type('y'.repeat(40), { delay: 50 });
  const to = await page.evaluate(() => performance.now());
  // Twenty plans came while the author typed: the cursor never moved, so every key landed where the last one ended.
  await expect(editor.locator('.cm-line').first()).toHaveText(
    `name: Release #${'x'.repeat(SAMPLES)}${'y'.repeat(40)}`,
  );
  const long = await page.evaluate(
    ([a, b]) =>
      (window as unknown as { longTasks: { start: number; ms: number }[] }).longTasks.filter(
        (t) => t.start + t.ms > a! && t.start < b!,
      ),
    [from, to],
  );

  const summary = [
    '### Edit latency (flowpact, 9 workflows)',
    '',
    `| stage | p95 ms | target ms | blocks above ms |`,
    `|---|---:|---:|---:|`,
    `| key → plan in the store | ${p95(toPlan).toFixed(0)} | ${TARGET_MS} | ${2 * TARGET_MS} |`,
    `| key → plan on screen | ${p95(toPaint).toFixed(0)} | ${TARGET_MS} | ${2 * TARGET_MS} |`,
    `| long tasks over 50 ms during 40 keys | ${long.length} | 0 | 0 |`,
    '',
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  expect(p95(toPlan)).toBeLessThanOrEqual(2 * TARGET_MS);
  expect(p95(toPaint)).toBeLessThanOrEqual(2 * TARGET_MS);
  expect(long).toEqual([]);
});
