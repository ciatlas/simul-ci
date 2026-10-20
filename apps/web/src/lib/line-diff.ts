/**
 * A line diff (synthesis § 5.2): Myers' O(ND) algorithm in its linear-space form, which bisects the problem at the
 * middle snake of an optimal path, so the edit script is a shortest one and no trace of every round is kept. The
 * Changes dialog, the restore rows and the patch read it.
 */

/** A text's lines, each with its line break (a CRLF's `\r` kept before its `\n`); the last has none if the text ends without one. */
export function linesOf(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Where two lists of lines differ: `a[aFrom, aTo)` gave way to `b[bFrom, bTo)`. Changes come in order and never touch. */
export interface LineChange {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

/** The changes that turn `a` into `b`, as few lines as possible removed and added. */
export function diffLines(a: readonly string[], b: readonly string[]): LineChange[] {
  // Lines become numbers, so the search compares integers.
  const ids = new Map<string, number>();
  const idOf = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) ids.set(line, (id = ids.size));
    return id;
  };
  const x = Int32Array.from(a, idOf);
  const y = Int32Array.from(b, idOf);
  const out: LineChange[] = [];
  compare(x, y, { aFrom: 0, aTo: x.length, bFrom: 0, bTo: y.length }, out);
  return joined(out);
}

/** Diffs one box of the two lists into `out`: its common ends taken off, then split at a point an optimal path crosses. */
function compare(x: Int32Array, y: Int32Array, box: LineChange, out: LineChange[]): void {
  const inner = trimmed(x, y, box);
  const split = inner.aFrom === inner.aTo || inner.bFrom === inner.bTo ? undefined : middle(x, y, inner);
  if (split === undefined) {
    if (inner.aFrom < inner.aTo || inner.bFrom < inner.bTo) out.push(inner);
    return;
  }
  compare(x, y, { ...inner, aTo: split[0], bTo: split[1] }, out);
  compare(x, y, { ...inner, aFrom: split[0], bFrom: split[1] }, out);
}

/** The box without the lines its two sides start and end with alike. */
function trimmed(x: Int32Array, y: Int32Array, box: LineChange): LineChange {
  let { aFrom, aTo, bFrom, bTo } = box;
  while (aFrom < aTo && bFrom < bTo && x[aFrom] === y[bFrom]) {
    aFrom++;
    bFrom++;
  }
  while (aFrom < aTo && bFrom < bTo && x[aTo - 1] === y[bTo - 1]) {
    aTo--;
    bTo--;
  }
  return { aFrom, aTo, bFrom, bTo };
}

/**
 * The two searches of one box (Myers 1986, § 4b): per diagonal k = i - j, at index k + `max`, how far along `a` the
 * furthest path of the last round reached, -1 for none. The backward search counts from the box's end, so its
 * diagonal `delta - k` is the forward one's k.
 */
interface Search {
  n: number;
  delta: number;
  odd: boolean;
  max: number;
  forward: Int32Array;
  backward: Int32Array;
  ahead: (i: number, j: number) => boolean;
  behind: (i: number, j: number) => boolean;
}

/**
 * Where the forward search from the box's start meets the backward one from its end: a point on a shortest path,
 * strictly inside the box since its ends differ. None when the two lists share no line at all.
 */
function middle(x: Int32Array, y: Int32Array, box: LineChange): [number, number] | undefined {
  const n = box.aTo - box.aFrom;
  const m = box.bTo - box.bFrom;
  const max = Math.ceil((n + m) / 2);
  const search: Search = {
    n,
    delta: n - m,
    odd: ((n - m) & 1) === 1,
    max,
    forward: new Int32Array(2 * max + 2).fill(-1),
    backward: new Int32Array(2 * max + 2).fill(-1),
    ahead: (i, j) => x[box.aFrom + i] === y[box.bFrom + j],
    behind: (i, j) => x[box.aTo - 1 - i] === y[box.bTo - 1 - j],
  };
  search.forward[max + 1] = 0;
  search.backward[max + 1] = 0;
  for (let d = 0; d < max; d++) {
    const met = round(search, d, m, true) ?? round(search, d, m, false);
    if (met) return [box.aFrom + met[0], box.bFrom + met[1]];
  }
  return undefined;
}

/**
 * One round of one search, over diagonals -d to d, each path one edit longer. An odd delta meets in the forward
 * round, an even one in the backward round: the first point found where the paths overlap, in forward offsets.
 */
function round(s: Search, d: number, m: number, forward: boolean): [number, number] | undefined {
  const v = forward ? s.forward : s.backward;
  const same = forward ? s.ahead : s.behind;
  for (let k = -d; k <= d; k += 2) {
    const i = furthest(v, s.max + k, k, s.n, m, same);
    const met = forward === s.odd && i >= 0 ? overlap(s, d, k, i, forward) : undefined;
    if (met) return met;
  }
  return undefined;
}

