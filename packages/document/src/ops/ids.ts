import type { WorkflowDocument } from '../document';
import { refuse, type Refusal } from '../refusal';
import type { WorkflowOp } from './types';

/** The ids the UI writes for jobs, steps, inputs, outputs and matrix keys: the engine's unit-path `ID`. */
export const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Ids compare whatever their case, as core matches `needs` and step ids. */
export const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A free id from a base: `job`, then `job-2`, `job-3`; `_` instead of `-` when the file's ids use `_` and not `-`.
 */
export function freeId(base: string, taken: readonly string[]): string {
  const underscore = taken.some((id) => id.includes('_')) && !taken.some((id) => id.includes('-'));
  const stem = ID.test(base) ? base : 'job';
  if (!taken.some((id) => sameId(id, stem))) return stem;
  for (let n = 2; ; n++) {
    const id = `${stem}${underscore ? '_' : '-'}${n}`;
    if (!taken.some((t) => sameId(t, id))) return id;
  }
}

/**
 * A step id suggested from what the step runs: its action's name (`setup-node`), else its name's slug (`build-it`,
 * `cafe`, `step-2nd-pass`). Undefined when neither gives one.
 */
export function stepIdFor(step: { uses?: string; name?: string }): string | undefined {
  const action = step.uses?.includes('${{')
    ? undefined
    : step.uses?.split('@')[0]?.split('/').findLast(Boolean);
  return [action, step.name].map(slug).find((s) => s !== '');
}

function slug(text: string | undefined): string {
  const words = (text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^\d/.test(words) ? `step-${words}` : words;
}

/** What an id names, as a sentence starts with it. */
const NAMES = {
  job: 'Job ids',
  step: 'Step ids',
  output: 'Output ids',
  input: 'Input names',
  dimension: 'Matrix keys',
} as const;

/** Refuses an id that is not one, or one a sibling has whatever its case, offering a free one. */
export function checkId(
  doc: WorkflowDocument,
  kind: keyof typeof NAMES,
  id: string,
  taken: readonly string[],
  retry: (id: string) => WorkflowOp,
): Refusal | undefined {
  const free = freeId(
    ID.test(id) ? id : id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z_]+/, '') || kind,
    taken,
  );
  const fix = { kind: 'ops' as const, label: `Use ${free}`, ops: [retry(free)], retry: false };
  if (!ID.test(id))
    return refuse(
      'invalid-id',
      doc.path,
      `${NAMES[kind]} start with a letter or \`_\`, then letters, digits, \`-\` or \`_\`: \`${id}\` is not one.`,
      { fixes: [fix] },
    );
  const same = taken.find((t) => sameId(t, id));
  if (same !== undefined)
    return refuse('duplicate-id', doc.path, `A ${kind} \`${same}\` already exists; ids ignore case.`, {
      fixes: [fix],
    });
  return undefined;
}
