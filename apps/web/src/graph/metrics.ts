import type { Metrics } from './types';

/**
 * Text widths for the card sizes. In the browser, canvas `measureText` in the faces the token sheet loads (Mona Sans
 * for titles and body text, JetBrains Mono for ids and values), cached per font and string, so a label is measured
 * once per page. A width measured before its face loaded is the fallback face's and would stay cached, so the page
 * measures through `loadedMetrics`. In tests, and where no canvas exists, a fixed width per character.
 */

/** The fonts the cards are drawn in, as canvas.css sets them (`.sc-card-label` for the title, `.sc-scope` for body). */
const FONTS: Record<Parameters<Metrics['width']>[1], string> = {
  title: "600 12.5px 'Mona Sans Variable', ui-sans-serif, system-ui, sans-serif",
  body: "400 12.5px 'Mona Sans Variable', ui-sans-serif, system-ui, sans-serif",
  mono: "400 11px 'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
};

/** Px per character, close to the faces above at their sizes. */
const CHAR: Record<keyof typeof FONTS, number> = { title: 7, body: 6.5, mono: 7 };

export const tableMetrics: Metrics = {
  width: (text, font) => text.length * CHAR[font],
};

type Context = Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;

function context(): Context | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1).getContext('2d');
  if (typeof document !== 'undefined') return document.createElement('canvas').getContext('2d');
  return null;
}

/** Widths from a canvas, whole pixels rounded up so card sizes stay whole; the table where there is no canvas. */
export function canvasMetrics(): Metrics {
  const ctx = context();
  if (!ctx) return tableMetrics;
  const cache = new Map<string, number>();
  return {
    width(text, font) {
      const key = `${font}\0${text}`;
      let width = cache.get(key);
      if (width === undefined) {
        ctx.font = FONTS[font];
        width = Math.ceil(ctx.measureText(text).width);
        cache.set(key, width);
      }
      return width;
    },
  };
}

/** The canvas metrics once the card faces have loaded: the browser fetches a face only when something asks for it. */
export async function loadedMetrics(): Promise<Metrics> {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (fonts) {
    // A face that fails to load leaves the fallback in its place, which is then what the cards show.
    await Promise.all(Object.values(FONTS).map((font) => fonts.load(font))).catch(() => undefined);
    await fonts.ready;
  }
  return canvasMetrics();
}
