/* oxlint-disable no-restricted-imports -- the worker is where the engine runs */
import { type LoadedProject, type Reference, type ReferenceTarget, referencesOf } from '@simulci/engine';
import type { RefsResponse } from './protocol';

/**
 * The worker's answer to `refs` (synthesis § 3.3, § 8.3): the engine's `referencesOf`, and the reads of the target
 * that no rename can follow, which it leaves out. A read through a computed index (`needs[matrix.job]`) or of the
 * whole context (`toJSON(needs)`), in a job that can see the target, names it only at run time; an id spelled with an
 * escape (`needs.\x62uild`) has no span a splice could keep. Each is said in a note, so the author knows what stays.
 */

/** Where a read is written, 1-based, as core's `Loc`. */
interface Span {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/** A read in an expression, as core's IR has it: its context, its path, and where it is written. */
interface Read {
  context: string;
  path: string[];
  dynamic: boolean;
  start: number;
  end: number;
  loc: Span;
}

/** A YAML scalar holding expressions, as core's IR has it. */
interface Site {
  job?: string;
  field: string;
  segments: { expr: { source: string; error?: { message: string } }; loc: Span; refs: Read[] }[];
}

interface Workflow {
  sites: Site[];
  jobs: Record<string, { id: string; needs: { id: string }[] }>;
  source: { text: string };
}

export function refsOf(
  loaded: LoadedProject,
  target: ReferenceTarget,
): Omit<RefsResponse, 'id' | 'type' | 'project'> {
  const wf: Workflow | undefined = loaded.index.project.workflows.get(target.workflow);
  const refs = afterBom(referencesOf(loaded, target), wf);
  if (!wf || refs.length === 0) return { refs, exact: true, notes: [] };
  const id = refs.find((r) => r.role === 'key')?.text ?? (target.kind === 'job' ? target.job : target.step);
  const sees = target.kind === 'job' ? jobReader(wf, id) : stepReader(target.job);
  const notes = wf.sites.flatMap((site) =>
    site.segments.flatMap(({ expr, loc, refs: reads }) =>
      expr.error
        ? unread(site, expr, loc, target, id, sees)
        : reads.flatMap((read) => {
            if (!sees(site, read)) return [];
            const text = expr.source.slice(read.start, read.end);
            if (read.dynamic)
              return [
                `\`${text}\` (line ${read.loc.line}) reads ${whatOf(target)} it computes; it is not renamed.`,
              ];
            if (!same(read.path[0], id) || refs.some((r) => inside(r, read.loc))) return [];
            return [`Line ${read.loc.line} spells ${id} with an escape; that read is not renamed.`];
          }),
    ),
  );
  return { refs, exact: notes.length === 0, notes };
}

const same = (a: string | undefined, b: string): boolean => a?.toLowerCase() === b.toLowerCase();

/**
 * An expression that does not parse holds no reads core can place, so a read of the target in it keeps the old id:
 * said when its text names the target where the target's readers may read it.
 */
function unread(
  site: Site,
  expr: { source: string; error?: { message: string } },
  loc: Span,
  target: ReferenceTarget,
  id: string,
  sees: (site: Site, read: Read) => boolean,
): string[] {
  const context = target.kind === 'job' ? ['needs', 'jobs'] : ['steps'];
  const names = context.some(
    (c) =>
      sees(site, { context: c, path: [id], dynamic: false, start: 0, end: 0, loc }) &&
      new RegExp(`\\b${c}\\s*\\.\\s*${id}(?![\\w-])`, 'i').test(expr.source),
  );
  return names ? [`Line ${loc.line} has an expression simulci cannot read; ${id} in it is not renamed.`] : [];
}

/**
 * The references in the text the page holds: core counts a byte-order mark as the first column of line 1, the page's
 * texts and documents start after it.
 */
function afterBom(refs: Reference[], wf: Workflow | undefined): Reference[] {
  if (!wf?.source.text.startsWith('\uFEFF')) return refs;
  return refs.map((r) => (r.line === 1 ? { ...r, column: r.column - 1, endColumn: r.endColumn - 1 } : r));
}

const whatOf = (target: ReferenceTarget): string => (target.kind === 'job' ? 'a job' : 'a step');

/**
 * The reads that may name a job: `needs` in the jobs that need it (no other job's `needs` holds it), and `jobs` in a
 * `workflow_call` output's value.
 */
function jobReader(wf: Workflow, id: string): (site: Site, read: Read) => boolean {
  const readers = new Set(
    Object.values(wf.jobs)
      .filter((job) => job.needs.some((n) => same(n.id, id)))
      .map((job) => job.id),
  );
  return (site, read) =>
    (read.context === 'needs' && site.job !== undefined && readers.has(site.job)) ||
    (read.context === 'jobs' && site.field === 'workflow.output');
}

/** The reads that may name a step: `steps` in its own job. */
const stepReader =
  (job: string): ((site: Site, read: Read) => boolean) =>
  (site, read) =>
    read.context === 'steps' && same(site.job, job);

/** Whether a reference lies within a read's span. */
function inside(ref: Reference, loc: Span): boolean {
  const from = ref.line > loc.line || (ref.line === loc.line && ref.column >= loc.column);
  const to = ref.endLine < loc.endLine || (ref.endLine === loc.endLine && ref.endColumn <= loc.endColumn);
  return from && to;
}
