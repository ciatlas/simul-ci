import { useState } from 'react';

/**
 * Whether a field stays in view while the author edits. Some fields show only while the scenario holds their value
 * (a ref an event carries, Merged on a pull request that is not closed), so the edit that empties the value would
 * take the field from under the caret. Once shown it stays until the key it was shown for changes (the event, or the
 * event and its action) or a scenario comes from outside (the URL, the defaults), which decides afresh; so does a new
 * project, since the form's fields mount with each one.
 */

export interface Kept {
  key: string;
  on: boolean;
}

export function kept(prev: Kept, key: string, shown: boolean, byAuthor: boolean): Kept {
  if (byAuthor && prev.key === key) return shown && !prev.on ? { key, on: true } : prev;
  return prev.key === key && prev.on === shown ? prev : { key, on: shown };
}

export function useKept(key: string, shown: boolean, byAuthor: boolean): boolean {
  const [state, setState] = useState<Kept>({ key, on: shown });
  const next = kept(state, key, shown, byAuthor);
  if (next !== state) setState(next);
  return next.on;
}
