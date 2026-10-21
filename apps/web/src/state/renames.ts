import type { Rename } from '@simulci/document';
import type { AssumeEntry, NodeId } from '@simulci/engine';
import type { GraphUi } from '../graph/types';
import type { Outline } from '../worker/protocol';
import type { Change, SessionState } from './store';

/**
 * What a rename changes beside the text (synthesis § 4.10, § 7.4): the ids the page keeps of the nodes it names. A
 * transaction carries it, so the store remaps in the same commit and undo and redo map back and forth. The plan's
 * NodeIds (`ci.yml#build`, `ci.yml#build[os=a]/steps.detect`) are mapped by prefix, at an id's boundary only, so
 * `ci.yml#build-2` stays; the unit paths of the selection, the URL and the assume entries by their first segment's job
 * and step, matched ignoring case as GitHub matches ids.
 */
export interface Renames {
  /** Old NodeId prefixes and the new ones: what `diffPlans` and the canvas's open cards go by. */
  nodes: Readonly<Record<NodeId, NodeId>>;
  /** The ids renamed, in their file and job: what the unit paths go by. */
  ids: readonly Rename[];
}

/** What may follow an id within a NodeId: a job's `#`, a leg's `[`, a step's `/`, a callee's `>`. */
const BOUNDARY: ReadonlySet<string> = new Set(['#', '[', '/', '>']);

/** A NodeId in the terms after the renames: its longest old prefix that ends at an id's boundary, replaced. */
export function renamedNode(nodes: Readonly<Record<NodeId, NodeId>>, id: NodeId): NodeId {
  let from: NodeId | undefined;
  for (const prefix of Object.keys(nodes))
    if (
      (id === prefix || (id.startsWith(prefix) && BOUNDARY.has(id[prefix.length]!))) &&
      prefix.length > (from?.length ?? -1)
    )
      from = prefix;
  return from === undefined ? id : nodes[from]! + id.slice(from.length);
}

/** The renames undone: each id back to what it was. */
export function inverse(renames: Renames): Renames {
  return {
    nodes: Object.fromEntries(Object.entries(renames.nodes).map(([from, to]) => [to, from])),
    ids: renames.ids.map((r) => ({ ...r, from: r.to, to: r.from })),
  };
}

/**
 * Two maps one after the other as one, from the first's old ids to the second's new ones: `a → b` then `b → c` is
 * `a → c`, and a node the second renames under one the first renamed (a step of a renamed job) is keyed by its oldest id.
 * Ids that come back to themselves drop out.
 */
export function composeNodes(
  first: Readonly<Record<NodeId, NodeId>>,
  second: Readonly<Record<NodeId, NodeId>>,
): Record<NodeId, NodeId> {
  const back = inverse({ nodes: first, ids: [] }).nodes;
  const out: Record<NodeId, NodeId> = {};
  for (const [from, to] of Object.entries(first)) out[from] = renamedNode(second, to);
  for (const [from, to] of Object.entries(second)) out[renamedNode(back, from)] = to;
  for (const [from, to] of Object.entries(out)) if (from === to) delete out[from];
  return out;
}

/**
 * The canvas's open cards under their new ids too: a job whose steps are open, the leg it shows, a callee opened. The
 * old ids stay beside the new ones, so the picture on screen keeps what it shows until the plan of the new text comes.
 */
