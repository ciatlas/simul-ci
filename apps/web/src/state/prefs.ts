/** Layout preferences in localStorage: nothing that decides a result, nothing another viewer needs. */
export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  /** Panes the author closed. */
  collapsed: { left: boolean; yaml: boolean };
  /** `simulci.prefs` is versioned so a later shape can drop an older one. */
  v: 1;
}

export const PREFS_KEY = 'simulci.prefs';

export const DEFAULT_PREFS: Prefs = { theme: 'system', collapsed: { left: false, yaml: true }, v: 1 };

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const THEMES = new Set(['system', 'light', 'dark']);

/** Reads the preferences; anything missing, malformed or refused by the browser falls back to the defaults. */
export function readPrefs(store: StorageLike | undefined = storage()): Prefs {
  try {
    const raw = store?.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs> | null;
    if (!parsed || parsed.v !== 1) return DEFAULT_PREFS;
    return {
      v: 1,
      theme: THEMES.has(parsed.theme as string) ? (parsed.theme as Prefs['theme']) : DEFAULT_PREFS.theme,
      collapsed: {
        left:
          typeof parsed.collapsed?.left === 'boolean' ? parsed.collapsed.left : DEFAULT_PREFS.collapsed.left,
        yaml:
          typeof parsed.collapsed?.yaml === 'boolean' ? parsed.collapsed.yaml : DEFAULT_PREFS.collapsed.yaml,
      },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Writes the preferences; a refusal (quota, private window) is not an error the author can act on. */
export function writePrefs(prefs: Prefs, store: StorageLike | undefined = storage()): void {
  try {
    store?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // The page works without remembered preferences.
  }
}
