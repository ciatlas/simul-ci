import { isMap, isScalar, isSeq } from 'yaml';
import type { WorkflowDocument } from '../document';
import { equivalents, isRefusal } from '../guard';
import { insertDraft } from '../insert';
import { removeDraft } from '../remove';
import * as refusals from '../refusal';
import type { Refusal } from '../refusal';
import { setDraft } from '../set';
import { entriesOf, locate } from '../tree';
import type { Json } from '../types';
import type { Draft } from '../verify';
import { chain, type Step } from './chain';
import { sameId } from './ids';
import { danglingReads, jobMissing, readOf, reads } from './fields';
import { ORDER } from './order';
import type { WorkflowOp } from './types';

/**
 * The needs a job writes, by name, read through aliases (`needs: *deps`); an empty `needs:` has none. Undefined when
 * they are not a name or a list of names (an expression).
 */
export function needsOf(doc: WorkflowDocument, job: string): string[] | undefined {
  const value = doc.get(['jobs', job, 'needs'])?.value ?? null;
  if (value === null) return [];
  if (typeof value === 'string') return value.includes('${{') ? undefined : [value];
  if (Array.isArray(value) && value.every((need) => typeof need === 'string')) return value;
  return undefined;
}

/**
 * A job's needs set to a list, diffed against what is written: entries removed and added in place (a scalar becomes
 * a list when a second need is added; an empty list removes the key). Refused when a need is not a job here or would
 * close a loop, for every job whose needs this changes ("Change all" of a shared `needs`). Expressions that still read
 * a need taken out are a warning.
 */
export function setNeeds(
  doc: WorkflowDocument,
  op: Extract<WorkflowOp, { op: 'setNeeds' }>,
  shared?: 'all',
): Draft | Refusal {
  const missing = jobMissing(doc, op.job);
  if (missing) return missing;
  const current = needsOf(doc, op.job);
  if (current === undefined)
    return refusals.unsupported(
      doc.path,
      ['jobs', op.job, 'needs'],
      `the needs of ${op.job} are not a list of job names`,
      doc.lineOf(['jobs', op.job, 'needs']),
    );
  const needs = canonical(doc, op.needs);
  const bad = sharedJobs(doc, op.job, shared).reduce<Refusal | undefined>(
    (found, job) => found ?? needsRefusal(doc, job, needs),
    undefined,
  );
  if (bad) return bad;
  const draft = needsDraft(doc, op.job, current, needs, shared);
  if (isRefusal(draft)) return draft;
  return {
    ...draft,
    label: `Set what ${op.job} needs`,
    select: ['jobs', op.job],
    warnings: lostNeeds(doc, op.job, current, needs),
  };
}

/** The jobs whose needs an edit of one job's needs changes: itself, and under "Change all" the jobs sharing them. */
function sharedJobs(doc: WorkflowDocument, job: string, shared?: 'all'): string[] {
  if (!shared) return [job];
  const paths = equivalents(doc, ['jobs', job, 'needs']);
  return paths.flatMap((p) => (p.length === 3 && p[0] === 'jobs' && p[2] === 'needs' ? [String(p[1])] : []));
}

/** Warnings for the needs taken out that the job's expressions still read (`needs.build.outputs.v`). */
function lostNeeds(doc: WorkflowDocument, job: string, current: readonly string[], needs: readonly string[]) {
  const span = doc.spanOf(['jobs', job]);
  return current
    .filter(
      (need, i) => !needs.some((n) => sameId(n, need)) && current.findIndex((c) => sameId(c, need)) === i,
    )
    .flatMap((need) => {
      const spans = reads(doc, readOf('needs', need), ['jobs', job, 'needs']).filter(
        (s) => span !== undefined && s.from >= span.from && s.to <= span.to,
      );
      return danglingReads(doc, `needs.${need}`, spans);
    });
}

/** The needs named as the jobs are, without repeats. */
export function canonical(doc: WorkflowDocument, needs: readonly string[]): string[] {
  const ids = doc.jobs().map((j) => j.id);
  const out: string[] = [];
  for (const need of needs) {
    const id = ids.find((i) => sameId(i, need)) ?? need;
    if (!out.some((o) => sameId(o, id))) out.push(id);
  }
  return out;
}

/** Why a job may not need these: one is the job itself, is no job here, or already needs the job. */
export function needsRefusal(
  doc: WorkflowDocument,
  job: string,
  needs: readonly string[],
): Refusal | undefined {
  if (needs.some((need) => sameId(need, job))) return refusals.cycle(doc.path, job, job, []);
  const ids = doc.jobs().map((j) => j.id);
  const unknown = needs.find((need) => !ids.some((id) => sameId(id, need)));
  if (unknown !== undefined) return refusals.notFound(doc.path, ['jobs', unknown]);
  for (const need of needs) {
    const path = pathTo(doc, need, job);
    if (path) return refusals.cycle(doc.path, job, need, path.slice(1, -1));
  }
  return undefined;
}

