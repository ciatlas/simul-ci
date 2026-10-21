import { type Json, sameId, type WorkflowDocument } from '@simulci/document';

/**
 * What a job needs, read from the document of the text now (not from the plan, which lags the pane's typing): the
 * checkboxes in Properties, What it needs, and whether a drag between two cards may connect them.
 */

/** `needs: build` or `needs: [a, b]` as a list, none written as `[]`; undefined for anything else (an expression). */
export function listOf(value: Json | undefined): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.includes('${{') ? undefined : [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;
  return undefined;
}

/** A job's needs by name, through aliases; undefined when they are not names. */
export const needsOf = (doc: WorkflowDocument, job: string): string[] | undefined =>
  listOf(doc.get(['jobs', job, 'needs'])?.value);

/** Whether `job` needs `target`, directly or through the jobs it needs, whatever the ids' case. */
export function needsTransitively(
  doc: WorkflowDocument,
  job: string,
  target: string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(job.toLowerCase())) return false;
  seen.add(job.toLowerCase());
  const ids = doc.jobs().map((j) => j.id);
  return (needsOf(doc, job) ?? []).some((need) => {
    if (sameId(need, target)) return true;
    const id = ids.find((i) => sameId(i, need));
    return id !== undefined && needsTransitively(doc, id, target, seen);
  });
}

/** The jobs whose needs name a job. */
export const dependentsOf = (doc: WorkflowDocument, job: string): string[] =>
  doc
    .jobs()
    .map((j) => j.id)
    .filter((id) => !sameId(id, job) && (needsOf(doc, id) ?? []).some((n) => sameId(n, job)));

/**
 * The jobs a job may come to need: every other job but those it needs already and those that need it, directly or
 * not, which would close a loop.
 */
export function needCandidates(doc: WorkflowDocument, job: string): string[] {
  const current = needsOf(doc, job) ?? [];
  return doc
    .jobs()
    .map((j) => j.id)
    .filter(
      (id) => !sameId(id, job) && !current.some((n) => sameId(n, id)) && !needsTransitively(doc, id, job),
    );
}
