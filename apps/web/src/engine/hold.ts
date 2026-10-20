import type { Held } from '../state/store';
import type { Outline, OutlineFile } from '../worker/protocol';

/**
 * The hold (synthesis § 7.2): an edit that breaks the YAML of a file that parsed keeps the plan of the last good
 * texts on screen, rather than the near-empty plan a half-typed key gives. Only YAML errors hold: a converter's error
 * (an unknown event) still plans every job, and the author should see it.
 */

const brokenYaml = (file: OutlineFile | undefined): boolean =>
  file?.errors.some((e) => e.source === 'yaml') ?? false;

/** Per file with YAML errors in `next` and none in the Outline shown, its first YAML error's line. */
export function newlyBroken(shown: Outline | undefined, next: Outline): Held['broken'] {
  const before = new Map(shown?.files.map((f) => [f.path, f]));
  return next.files
    .filter((f) => brokenYaml(f) && !brokenYaml(before.get(f.path)))
    .map((f) => ({ path: f.path, line: f.errors.find((e) => e.source === 'yaml')!.line }));
}

/** What the status line says while held, and why Copy as test case waits. */
export function heldSentence(held: Held): string {
  const [first, ...rest] = held.broken;
  if (!first) return 'the plan waits for valid YAML';
  const more = rest.length ? ` and ${rest.length} more ${rest.length === 1 ? 'file' : 'files'}` : '';
  return `the plan waits for valid YAML: ${first.path.slice(first.path.lastIndexOf('/') + 1)} line ${first.line}${more}`;
}
