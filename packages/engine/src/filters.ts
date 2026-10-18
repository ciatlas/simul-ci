/**
 * GitHub's filter patterns for `branches`, `tags`, `paths` and their `-ignore` forms (workflow syntax, "Filter
 * pattern cheat sheet"): `*` matches zero or more characters but not `/`, `**` matches anything, `?` makes the
 * preceding character optional, `+` repeats it, `[…]` is a character class, `\` escapes, and a leading `!` negates.
 * Patterns are evaluated in order: a negative pattern after a positive match excludes, a positive after a negative
 * includes again.
 */

export interface CompiledPattern {
  pattern: string;
  negated: boolean;
  regex: RegExp;
}

export function compilePattern(pattern: string): CompiledPattern {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  let out = '';
  for (let i = 0; i < body.length;) {
    const token = compileToken(body, i, out === '');
    out += token.regex;
    i = token.next;
  }
  return { pattern, negated, regex: new RegExp(`^${out}$`) };
}

interface Token {
  regex: string;
  next: number;
}

/** The regex for the pattern token at `i` and the index after it. */
function compileToken(body: string, i: number, first: boolean): Token {
  const c = body[i]!;
  if (c === '*') return compileStar(body, i);
  // `?` and `+` apply to the preceding character; at the start there is nothing to apply them to.
  if (c === '?' || c === '+') return { regex: first ? `\\${c}` : c, next: i + 1 };
  if (c === '[') return compileClass(body, i);
  if (c === '\\' && i + 1 < body.length) return { regex: escapeRegex(body[i + 1]!), next: i + 2 };
  return { regex: escapeRegex(c), next: i + 1 };
}

/** `*` within a segment, `**` across segments, and a double star before a slash matching zero or more directories. */
function compileStar(body: string, i: number): Token {
  if (body[i + 1] !== '*') return { regex: '[^/]*', next: i + 1 };
  if (body[i + 2] === '/') return { regex: '(?:.*/)?', next: i + 3 };
  return { regex: '.*', next: i + 2 };
}

function compileClass(body: string, i: number): Token {
  const end = body.indexOf(']', i + 1);
  if (end === -1) return { regex: '\\[', next: i + 1 };
  return { regex: `[${body.slice(i + 1, end).replace(/\\/g, '\\\\')}]`, next: end + 1 };
}

const escapeRegex = (c: string): string => (/[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c);

/** Whether `subject` is selected by the ordered pattern list. A list of only negative patterns selects nothing. */
export function matchesPatterns(subject: string, patterns: readonly (string | CompiledPattern)[]): boolean {
  let selected = false;
  for (const p of patterns) {
    const compiled = typeof p === 'string' ? compilePattern(p) : p;
    if (compiled.negated) {
      if (selected && compiled.regex.test(subject)) selected = false;
    } else if (compiled.regex.test(subject)) selected = true;
  }
  return selected;
}

/** The ref name a branch or tag pattern is matched against: `main`, `v1.2.3`, `feature/x`. */
export function refSubject(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

export interface RefFilter {
  /** `branches` or `tags`: the ref must be selected. */
  include?: readonly string[];
  /** `branches-ignore` or `tags-ignore`: the ref must not be selected. */
  ignore?: readonly string[];
}

/** Whether a ref passes a `branches`/`tags` filter pair (GitHub forbids both forms on one event). */
export function refMatches(refName: string, filter: RefFilter): boolean {
  if (filter.include) return matchesPatterns(refName, filter.include);
  if (filter.ignore) return !matchesPatterns(refName, filter.ignore);
  return true;
}

export interface PathFilter {
  /** `paths`: at least one changed file must be selected. */
  paths?: readonly string[];
  /** `paths-ignore`: the workflow runs unless every changed file is selected. */
  pathsIgnore?: readonly string[];
}

/**
 * Whether a change set passes a `paths`/`paths-ignore` filter pair. With no changed files, neither runs: "if there
 * are no files changed, the workflow will not run" (workflow syntax).
 */
export function pathsMatch(changed: readonly string[], filter: PathFilter): boolean {
  if (changed.length === 0 && (filter.paths || filter.pathsIgnore)) return false;
  if (filter.paths) {
    const compiled = filter.paths.map(compilePattern);
    return changed.some((f) => matchesPatterns(f, compiled));
  }
  if (filter.pathsIgnore) {
    const compiled = filter.pathsIgnore.map(compilePattern);
    return !changed.every((f) => matchesPatterns(f, compiled));
  }
  return true;
}
