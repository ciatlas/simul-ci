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
  segments: { expr: { source: string }; refs: Read[] }[];
}

interface Workflow {
  sites: Site[];
  jobs: Record<string, { id: string; needs: { id: string }[] }>;
}

export function refsOf(
  loaded: LoadedProject,
  target: ReferenceTarget,
): Omit<RefsResponse, 'id' | 'type' | 'project'> {
  const refs = referencesOf(loaded, target);
  const wf: Workflow | undefined = loaded.index.project.workflows.get(target.workflow);
  if (!wf || refs.length === 0) return { refs, exact: true, notes: [] };
  const id = refs.find((r) => r.role === 'key')?.text ?? (target.kind === 'job' ? target.job : target.step);
  const sees = target.kind === 'job' ? jobReader(wf, id) : stepReader(target.job);
  const notes = wf.sites.flatMap((site) =>
    site.segments.flatMap(({ expr, refs: reads }) =>
      reads.flatMap((read) => {
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
