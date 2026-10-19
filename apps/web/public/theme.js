// The theme before the first paint: `data-theme` from the theme the author stored (simulci.prefs), else from the OS.
// A classic script in <head> runs before the page paints; app/theme.ts takes over once the app boots.
(() => {
  let theme = 'system';
  try {
    const prefs = JSON.parse(localStorage.getItem('simulci.prefs') ?? 'null');
    if (prefs?.v === 1 && (prefs.theme === 'light' || prefs.theme === 'dark')) theme = prefs.theme;
  } catch {
    // Storage refused or unreadable: the OS decides.
  }
  if (theme === 'system') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
})();
