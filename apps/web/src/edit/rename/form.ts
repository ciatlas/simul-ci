import { freeId, ID, sameId, stepIdFor, type WorkflowDocument } from '@simulci/document';
import { fileLabel } from '../../lib/file-label';
import { listed } from '../../lib/words';
import { oldId, type Preview, type RenameTarget } from './run';

/**
 * What the rename popover says (synthesis § 4.2): why a typed id cannot be one, the id offered for a step that has
 * none, and the sentence over the lines a rename changes.
 */

/** The ids a new one must differ from, whatever their case: the file's other jobs, or the job's other step ids. */
export function takenIds(doc: WorkflowDocument | undefined, target: RenameTarget): string[] {
  const jobs = doc?.jobs() ?? [];
  if (!target.step) return jobs.flatMap((j) => (j.id === target.job ? [] : [j.id]));
  const steps = jobs.find((j) => j.id === target.job)?.steps ?? [];
  return steps.flatMap((s, i) => (i === target.step!.index || s.id === undefined ? [] : [s.id]));
}

/** Why an id cannot be the new one: the engine's id rule, or another job (or step of the job) has it. */
export function renameProblem(
  target: RenameTarget,
  id: string,
  taken: readonly string[],
): string | undefined {
  const what = target.step ? 'Step' : 'Job';
  if (!ID.test(id)) return `${what} ids start with a letter or _, then letters, digits, - or _.`;
  const same = taken.find((t) => sameId(t, id));
  if (same === undefined) return undefined;
  return target.step
    ? `Step ${same} of ${target.job} already has it; ids ignore case.`
    : `A job ${same} already exists; ids ignore case.`;
}

/** The id the popover starts from: the one there is, else one from the step's action or name, free in its job. */
export function startingId(target: RenameTarget, taken: readonly string[]): string {
  const old = oldId(target);
  if (old !== undefined) return old;
  const base = target.step ? stepIdFor(target.step.fp) : undefined;
  return freeId(base !== undefined && ID.test(base) ? base : 'step', taken);
}

/** "53 places on 52 lines of release.yml: the key, 10 needs entries and 42 expression reads." */
export function summaryOf(target: RenameTarget, preview: Extract<Preview, { ok: true }>): string {
  const { places, lines, roles } = preview;
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const parts = [
    target.step ? 'the id' : 'the key',
    ...(roles.needs > 0 ? [count(roles.needs, 'needs entry', 'needs entries')] : []),
    ...(roles.read > 0 ? [count(roles.read, 'expression read', 'expression reads')] : []),
  ];
  const where = `${count(places, 'place', 'places')} on ${count(lines.length, 'line', 'lines')} of ${fileLabel(target.file)}`;
  return `${where}: ${listed(parts)}.`;
}
