/**
 * A unit path's first segment, read as the plan spells it (`ci.yml:build[os=a].detect/inner`): an optional workflow
 * qualifier, the job, its leg selector, a step, and the rest after a `/` (a called workflow's job, a composite
 * action's inner step). A selector's brackets nest and hide what is inside them, so a matrix value may hold `/`, `.`
 * or brackets (`[dir=packages/a]`, `[install=.[dev]]`).
 */
export interface UnitHead {
  qualifier?: string;
  job: string;
  /** The selector with its brackets, or `''`. */
  leg: string;
  step?: string;
  /** From the `/` on, or `''`. */
  rest: string;
}

/** The parts of a unit path's first segment; undefined for a path it cannot read (an unclosed selector). */
export function unitHead(path: string): UnitHead | undefined {
  const colon = path.split('[')[0]!.indexOf(':');
  const qualifier = colon === -1 ? undefined : path.slice(0, colon);
  const body = path.slice(colon + 1);
  const jobEnd = endOf(body, 0, '[./');
  const legEnd = body[jobEnd] === '[' ? closing(body, jobEnd) : jobEnd;
  if (jobEnd === 0 || legEnd < 0) return undefined;
  const stepEnd = body[legEnd] === '.' ? endOf(body, legEnd + 1, '/') : legEnd;
  if (stepEnd < body.length && body[stepEnd] !== '/') return undefined;
  return {
    ...(qualifier === undefined ? {} : { qualifier }),
    job: body.slice(0, jobEnd),
    leg: body.slice(jobEnd, legEnd),
    ...(stepEnd === legEnd ? {} : { step: body.slice(legEnd + 1, stepEnd) }),
    rest: body.slice(stepEnd),
  };
}

/** The first index from `from` holding one of `stops`, else the end. */
function endOf(text: string, from: number, stops: string): number {
  let at = from;
  while (at < text.length && !stops.includes(text[at]!)) at++;
  return at;
}

/** Just past the `]` that closes the `[` at `open`; -1 when none does. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === '[') depth++;
    else if (text[at] === ']' && --depth === 0) return at + 1;
  }
  return -1;
}

/**
 * Whether a selection is of a called workflow's job or a composite's inner step: a `/` outside the leg selector. Not a
 * node of the selected file, so no edit gesture acts on it.
 */
export function callsOut(sel: string | undefined): boolean {
  const head = sel === undefined ? undefined : unitHead(sel);
  return head === undefined ? (sel?.includes('/') ?? false) : head.rest !== '';
}