/** A chain of `needs` from one job to another, both included, if there is one. Ids match whatever their case. */
function pathTo(
  doc: WorkflowDocument,
  from: string,
  to: string,
  seen = new Set<string>(),
): string[] | undefined {
  if (sameId(from, to)) return [from];
  seen.add(from.toLowerCase());
  const ids = doc.jobs().map((j) => j.id);
  for (const need of needsOf(doc, from) ?? []) {
    // A need naming the job, even one not added yet (`addJob`), closes the loop.
    if (sameId(need, to)) return [from, to];
    const id = ids.find((i) => sameId(i, need));
    if (id === undefined || seen.has(id.toLowerCase())) continue;
    const rest = pathTo(doc, id, to, seen);
    if (rest) return [from, ...rest];
  }
  return undefined;
}

function needsDraft(
  doc: WorkflowDocument,
  job: string,
  current: readonly string[],
  needs: readonly string[],
  shared?: 'all',
): Draft | Refusal {
  const path = ['jobs', job, 'needs'];
  const options = shared ? { shared } : {};
  // The same needs whatever their case: nothing to write, the author's spelling stays.
  if (sameNeeds(current, needs)) return { edits: [], label: '' };
  if (needs.length === 0) return removeDraft(doc, path, 'remove', options);
  if (isSeq(locate(doc.tree, path)?.node)) return listNeeds(doc, job, current, needs, shared);
  return setDraft(doc, path, newNeeds(doc, current, needs), { order: ORDER.job, ...options });
}

const sameNeeds = (current: readonly string[], needs: readonly string[]): boolean =>
  current.length === needs.length && current.every((need, i) => sameId(need, needs[i]!));

/** A `needs` written anew: in the file's style when there was none, else a scalar for one need, a list for more. */
function newNeeds(doc: WorkflowDocument, current: readonly string[], needs: readonly string[]): Json {
  if (current.length === 0) return needsValue(doc, needs);
  return needs.length === 1 ? needs[0]! : [...needs];
}

/**
 * A list of needs diffed: the first entry of each need that stays keeps its line, the other entries go (repeats
 * included), new ones go at the end; any other change writes the list item by item.
 */
function listNeeds(
  doc: WorkflowDocument,
  job: string,
  current: readonly string[],
  needs: readonly string[],
  shared?: 'all',
): Draft | Refusal {
  const path = ['jobs', job, 'needs'];
  const options = { order: ORDER.job, ...(shared ? { shared } : {}) };
  const kept = current.flatMap((need, i) =>
    needs.some((n) => sameId(n, need)) && current.findIndex((c) => sameId(c, need)) === i ? [i] : [],
  );
  if (kept.length === 0 || !kept.every((at, i) => i < needs.length && sameId(current[at]!, needs[i]!)))
    return setDraft(doc, path, [...needs], options);
  // From the last entry up, so the indexes of the ones above stay.
  const removals: Step[] = current
    .flatMap((_, i) => (kept.includes(i) ? [] : [i]))
    .toReversed()
    .map((i) => (d) => removeDraft(d, [...path, i], 'remove', shared ? { shared } : {}));
  const additions: Step[] = needs
    .slice(kept.length)
    .map((need, i) => (d) => insertDraft(d, path, kept.length + i, need, options));
  return chain(doc, '', [...removals, ...additions]);
}

/** One need out of a job's needs: the first entry naming it, or the key when it is the only one. */
export function removeNeed(
  doc: WorkflowDocument,
  job: string,
  need: string,
  shared?: 'all',
): Draft | Refusal | undefined {
  const needs = needsOf(doc, job);
  const index = needs?.findIndex((n) => sameId(n, need)) ?? -1;
  if (index === -1) return undefined;
  const node = locate(doc.tree, ['jobs', job, 'needs'])?.node;
  const path = isSeq(node) ? ['jobs', job, 'needs', index] : ['jobs', job, 'needs'];
  return removeDraft(doc, path, 'remove', shared ? { shared } : {});
}

/** How many entries of a job's needs name a job. */
export const timesNeeded = (doc: WorkflowDocument, job: string, need: string): number =>
  (needsOf(doc, job) ?? []).filter((n) => sameId(n, need)).length;

/** One need as a scalar when the file writes single needs that way, else a list (flow or block by the file's style). */
export function needsValue(doc: WorkflowDocument, needs: readonly string[]): Json {
  if (needs.length !== 1) return [...needs];
  const jobs = locate(doc.tree, ['jobs'])?.node;
  const single = entriesOf(isMap(jobs) ? jobs : null).map(
    (job) => locate(doc.tree, ['jobs', job.segment, 'needs'])?.node,
  );
  return single.some((n) => isScalar(n)) ? needs[0]! : [...needs];
}
