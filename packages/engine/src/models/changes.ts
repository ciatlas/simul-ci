import picomatch from 'picomatch/posix';
import type { ChangedFile, ChangeStatus, Scenario } from '../scenario';

/** Matching over the scenario's changed files, each the way its action does it. */

/**
 * micromatch over one list, as `tj-actions/changed-files` calls it (`dot`, `noext`): a path matches when some
 * positive pattern matches it and no negated one does; a list without positives means every path.
 */
export function matcher(patterns: readonly string[]): (path: string) => boolean {
  const options = { dot: true, noext: true };
  const positive = patterns.filter((p) => !p.startsWith('!'));
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  if (positive.length === 0 && negative.length === 0) return () => false;
  const isPositive = positive.length ? picomatch(positive, options) : () => true;
  const isNegative = negative.length ? picomatch(negative, options) : () => false;
  return (path) => isPositive(path) && !isNegative(path);
}

/**
 * picomatch per pattern with `some`, as `dorny/paths-filter` does it (`dot`): a path matches when any one pattern
 * does, and a negated pattern matches every path the rest of it does not, so `!` in a list adds, it never excludes.
 */
export function anyMatcher(patterns: readonly string[]): (path: string) => boolean {
  const matchers = patterns.map((p) => picomatch(p, { dot: true }));
  return (path) => matchers.some((m) => m(path));
}

/** The changed files, or undefined when the scenario does not say. */
export const changedFiles = (scenario: Scenario): ChangedFile[] | undefined => scenario.changed;

/** `tj-actions/changed-files` vocabulary: changed = ACMR, modified = ACMRD. */
export const CHANGED: readonly ChangeStatus[] = ['added', 'modified', 'renamed'];
export const MODIFIED: readonly ChangeStatus[] = ['added', 'modified', 'renamed', 'removed'];