export function renamedUi<U extends Pick<GraphUi, 'expanded' | 'representative' | 'opened'>>(
  ui: U,
  nodes: Readonly<Record<NodeId, NodeId>>,
): U {
  const listed = (list: readonly NodeId[]): readonly NodeId[] => {
    const added = list.map((id) => renamedNode(nodes, id)).filter((id) => !list.includes(id));
    return added.length > 0 ? [...list, ...added] : list;
  };
  const representative = { ...ui.representative };
  for (const [job, leg] of Object.entries(ui.representative))
    representative[renamedNode(nodes, job)] ??= renamedNode(nodes, leg);
  const expanded = listed(ui.expanded);
  const opened = listed(ui.opened);
  const same =
    expanded === ui.expanded &&
    opened === ui.opened &&
    Object.keys(representative).length === Object.keys(ui.representative).length;
  return same ? ui : { ...ui, expanded, opened, representative };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A unit path's first segment: its job, its leg selector and its step; the rest (`/…`) is another file's or inner. */
const HEAD = /^([^[./]+)(\[[^\]]*\])?(?:\.([^/]+))?(\/.*)?$/s;

/** A unit path's workflow qualifier (`ci.yml` of `ci.yml:build`): before the first colon outside a leg selector. */
function qualifierOf(path: string): string | undefined {
  const colon = path.split('[')[0]!.indexOf(':');
  return colon === -1 ? undefined : path.slice(0, colon);
}

/**
 * A unit path of the renamed file in the terms after a rename: `build`, `build[os=a].#2` and `build/inner` follow a job
 * renamed, `build.detect` and `build[os=a].detect/inner` a step's id; a qualifier stays. Anything else is returned as
 * it is.
 */
export function renamedUnit(path: string, rename: Rename): string {
  const qualifier = qualifierOf(path);
  const prefix = qualifier === undefined ? '' : `${qualifier}:`;
  const m = HEAD.exec(path.slice(prefix.length));
  if (!m) return path;
  const [, job = '', leg = '', step, rest = ''] = m;
  const dot = step === undefined ? '' : `.${step}`;
  if (rename.kind === 'job')
    return same(job, rename.from) ? `${prefix}${rename.to}${leg}${dot}${rest}` : path;
  if (!same(job, rename.job) || step === undefined || !same(step, rename.from)) return path;
  return `${prefix}${job}${leg}.${rename.to}${rest}`;
}

/** Whether a workflow qualifier (`ci.yml`, `ci`, `.github/workflows/ci.yml`) names a workflow's path. */
export function namesWorkflow(qualifier: string, path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return qualifier === path || qualifier === base || qualifier === base.replace(/\.ya?ml$/i, '');
}

/**
 * The assume entries in the terms after the renames: each `job` and `step` unit path of the renamed file. A path
 * qualified by its workflow (in the path or the entry) is of that file; one without names a job of whichever workflow
 * has it, so it follows the rename only while no other workflow has a job of the old id (`others`). The same array
 * when none changes.
 */
export function renamedAssume(
  assume: AssumeEntry[],
  ids: readonly Rename[],
  others: (file: string, job: string) => boolean,
): AssumeEntry[] {
  const renamed = (path: string | undefined, workflow: string | undefined): string | undefined =>
    path === undefined
      ? undefined
      : ids.reduce((p, r) => (ours(p, workflow, r) ? renamedUnit(p, r) : p), path);
  const ours = (path: string, workflow: string | undefined, r: Rename): boolean => {
    const named = qualifierOf(path) ?? workflow;
    return named === undefined
      ? !others(r.file, r.kind === 'job' ? r.from : r.job)
      : namesWorkflow(named, r.file);
  };
  let changed = false;
  const next = assume.map((entry) => {
    const step = renamed(entry.step, entry.workflow);
    const job = renamed(entry.job, entry.workflow);
    if (step === entry.step && job === entry.job) return entry;
    changed = true;
    return { ...entry, ...(step === undefined ? {} : { step }), ...(job === undefined ? {} : { job }) };
  });
  return changed ? next : assume;
}

/**
 * What a commit that renames changes beside its texts, in the same `set()` (§ 4.10): the canvas's open cards and the
 * assume entries follow the ids, and the unknown under the pointer goes. An assume entry renamed is the same entry,
 * so the change it opens still counts the plan before as simulated from the scenario the answer is simulated from.
 */
export function renamedBeside(
  s: Pick<SessionState, 'ui' | 'assume'>,
  outline: Outline | undefined,
  renames: Renames,
  change: Change | undefined,
): Partial<SessionState> {
  const others = (file: string, job: string): boolean =>
    outline?.workflows.some((w) => w.path !== file && w.jobs.some((j) => same(j.id, job))) ?? false;
  const assume = renamedAssume(s.assume, renames.ids, others);
  const before = change?.before;
  const kept =
    change && before && assume !== s.assume && before.for.assume === s.assume
      ? { ...change, before: { ...before, for: { ...before.for, assume } } }
      : change;
  return {
    ui: renamedUi(s.ui, renames.nodes),
    hoveredUnknown: undefined,
    change: kept,
    ...(assume === s.assume ? {} : { assume }),
  };
}

/** The NodeIds a change maps, after one more commit that may rename: the two maps composed. */
export const changeRenames = (
  open: Readonly<Record<NodeId, NodeId>> | undefined,
  next: Renames | undefined,
): { renames?: Readonly<Record<NodeId, NodeId>> } =>
  next ? { renames: open ? composeNodes(open, next.nodes) : next.nodes } : {};
