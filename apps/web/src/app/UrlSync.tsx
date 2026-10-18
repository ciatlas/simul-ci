import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { debounce } from '../lib/debounce';
import { readSearch, type UrlState, urlSliceChanged, urlStateOf, writeSearch } from '../state/url';
import { useApp } from './providers';

/**
 * The URL ↔ store bridge: on mount the search params seed the store; afterwards the store's URL-backed slice is
 * written back, replaced in place after 300 ms of quiet, pushed when the event changed so Back walks between events.
 */
export function UrlSync() {
  const { store } = useApp();
  const search = useSearch({ from: '/' });
  const navigate = useNavigate();
  const seeded = useRef(false);
  const lastWritten = useRef<string>('');

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const url = readSearch(search);
    const a = store.getState();
    if (url.scenario) a.setScenario(url.scenario, { from: 'url' });
    if (url.assume) a.setAssume(url.assume);
    if (url.wf) a.setFocus(url.wf);
    if (url.d) a.setDetail(url.d);
    if (url.view) a.setView(url.view);
    if (url.hide) a.setHideUntriggered(true);
    lastWritten.current = JSON.stringify(writeSearch(url));
  }, [search, store]);

  useEffect(() => {
    const write = debounce((state: UrlState, push: boolean) => {
      const next = writeSearch(state);
      const key = JSON.stringify(next);
      if (key === lastWritten.current) return;
      lastWritten.current = key;
      void navigate({ to: '/', search: next as never, replace: !push });
    }, 300);
    const unsubscribe = store.subscribe((s, prev) => {
      // The page's own default scenario is written once a project backs it; before that the URL says nothing.
      if (s.scenarioFrom === 'default' && s.project.status !== 'ready') return;
      if (urlSliceChanged(s, prev)) write.call(urlStateOf(s), s.scenario.event !== prev.scenario.event);
    });
    return () => {
      unsubscribe();
      write.cancel();
    };
  }, [navigate, store]);

  return null;
}
