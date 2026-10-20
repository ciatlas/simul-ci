import type { LoadedProject, WorkflowSettings } from '@simulci/engine';

/** The lines of `on:`, of each event key under it and of each filter key, which the plan's trigger reasons lack. */
export type EventLines = Record<string, { line: number; filters: Record<string, number> }>;

export interface OnLines {
  on: number;
  events: EventLines;
}

/**
 * What one file's text gave the previous load, kept while the text is unchanged: its run settings (`readSettings` is
 * pure in path and text) and its `on:` lines (the outline's own parse). Every load still carries every file; this
 * only spares reading an unchanged one again.
 */
export interface CacheEntry {
  text: string;
  settings?: WorkflowSettings;
  onLines?: OnLines;
}

export type FileCache = ReadonlyMap<string, CacheEntry>;

/**
 * The cache for a new load: a file whose text is unchanged keeps what was read from it, a changed or new one starts
 * empty, and a path the load no longer carries is dropped. A new source is just another load: whatever it shares with
 * the previous one by path and text is reused, the rest starts cold.
 */
export function carry(previous: FileCache, files: Record<string, string>): FileCache {
  const next = new Map<string, CacheEntry>();
  for (const [path, text] of Object.entries(files)) {
    const entry = previous.get(path);
    next.set(path, entry?.text === text ? { ...entry } : { text });
  }
  return next;
}

/** Hands the planner the settings of every unchanged file, which it reads before reading a file itself. */
export function prefill(loaded: LoadedProject, cache: FileCache): void {
  for (const [path, entry] of cache) if (entry.settings) loaded.settings.set(path, entry.settings);
}
