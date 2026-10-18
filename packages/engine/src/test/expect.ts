import { stringOf } from '../evaluate';
import type { Json, Result, Tri, Value } from '../plan/types';
import type { ExpectValue } from './schema';

/**
 * How a test's expectation meets a plan value: exact and case-sensitive in GitHub's string form; a list accepts
 * any member, and an unknown with candidates passes a list only when every candidate is in it; `{ match }` is a
 * regular expression over a known value; `{ unknown: true }` asks that the plan still not know.
 */

export interface Check {
  ok: boolean;
  /** `is 'x'`, `is one of 'a', 'b' (ids)`, `is unknown (ids)`; what the failure headline ends with. */
  actual: string;
}

export function checkValue(expect: ExpectValue, value: Value<Json>, missing = false): Check {
  const actual = describe(value, missing);
  if (typeof expect === 'object' && !Array.isArray(expect)) {
    if ('unknown' in expect) return { ok: !value.known, actual };
    if (!value.known) return { ok: false, actual };
    return { ok: regexOf(expect.match).test(stringOf(value.value)), actual };
  }
  const wanted = new Set((Array.isArray(expect) ? expect : [expect]).map((e) => stringOf(e as Json)));
  if (value.known) return { ok: wanted.has(stringOf(value.value)), actual };
  if (!Array.isArray(expect) || !value.oneOf) return { ok: false, actual };
  return { ok: value.oneOf.every((c) => wanted.has(stringOf(c))), actual };
}

/** The regular expression of a `{ match }`; the schema accepted the text, so a bad one is a plain error here. */
export function regexOf(text: string): RegExp {
  return new RegExp(text);
}

function describe(value: Value<Json>, missing: boolean): string {
  if (value.known) {
    const by = value.by === undefined ? '' : ` (by ${value.by})`;
    return missing ? `is '' (not set)` : `is '${stringOf(value.value)}'${by}`;
  }
  const ids = value.unknowns.join(', ');
  if (value.oneOf) return `is one of ${value.oneOf.map((c) => `'${stringOf(c)}'`).join(', ')} (${ids})`;
  return `is unknown (${ids})`;
}

/** Whether a verdict meets the expected one; `allowMaybe` accepts a maybe where yes or no was expected. */
export function checkTri(want: Tri, got: Tri, allowMaybe: boolean): boolean {
  return got === want || (allowMaybe && got === 'maybe' && want !== 'maybe');
}

/** A result as a plan value, for the value checks. */
export const resultValue = (v: Value<Result>): Value<Json> => v;
