import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The token sheet's colours, light and dark, read from src/index.css as the page reads them. */
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
}

const light = block(':root');
const themes = { light, dark: { ...light, ...block(":root[data-theme='dark']") } };

/** WCAG 2's contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [red, green, blue] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Text the form draws, as [foreground, background]: the scenario sits on the chrome. */
const TEXT = [
  ['muted', 'chrome'],
  ['text', 'chrome'],
  ['danger', 'chrome'],
  ['text', 'surface'],
  ['text', 'might-soft'],
  ['text', 'danger-soft'],
] as const;

/** The outlines that identify a control or its state, held to 3:1 against what is next to them. */
const OUTLINES = [
  // The switch off: its outline on the chrome, its knob on the surface track.
  ['muted', 'chrome'],
  ['muted', 'surface'],
  // The switch on: the accent track on the chrome, the surface knob on the accent.
  ['accent', 'chrome'],
  ['surface', 'accent'],
  // The changed files while unknown.
  ['might', 'chrome'],
] as const;

describe('the contrast of the form', () => {
  it.each(Object.entries(themes))('keeps text at 4.5:1 in the %s theme', (_, tokens) => {
    for (const [fg, bg] of TEXT)
      expect(contrast(tokens[fg]!, tokens[bg]!), `${fg} on ${bg}`).toBeGreaterThan(4.5);
  });

  it.each(Object.entries(themes))('keeps control outlines at 3:1 in the %s theme', (_, tokens) => {
    for (const [fg, bg] of OUTLINES)
      expect(contrast(tokens[fg]!, tokens[bg]!), `${fg} on ${bg}`).toBeGreaterThan(3);
  });

  it('reads every token both themes define', () => {
    expect(Object.keys(light)).toHaveLength(19);
    expect(Object.keys(themes.dark)).toEqual(Object.keys(light));
    expect(themes.dark.chrome).not.toBe(light.chrome);
    expect(contrast(light['might']!, light['chrome']!)).toBeLessThan(4.5);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
  });
});
