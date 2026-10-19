import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { createUrlSync } from '../state/url-sync';
import { useApp } from './providers';

/**
 * Wires the URL ↔ store bridge (state/url-sync.ts) to the router: every search the route renders with goes in, and
 * the bridge's writes go out through navigate. The route is not remounted on Back or Forward; it renders again with
 * the entry's search, which is how a move reaches the store.
 */
export function UrlSync() {
  const { store } = useApp();
  const router = useRouter();
  const navigate = useNavigate();
  const search = useSearch({ from: '/' });

  const sync = useMemo(
    () =>
      createUrlSync({
        store,
        navigate: (next, replace) => void navigate({ to: '/', search: next as never, replace }),
        current: () => router.latestLocation.search,
      }),
    [store, navigate, router],
  );

  useEffect(() => sync.start(), [sync]);
  useEffect(() => sync.urlChanged(search), [sync, search]);

  return null;
}
