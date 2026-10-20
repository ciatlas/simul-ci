import { useEffect, useState } from 'react';
import type { SessionState } from '../state/store';
import { useSession } from './providers';

/** How long an edit's plan may take before the screen says it is stale (synthesis § 4.11). */
const EDIT_STALE_MS = 300;

/**
 * What the plan on screen is stale for, as the screen says it. Changed inputs say so at once. An edit says so only
 * once its plan has taken longer than `EDIT_STALE_MS`, so ordinary typing, answered in about a tenth of a second,
 * never flickers the canvas, the status line or the top bar. A timer rather than a transition delay, so the words
 * wait too and an author who asked for less motion is not shown a flicker either.
 */
export function useStale(): SessionState['stale'] {
  const stale = useSession((s) => s.stale);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (stale !== 'edit') return undefined;
    const timer = setTimeout(() => setLate(true), EDIT_STALE_MS);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [stale]);
  return stale === 'edit' && !late ? false : stale;
}
