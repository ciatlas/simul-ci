import type { Eol, Json, YamlPath } from '@simulci/document';

/**
 * The primitives' meaning, defined a second time over plain JSON and written apart from `src/json.ts`: the
 * differential check compares what the text reads as after an edit with this (G4, § 2.9 item 3).
 */
export type PrimitiveOp =
  | { kind: 'set'; path: YamlPath; value: Json; order?: readonly string[] }
  | { kind: 'remove'; path: YamlPath; emptied: 'null' | 'remove' }
  | { kind: 'insert'; path: YamlPath; index: number; value: Json }
  | { kind: 'move'; path: YamlPath; from: number; to: number }
  | { kind: 'rename'; path: YamlPath; key: string }
  | { kind: 'dealias'; path: YamlPath }
  | { kind: 'dealiasAnchor'; name: string }
  | { kind: 'convertEol'; eol: Eol };

const GONE = Symbol('gone');
type Update = (old: unknown) => unknown;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A copy of `v` with `fn` applied at `path`; `GONE` removes the entry. Missing or null maps on the way are created. */
function update(v: unknown, path: YamlPath, fn: Update): unknown {
  if (path.length === 0) return fn(v);
  const [head, ...rest] = path;
  if (Array.isArray(v) && typeof head === 'number') {
    const next = update(v[head], rest, fn);
    return next === GONE ? v.toSpliced(head, 1) : v.with(head, next);
  }
  const copy: Record<string, unknown> = isObject(v) ? { ...v } : {};
  const next = update(copy[String(head)], rest, fn);
  if (next === GONE) delete copy[String(head)];
  else copy[String(head)] = next;
  return copy;
}

function read(v: unknown, path: YamlPath): unknown {
  return path.reduce<unknown>((at, k) => (at as Record<string | number, unknown> | null)?.[k as never], v);
}

const isEmpty = (v: unknown) =>
  Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0;

function removed(js: unknown, path: YamlPath, emptied: 'null' | 'remove'): unknown {
  const next = update(js, path, () => GONE);
  const container = path.slice(0, -1);
  if (!isEmpty(read(next, container))) return next;
  if (emptied === 'remove' && container.length > 0) return removed(next, container, 'null');
  return update(next, container, () => null);
}

export function expected(js: unknown, op: PrimitiveOp): unknown {
  switch (op.kind) {
    case 'set':
      return update(js, op.path, () => op.value);
    case 'remove':
      return removed(js, op.path, op.emptied);
    case 'insert':
      return update(js, op.path, (old) =>
        Array.isArray(old) ? old.toSpliced(op.index, 0, op.value) : [op.value],
      );
    case 'move':
      return update(js, op.path, (old) => {
        const list = [...(old as unknown[])];
        const [item] = list.splice(op.from, 1);
        return list.toSpliced(op.to, 0, item);
      });
    case 'rename':
      return update(js, op.path.slice(0, -1), (old) =>
        Object.fromEntries(
          Object.entries(old as Record<string, unknown>).map(([k, v]) => [
            k === op.path.at(-1) ? op.key : k,
            v,
          ]),
        ),
      );
    default:
      return js;
  }
}

/** Plain-JSON equality: maps whatever their key order, sequences in order. */
export function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
    );
  }
  return Object.is(a, b);
}