/**
 * Whether the path that reached `i` on diagonal k overlaps the other search's on the same diagonal: the forward
 * round checks the backward paths of the round before, the backward round the forward paths of this one.
 */
function overlap(s: Search, d: number, k: number, i: number, forward: boolean): [number, number] | undefined {
  const other = s.delta - k;
  if (Math.abs(other) > (forward ? d - 1 : d)) return undefined;
  const reach = (forward ? s.backward : s.forward)[s.max + other]!;
  if (reach < 0 || i + reach < s.n) return undefined;
  return forward ? [i, i - k] : [reach, reach - other];
}

/**
 * The furthest a path of one more edit reaches on diagonal k (at index `at`), its snake followed: a step down from
 * diagonal k + 1 or right from k - 1, whichever goes further without leaving the box. Recorded, and -1 when neither
 * can be taken.
 */
function furthest(
  v: Int32Array,
  at: number,
  k: number,
  n: number,
  m: number,
  same: (i: number, j: number) => boolean,
): number {
  const above = v[at + 1]!;
  const left = v[at - 1]!;
  const down = above >= 0 && above - k <= m ? above : -1;
  const right = left >= 0 && left + 1 <= n ? left + 1 : -1;
  let i = Math.max(down, right);
  if (i >= 0) while (i < n && i - k < m && same(i, i - k)) i++;
  v[at] = i;
  return i;
}

/** Changes that touch, joined: the bisection can end one where the next begins. */
function joined(changes: LineChange[]): LineChange[] {
  const out: LineChange[] = [];
  for (const c of changes) {
    const last = out.at(-1);
    if (last && last.aTo === c.aFrom && last.bTo === c.bFrom)
      out[out.length - 1] = { ...last, aTo: c.aTo, bTo: c.bTo };
    else out.push(c);
  }
  return out;
}

/** A line of a hunk: kept as context, removed, or added; its text with its line break. */
export interface HunkLine {
  kind: ' ' | '-' | '+';
  text: string;
}

/** A unified diff's hunk: `aCount` lines of `a` from index `aStart` against `bCount` of `b` from `bStart`. */
export interface Hunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  lines: HunkLine[];
}

/** The changes as unified hunks, each with up to `context` lines on either side; changes whose context meets share one. */
export function hunksOf(
  a: readonly string[],
  b: readonly string[],
  changes: readonly LineChange[],
  context = 3,
): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < changes.length) {
    let j = i;
    while (j + 1 < changes.length && changes[j + 1]!.aFrom - changes[j]!.aTo <= 2 * context) j++;
    hunks.push(hunkOf(a, b, changes.slice(i, j + 1), context));
    i = j + 1;
  }
  return hunks;
}

function hunkOf(
  a: readonly string[],
  b: readonly string[],
  group: readonly LineChange[],
  context: number,
): Hunk {
  const first = group[0]!;
  const last = group.at(-1)!;
  const aStart = Math.max(0, first.aFrom - context);
  const aEnd = Math.min(a.length, last.aTo + context);
  const bStart = first.bFrom - (first.aFrom - aStart);
  const lines: HunkLine[] = [];
  const add = (kind: HunkLine['kind'], from: readonly string[], start: number, end: number): void => {
    for (let n = start; n < end; n++) lines.push({ kind, text: from[n]! });
  };
  let at = aStart;
  for (const c of group) {
    add(' ', a, at, c.aFrom);
    add('-', a, c.aFrom, c.aTo);
    add('+', b, c.bFrom, c.bTo);
    at = c.aTo;
  }
  add(' ', a, at, aEnd);
  return { aStart, aCount: aEnd - aStart, bStart, bCount: aEnd - aStart + countOf(group), lines };
}

/** Lines added less lines removed. */
const countOf = (group: readonly LineChange[]): number =>
  group.reduce((sum, c) => sum + (c.bTo - c.bFrom) - (c.aTo - c.aFrom), 0);

/** A hunk's `@@ -2,4 +2,5 @@` line as git writes it. */
export const hunkHeader = (h: Hunk): string =>
  `@@ -${range(h.aStart, h.aCount)} +${range(h.bStart, h.bCount)} @@`;

/** A side of a hunk: its first line counted from 1, the count left out when 1; an empty side names the line before. */
const range = (start: number, count: number): string =>
  count === 0 ? `${start},0` : count === 1 ? `${start + 1}` : `${start + 1},${count}`;

/** How many lines the changes add and remove. */
export function statsOf(changes: readonly LineChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    added += c.bTo - c.bFrom;
    removed += c.aTo - c.aFrom;
  }
  return { added, removed };
}
