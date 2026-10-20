import { applyEdits, touched, type TextEdit } from './edits';

/**
 * Two edit lists as one: `second` is in the text `first` produces, the result in the text `first` applies to, and
 * applying it gives what applying both in turn gives. Each changed region of the end text becomes one edit, so a
 * step that rewrites what an earlier step wrote leaves no trace of the earlier text.
 */
export function composeEdits(
  text: string,
  first: readonly TextEdit[],
  second: readonly TextEdit[],
): TextEdit[] {
  const { text: middle, inverse } = applyEdits(text, first);
  const end = applyEdits(middle, second).text;
  const regions = merge([...touched(first), ...second.map(({ from, to }) => ({ from, to }))]);
  return regions.map(({ from, to }) => ({
    from: shift(inverse, from, -1),
    to: shift(inverse, to, 1),
    insert: end.slice(shift(second, from, -1), shift(second, to, 1)),
  }));
}

/** Ranges sorted and merged where they overlap or touch. */
function merge(list: readonly { from: number; to: number }[]): { from: number; to: number }[] {
  const sorted = [...list].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: { from: number; to: number }[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else out.push({ ...range });
  }
  return out;
}

/**
 * Where a region's boundary lands after edits that are all inside the region or apart from it: a start counts the
 * edits wholly before it, an end those that start at or before it.
 */
function shift(edits: readonly TextEdit[], at: number, side: -1 | 1): number {
  let delta = 0;
  for (const { from, to, insert } of edits) {
    if (side < 0 ? to >= at : from > at) break;
    delta += insert.length - (to - from);
  }
  return at + delta;
}
