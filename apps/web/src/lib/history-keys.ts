/** What a history key asks for. */
export type HistoryCommand = 'undo' | 'redo';

type Keys = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented'> & {
  shiftKey?: boolean;
  code?: string;
};

/**
 * Mod+Z undoes, Mod+Shift+Z and Mod+Y redo (Mod: Ctrl or Cmd); Alt makes them someone else's, and so does a key
 * already handled. Read off the key whatever case its letter comes in (a browser may report Shift+Z as `z` with
 * `shiftKey`, and CodeMirror's keymap would then take it for Mod+Z), and off the physical key where the layout types
 * no Latin letter there (Ctrl+Я on a Russian layout is Ctrl+Z).
 */
export function historyCommand(event: Keys): HistoryCommand | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.defaultPrevented) return undefined;
  const key = letterOf(event);
  if (key === 'y') return 'redo';
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  return undefined;
}

/** The letter of a key, lowercase: the key's own, else the physical key's where the layout types no Latin letter. */
export const letterOf = (event: Keys): string | undefined =>
  /^[a-z]$/i.test(event.key)
    ? event.key.toLowerCase()
    : /^Key([A-Z])$/.exec(event.code ?? '')?.[1]?.toLowerCase();
