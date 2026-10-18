import type { Prefs } from '../state/prefs';

/**
 * `data-theme` on the root is always `light` or `dark`: `system` resolves through the OS preference and follows it
 * until the author picks one.
 */
let stop: (() => void) | undefined;

export function applyTheme(theme: Prefs['theme']): void {
  if (typeof document === 'undefined') return;
  stop?.();
  stop = undefined;
  const root = document.documentElement;
  if (theme !== 'system') {
    root.setAttribute('data-theme', theme);
    return;
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const follow = (): void => root.setAttribute('data-theme', query.matches ? 'dark' : 'light');
  follow();
  query.addEventListener('change', follow);
  stop = () => query.removeEventListener('change', follow);
}

export const NEXT_THEME: Record<Prefs['theme'], Prefs['theme']> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};
