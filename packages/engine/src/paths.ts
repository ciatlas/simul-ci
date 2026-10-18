/**
 * Unit paths: how authors name a job, a matrix leg or a step, in selectors, pins, assertions and messages.
 * `job`, `job.step`, `job[k=v,k2=v2].step`, `job.#3` (the third step), `caller/job.step` (a job of the
 * reusable workflow the job `caller` calls), `job.step/inner` (a step of the composite action the step uses), and an
 * optional `workflow:` qualifier written as `ci.yml:job`. Ids are `[A-Za-z_][A-Za-z0-9_-]*`.
 */

export interface PathStep {
  /** The step id, or its 1-based position in the sequence when `index` is set (`#2` is the second step). */
  id?: string;
  index?: number;
}

export interface PathSegment {
  /** The job id; absent for a composite action's inner step, which follows a step. */
  job?: string;
  /** Matrix values that select a leg; absent means every leg. */
  leg?: Record<string, string>;
  step?: PathStep;
}

export interface UnitPath {
  workflow?: string;
  segments: PathSegment[];
}

const ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export class UnitPathError extends Error {
  override name = 'UnitPathError';
}

/** Parses a unit path; throws `UnitPathError` with the reason. */
export function parseUnitPath(text: string): UnitPath {
  const path: UnitPath = { segments: [] };
  let rest = text.trim();
  // The qualifier ends at the first colon outside a `[…]` leg selector (leg values may hold colons).
  const colon = rest.split('[')[0]!.indexOf(':');
  if (colon !== -1) {
    path.workflow = rest.slice(0, colon).trim();
    rest = rest.slice(colon + 1).trim();
  }
  if (rest === '') throw new UnitPathError(`empty unit path: '${text}'`);
  for (const [i, part] of rest.split('/').entries()) {
    const previous = path.segments[i - 1];
    // After a step, `/` descends into the composite action: the next segment is an inner step.
    const inner = previous?.step !== undefined;
    path.segments.push(inner ? { step: parseStep(part, text) } : parseJobSegment(part, text));
  }
  return path;
}

function parseJobSegment(part: string, text: string): PathSegment {
  const m = /^([^[.]+)(?:\[([^\]]*)\])?(?:\.(.+))?$/.exec(part);
  if (!m) throw new UnitPathError(`cannot read '${part}' in '${text}'`);
  const [, job, leg, step] = m;
  if (!ID.test(job!)) throw new UnitPathError(`'${job}' is not a job id in '${text}'`);
  const segment: PathSegment = { job };
  if (leg !== undefined) segment.leg = parseLeg(leg, text);
  if (step !== undefined) segment.step = parseStep(step, text);
  return segment;
}

function parseLeg(leg: string, text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of leg.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new UnitPathError(`'${pair}' is not key=value in '${text}'`);
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function parseStep(step: string, text: string): PathStep {
  if (step.startsWith('#')) {
    const n = Number(step.slice(1));
    if (!Number.isInteger(n) || n < 1) throw new UnitPathError(`'${step}' is not #<position> in '${text}'`);
    return { index: n };
  }
  if (!ID.test(step)) throw new UnitPathError(`'${step}' is not a step id in '${text}'`);
  return { id: step };
}

export function formatUnitPath(path: UnitPath): string {
  const body = path.segments
    .map((s) => {
      const leg = s.leg
        ? `[${Object.entries(s.leg)
            .map(([k, v]) => `${k}=${v}`)
            .join(',')}]`
        : '';
      const step = s.step ? (s.step.id !== undefined ? s.step.id : `#${s.step.index}`) : '';
      if (s.job === undefined) return step;
      return `${s.job}${leg}${step ? `.${step}` : ''}`;
    })
    .join('/');
  return path.workflow === undefined ? body : `${path.workflow}:${body}`;
}

/** Where a unit sits while it is planned: the workflow file and the chain of jobs and steps down to it. */
export interface Location {
  workflow: string;
  chain: LocationLink[];
}

export type LocationLink =
  | { kind: 'job'; id: string; leg?: Record<string, string> }
  | { kind: 'step'; id?: string; index: number; uses?: string };

/** Whether a path names the location: same depth, same jobs and steps, leg values a subset of the location's. */
export function pathMatches(path: UnitPath, location: Location): boolean {
  if (path.workflow !== undefined && !workflowMatches(path.workflow, location.workflow)) return false;
  const links = flatten(path);
  if (links.length !== location.chain.length) return false;
  return links.every((link, i) => linkMatches(link, location.chain[i]!));
}

/** The path as the chain of links the location has. */
function flatten(
  path: UnitPath,
): ({ kind: 'job'; id: string; leg?: Record<string, string> } | { kind: 'step'; step: PathStep })[] {
  return path.segments.flatMap((s) => {
    const out: ReturnType<typeof flatten> = [];
    if (s.job !== undefined)
      out.push(s.leg ? { kind: 'job', id: s.job, leg: s.leg } : { kind: 'job', id: s.job });
    if (s.step) out.push({ kind: 'step', step: s.step });
    return out;
  });
}

function linkMatches(link: ReturnType<typeof flatten>[number], at: LocationLink): boolean {
  if (link.kind === 'job') {
    if (at.kind !== 'job' || at.id !== link.id) return false;
    if (!link.leg) return true;
    return Object.entries(link.leg).every(([k, v]) => at.leg !== undefined && lookupValue(at.leg, k) === v);
  }
  if (at.kind !== 'step') return false;
  return link.step.id !== undefined ? at.id === link.step.id : at.index === link.step.index;
}

/** `ci.yml`, `.github/workflows/ci.yml` or `ci` name the same file. */
export function workflowMatches(name: string, path: string): boolean {
  const base = path.replace(/^.*\//, '');
  return name === path || name === base || name === base.replace(/\.ya?ml$/i, '');
}

/** How much of the unit a path names: more links, more leg keys and an explicit workflow rank higher. */
export function pathSpecificity(path: UnitPath): number {
  const links = flatten(path);
  const legKeys = path.segments.reduce((n, s) => n + Object.keys(s.leg ?? {}).length, 0);
  return links.length * 100 + legKeys * 10 + (path.workflow === undefined ? 0 : 1);
}

function lookupValue(rec: Record<string, string>, key: string): string | undefined {
  if (Object.hasOwn(rec, key)) return rec[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(rec)) if (k.toLowerCase() === lower) return rec[k];
  return undefined;
}
