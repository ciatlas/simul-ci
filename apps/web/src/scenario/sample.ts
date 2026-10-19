/**
 * A name a filter pattern selects, for the chips that fill a field from the filters: `release/**` gives
 * `release/x`, `v*` gives `v1.0.0`, `src/**` gives `src/example.ts`. The walk follows the engine's compiler
 * (packages/engine/src/filters.ts) token by token, so every sample matches its own pattern; a test holds it to the
 * engine's matcher. The page cannot import the engine, so the walk is its own.
 */

export type SampleKind = 'branch' | 'tag' | 'path';

/**
 * A name the pattern selects; nothing for a negated pattern, which selects nothing on its own, or for a class no
 * character fits.
 */
export function sampleOf(pattern: string, kind: SampleKind): string | undefined {
  if (pattern.startsWith('!')) return undefined;
  let out = '';
  for (let i = 0; i < pattern.length;) {
    const token = sampleToken(pattern, i, out, kind);
    if (token.text === undefined) return undefined;
    out += token.text;
    i = token.next;
  }
  return out;
}

interface Token {
  text: string | undefined;
  next: number;
}

function sampleToken(pattern: string, i: number, before: string, kind: SampleKind): Token {
  const c = pattern[i]!;
  if (c === '*') return sampleStar(pattern, i, before, kind);
  // `?` and `+` act on the character before, which the sample already holds once; first, they are themselves.
  if (c === '?' || c === '+') return { text: i === 0 ? c : '', next: i + 1 };
  if (c === '[') return sampleClass(pattern, i);
  if (c === '\\' && i + 1 < pattern.length) return { text: pattern[i + 1]!, next: i + 2 };
  return { text: c, next: i + 1 };
}

/** `*` and `**` become a word of the kind; a double star before a slash stands for no directory at all. */
function sampleStar(pattern: string, i: number, before: string, kind: SampleKind): Token {
  if (pattern[i + 1] !== '*') return { text: wordOf(kind, before, i + 1 === pattern.length), next: i + 1 };
  if (pattern[i + 2] === '/') return { text: '', next: i + 3 };
  return { text: wordOf(kind, before, i + 2 === pattern.length), next: i + 2 };
}

/** What a star stands for: never a slash, so it fits `*` as well as `**`. */
function wordOf(kind: SampleKind, before: string, last: boolean): string {
  if (kind === 'branch') return 'x';
  if (kind === 'path') return last ? (before.endsWith('.') ? 'ts' : 'example.ts') : 'example';
  if (!last) return '1';
  // A version after a letter (`v*`), one more number after a digit or a dot (`v1.*`).
  return /[0-9.]$/.test(before) ? '0' : '1.0.0';
}

const CANDIDATES = ['x', 'a', '0', '1', '_', '-', '.'];

/** A character of the class, as the engine compiles it: its first member, or the first candidate it takes. */
function sampleClass(pattern: string, i: number): Token {
  const end = pattern.indexOf(']', i + 1);
  if (end === -1) return { text: '[', next: i + 1 };
  return { text: classMember(pattern.slice(i + 1, end)), next: end + 1 };
}

function classMember(body: string): string | undefined {
  let regex: RegExp;
  try {
    regex = new RegExp(`^[${body.replace(/\\/g, '\\\\')}]$`);
  } catch {
    // The engine cannot compile it either (a range out of order): no name to offer.
    return undefined;
  }
  const first = body[0] === undefined || body[0] === '^' ? [] : [body[0]];
  return [...first, ...CANDIDATES].find((c) => regex.test(c));
}
