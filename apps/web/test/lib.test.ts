import { describe, expect, it, vi } from 'vitest';
import { debounce } from '../src/lib/debounce';
import { fnv1a, hashFiles } from '../src/lib/hash';
import { memoryStore } from '../src/lib/idb';
import { DEFAULT_PREFS, PREFS_KEY, readPrefs, writePrefs } from '../src/state/prefs';

describe('debounce', () => {
  it('runs the last call after the quiet period, flushes and cancels', () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const d = debounce((n: number) => calls.push(n), 100);
    d.call(1);
    d.call(2);
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(99);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([2]);
    expect(d.pending()).toBe(false);
    d.call(3);
    d.flush();
    expect(calls).toEqual([2, 3]);
    d.call(4);
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([2, 3]);
    vi.useRealTimers();
  });
});

describe('hashes', () => {
  it('are stable, short and sensitive to content and path', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(hashFiles({ a: '1', b: '2' })).toBe(hashFiles({ b: '2', a: '1' }));
    expect(hashFiles({ a: '1', b: '2' })).not.toBe(hashFiles({ a: '2', b: '1' }));
    expect(hashFiles({ a: '1' })).not.toBe(hashFiles({ b: '1' }));
  });
});

describe('the memory store', () => {
  it('gets, sets and deletes', async () => {
    const s = memoryStore();
    expect(await s.get('k')).toBeUndefined();
    await s.set('k', { a: 1 });
    expect(await s.get('k')).toEqual({ a: 1 });
    await s.delete('k');
    expect(await s.get('k')).toBeUndefined();
  });
});

describe('preferences', () => {
  const memory = (): {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    map: Map<string, string>;
  } => {
    const map = new Map<string, string>();
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  };

  it('fall back to the defaults when missing, malformed, of another version or refused', () => {
    expect(readPrefs(undefined)).toEqual(DEFAULT_PREFS);
    const s = memory();
    expect(readPrefs(s)).toEqual(DEFAULT_PREFS);
    s.map.set(PREFS_KEY, '{not json');
    expect(readPrefs(s)).toEqual(DEFAULT_PREFS);
    s.map.set(PREFS_KEY, JSON.stringify({ v: 2, theme: 'dark' }));
    expect(readPrefs(s)).toEqual(DEFAULT_PREFS);
    s.map.set(PREFS_KEY, JSON.stringify({ v: 1, theme: 'blue', collapsed: { left: 'yes' } }));
    expect(readPrefs(s)).toEqual(DEFAULT_PREFS);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readPrefs(throwing)).toEqual(DEFAULT_PREFS);
    expect(() => writePrefs(DEFAULT_PREFS, throwing)).not.toThrow();
  });

  it('round-trip what was written', () => {
    const s = memory();
    const prefs = { v: 1 as const, theme: 'dark' as const, collapsed: { left: true, yaml: false } };
    writePrefs(prefs, s);
    expect(readPrefs(s)).toEqual(prefs);
  });
});
