import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PREFS_KEY } from '../src/state/prefs';

/** public/theme.js, run as the browser runs it before the first paint, against a fake page. */
const script = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');

function firstPaint(stored: string | null | Error, osDark: boolean): string | undefined {
  const attributes: Record<string, string> = {};
  runInNewContext(script, {
    localStorage: {
      getItem: (key: string) => {
        if (stored instanceof Error) throw stored;
        return key === PREFS_KEY ? stored : null;
      },
    },
    matchMedia: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && osDark }),
    document: { documentElement: { setAttribute: (k: string, v: string) => (attributes[k] = v) } },
  });
  return attributes['data-theme'];
}

const prefs = (theme: string, v = 1) => JSON.stringify({ v, theme, collapsed: { left: false, yaml: true } });

describe('the theme before the first paint', () => {
  it('takes the theme the author chose over the OS', () => {
    expect(firstPaint(prefs('light'), true)).toBe('light');
    expect(firstPaint(prefs('dark'), false)).toBe('dark');
  });

  it('follows the OS for system, for nothing stored and for anything it cannot read', () => {
    expect(firstPaint(prefs('system'), true)).toBe('dark');
    expect(firstPaint(null, true)).toBe('dark');
    expect(firstPaint(null, false)).toBe('light');
    expect(firstPaint(prefs('dark', 2), false)).toBe('light');
    expect(firstPaint(prefs('blue'), true)).toBe('dark');
    expect(firstPaint('{not json', true)).toBe('dark');
    expect(firstPaint(new Error('SecurityError'), false)).toBe('light');
  });

  it('runs as a classic script in the head, before the app', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('<script src="/theme.js"></script>');
    expect(html.indexOf('/theme.js')).toBeLessThan(html.indexOf('type="module"'));
  });
});
