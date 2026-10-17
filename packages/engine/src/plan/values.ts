import type { UnknownId, Value } from './types';

/** A known value. */
export const known = <T>(value: T, by?: string): Value<T> =>
  by === undefined ? { known: true, value } : { known: true, value, by };

/** An unknown value, with the unknowns it depends on and, when finite, its candidates. */
export function unknown<T>(unknowns: readonly UnknownId[], oneOf?: readonly T[]): Value<T> {
  const out: Value<T> = { known: false, unknowns: [...new Set(unknowns)] };
  if (oneOf !== undefined) out.oneOf = [...new Set(oneOf)];
  return out;
}

/** The candidates of a value: its value, its `oneOf`, or nothing when it is open. */
export function candidates<T>(v: Value<T>): readonly T[] | undefined {
  return v.known ? [v.value] : v.oneOf;
}

const MAX_COMBINATIONS = 256;

/**
 * Applies `f` to known inputs, and over every combination of candidates when some are unknown but finite: the result
 * is known when every combination agrees, else unknown with the results as candidates. Open inputs give an open result.
 */
export function combine<T, R>(inputs: readonly Value<T>[], f: (values: T[]) => R): Value<R> {
  const unknowns = inputs.flatMap((v) => (v.known ? [] : v.unknowns));
  const lists = inputs.map(candidates);
  if (lists.some((l) => l === undefined)) return unknown(unknowns);
  const total = lists.reduce((n, l) => n * l!.length, 1);
  if (total > MAX_COMBINATIONS) return unknown(unknowns);
  const results: R[] = [];
  for (const values of product(lists as readonly (readonly T[])[])) {
    const r = f(values);
    if (!results.some((seen) => Object.is(seen, r))) results.push(r);
  }
  if (results.length === 1 && unknowns.length === 0) return known(results[0]!);
  if (results.length === 1) return known(results[0]!);
  return unknown(unknowns, results);
}

function* product<T>(lists: readonly (readonly T[])[]): Generator<T[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [first, ...rest] = lists;
  for (const value of first!) for (const tail of product(rest)) yield [value, ...tail];
}
