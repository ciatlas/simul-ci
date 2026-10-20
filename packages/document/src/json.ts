import type { YamlPath } from './types';

/**
 * Edits of a plain-JSON value by path, the second definition of every edit (G4): the check compares the text's new
 * value with the old value edited here. Each mutates its argument and returns the new root.
 */

type Holder = Record<string, unknown> | unknown[];

const isHolder = (v: unknown): v is Holder => typeof v === 'object' && v !== null;

export function getIn(js: unknown, path: YamlPath): unknown {
  let at = js;
  for (const segment of path)
    at = isHolder(at) ? (at as Record<string | number, unknown>)[segment] : undefined;
  return at;
}

/** Sets a value, creating maps for missing or null parents on the way. */
export function setIn(js: unknown, path: YamlPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const root = isHolder(js) ? js : {};
  let at: Holder = root;
  for (const segment of path.slice(0, -1)) {
    const next = (at as Record<string | number, unknown>)[segment];
    at = isHolder(next) ? next : ((at as Record<string | number, unknown>)[segment] = {});
  }
  (at as Record<string | number, unknown>)[path.at(-1)!] = value;
  return root;
}

/**
 * Removes an entry. A collection left empty becomes null (`emptied: 'null'`), or goes with its own key
 * (`'remove'`), whose collection is then left null if that empties it.
 */
export function deleteIn(js: unknown, path: YamlPath, emptied: 'null' | 'remove' = 'null'): unknown {
  const container = path.slice(0, -1);
  const holder = getIn(js, container);
  if (!isHolder(holder)) return js;
  const key = path.at(-1)!;
  if (Array.isArray(holder)) holder.splice(Number(key), 1);
  else delete holder[String(key)];
  const empty = Array.isArray(holder) ? holder.length === 0 : Object.keys(holder).length === 0;
  if (!empty) return js;
  if (emptied === 'remove' && container.length > 0) return deleteIn(js, container, 'null');
  return setIn(js, container, null);
}

/** Inserts into a list, creating it when it is missing or null. */
export function insertIn(js: unknown, path: YamlPath, index: number, value: unknown): unknown {
  const list = getIn(js, path);
  if (Array.isArray(list)) {
    list.splice(index, 0, value);
    return js;
  }
  return setIn(js, path, [value]);
}

export function moveIn(js: unknown, path: YamlPath, from: number, to: number): unknown {
  const list = getIn(js, path) as unknown[];
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return js;
}

/** Renames a map key in place: the other keys keep their order. */
export function renameIn(js: unknown, path: YamlPath, key: string): unknown {
  const map = getIn(js, path.slice(0, -1)) as Record<string, unknown>;
  const old = String(path.at(-1));
  const entries = Object.entries(map).map(([k, v]): [string, unknown] => [k === old ? key : k, v]);
  for (const k of Object.keys(map)) delete map[k];
  Object.assign(map, Object.fromEntries(entries));
  return js;
}
