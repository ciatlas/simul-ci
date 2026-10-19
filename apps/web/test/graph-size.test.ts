import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasMetrics, loadedMetrics, tableMetrics } from '../src/graph/metrics';
import { calleeOffset, cardSize, gridCells, legGrid, stripRows } from '../src/graph/size';
import { CARD, type JobModel, type StepMark } from '../src/graph/types';

const step = (id: string, inner: StepMark[] = []): StepMark => ({ id, label: id, verdict: 'yes', inner });
const steps = (n: number): StepMark[] => Array.from({ length: n }, (_, i) => step(`s${i}`));

const job = (over: Partial<JobModel> = {}): JobModel => ({
  id: 'ci.yml#build',
  scope: 'ci.yml',
  jobId: 'build',
  label: 'build',
  verdict: 'yes',
  needs: [],
  steps: [],
  expanded: false,
  ...over,
});

const legs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `l${i}`,
    legKey: `${i}`,
    label: `${i}`,
    verdict: 'yes' as const,
  }));

describe('the leg grid', () => {
  it('is a near-square of value cells up to 48 legs, at most 16 columns', () => {
    expect(legGrid(1)).toMatchObject({
      cols: 1,
      rows: 1,
      values: true,
      histogram: false,
      width: 72,
      height: 20,
    });
    expect(legGrid(6)).toMatchObject({ cols: 3, rows: 2, cell: { width: 72, height: 20 }, width: 216 });
    expect(legGrid(48)).toMatchObject({ cols: 7, rows: 7, values: true, width: 504, height: 140 });
  });

  it('shows a mark and an index above 48 legs, and one row of counts above 512', () => {
    expect(legGrid(49)).toMatchObject({ cols: 7, rows: 7, values: false, cell: { width: 26, height: 18 } });
    expect(legGrid(512)).toMatchObject({ cols: 16, rows: 32, width: 416, height: 576, histogram: false });
    const counts = legGrid(2000);
    expect(counts).toMatchObject({ rows: 1, histogram: true, values: false, height: 20 });
    expect(counts.width).toBeLessThanOrEqual(CARD.minWidth - 2 * CARD.padding);
  });

  it('is empty for no legs', () => {
    expect(legGrid(0)).toMatchObject({ cols: 0, rows: 0, width: 0, height: 0 });
  });
});

describe('a card', () => {
  const plain = CARD.header + CARD.subline + CARD.stripRow + CARD.padding;

  it('fits its title between the narrowest and the widest card, and reserves the subline and a strip row', () => {
    expect(cardSize(job(), tableMetrics)).toEqual({ width: CARD.minWidth, height: plain });
    // 28 + 20 characters at 7 px + 24
    expect(cardSize(job({ label: 'a'.repeat(20) }), tableMetrics).width).toBe(192);
    expect(cardSize(job({ label: 'a'.repeat(60) }), tableMetrics).width).toBe(CARD.maxWidth);
  });

  it('grows a strip row per 26 marks, and the open list a row per step and inner step up to 40 and "+n"', () => {
    expect(cardSize(job({ steps: steps(26) }), tableMetrics).height).toBe(plain);
    expect(cardSize(job({ steps: steps(27) }), tableMetrics).height).toBe(plain + 14);
    const composite = [step('a', [step('a1'), step('a2')]), step('b')];
    expect(cardSize(job({ steps: composite, expanded: true }), tableMetrics).height).toBe(plain + 4 * 20);
    expect(cardSize(job({ steps: steps(45), expanded: true }), tableMetrics).height).toBe(
      plain + 14 + 41 * 20,
    );
  });

  it('is at least as wide as its leg grid, and as tall as its rows', () => {
    const size = cardSize(job({ legs: legs(9) }), tableMetrics);
    expect(size).toEqual({ width: 3 * 72 + 2 * CARD.padding, height: plain + 3 * 20 });
  });

  it('keeps its size when the job turns skipped and the plan drops its legs and steps', () => {
    const runs = job({ legs: legs(9), count: 9, steps: steps(4) });
    const skipped = job({ verdict: 'no', count: 9, steps: [] });
    expect(cardSize(skipped, tableMetrics)).toEqual(cardSize(runs, tableMetrics));
    expect(cardSize(job({ verdict: 'no' }), tableMetrics)).toEqual(
      cardSize(job({ steps: steps(3) }), tableMetrics),
    );
    // A matrix only the run knows: one ∗ cell, or the room for it.
    const star = [{ id: 'l*', legKey: '*', label: '∗', verdict: 'maybe' as const }];
    expect(cardSize(job({ verdict: 'no', count: '?' }), tableMetrics)).toEqual(
      cardSize(job({ legs: star, count: '?', steps: steps(2) }), tableMetrics),
    );
  });

  it('counts the grid from the legs, else the matrix, and the strip rows of every job but a call', () => {
    expect(gridCells(job({ legs: legs(3), count: 3 }))).toBe(3);
    expect(gridCells(job({ count: 6 }))).toBe(6);
    expect(gridCells(job({ count: '?' }))).toBe(1);
    expect(gridCells(job())).toBe(0);
    expect(stripRows(job())).toBe(1);
    expect(stripRows(job({ steps: steps(53) }))).toBe(3);
    expect(stripRows(job({ uses: './.github/workflows/deploy.yml' }))).toBe(0);
  });

  it('wraps its callee below its content, callPadding to the sides and below, whatever the verdicts', () => {
    const call = job({ legs: legs(2), uses: './.github/workflows/deploy.yml' });
    const callee = { width: 500, height: 200 };
    const top = CARD.header + CARD.subline + 20 + CARD.padding;
    expect(calleeOffset(call)).toEqual({ x: CARD.callPadding, y: top });
    expect(cardSize(call, tableMetrics, callee)).toEqual({
      width: 500 + 2 * CARD.callPadding,
      height: top + 200 + CARD.callPadding,
    });
    expect(cardSize(call, tableMetrics, { width: 40, height: 44 }).width).toBe(CARD.minWidth);
    expect(cardSize({ ...call, verdict: 'maybe', result: 'failure' }, tableMetrics, callee)).toEqual(
      cardSize(call, tableMetrics, callee),
    );
  });
});

describe('the metrics', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('measure each string once per font on a canvas, in whole pixels', () => {
    const measured: string[] = [];
    const ctx = {
      font: '',
      measureText(text: string) {
        measured.push(`${ctx.font}|${text}`);
        return { width: text.length * 6.2 };
      },
    };
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext = () => ctx;
      },
    );
    const metrics = canvasMetrics();
    expect(metrics.width('build', 'title')).toBe(31);
    expect(metrics.width('build', 'title')).toBe(31);
    expect(metrics.width('build', 'mono')).toBe(31);
    expect(measured).toHaveLength(2);
    expect(measured[0]).toContain('Mona Sans');
    expect(measured[1]).toContain('JetBrains Mono');
  });

  it('fall back to the width table where no canvas exists', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('document', undefined);
    expect(canvasMetrics()).toBe(tableMetrics);
  });

  it('wait for the card faces to load before measuring, and measure anyway when one fails', async () => {
    const loads: string[] = [];
    const fonts = {
      load: (font: string) => {
        loads.push(font);
        return font.includes('Mono') ? Promise.reject(new Error('offline')) : Promise.resolve([]);
      },
      ready: Promise.resolve(),
    };
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('document', { fonts, createElement: () => ({ getContext: () => null }) });
    expect(await loadedMetrics()).toBe(tableMetrics);
    expect(loads).toHaveLength(3);
  });
});
