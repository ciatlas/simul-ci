import type { Rename } from '@simulci/document';
import { applyEdits } from '@simulci/document/edits';
import type { AssumeEntry, NodeId } from '@simulci/engine';
import type { GraphUi } from '../graph/types';
import { type UnitHead, unitHead } from '../lib/unit-path';
import type { Outline } from '../worker/protocol';
import { stampOf, type Transaction, type TxFile, type TxInput } from './history';
import type { Change, SessionState } from './store';

/**
 * What a rename changes beside the text (synthesis § 4.10, § 7.4): the ids the page keeps of the nodes it names. A
 * transaction carries it, so the store remaps in the same commit and undo and redo map back and forth. The plan's
 * NodeIds (`ci.yml#build`, `ci.yml#build[os=a]/steps.detect`) are mapped by prefix, at an id's boundary only, so
 * `ci.yml#build-2` stays; the unit paths of the selection, the URL and the assume entries by their first segment's job
 * and step, matched exactly, as the engine matches a unit path's ids.
 */
export interface Renames {
  /** Old NodeId prefixes and the new ones: what `diffPlans` and the canvas's open cards go by. */
  nodes: Readonly<Record<NodeId, NodeId>>;
  /** The ids renamed, in their file and job: what the unit paths go by. */
  ids: readonly Rename[];
  /** The assume entries before and after the commit, kept by the store: undo and redo put back exactly these. */
  assume?: { before: AssumeEntry[]; after: AssumeEntry[] };
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
  const { assume } = renames;
  return {
    nodes: Object.fromEntries(Object.entries(renames.nodes).map(([from, to]) => [to, from])),
    // Undone newest first: the last rename of a commit is taken back first.
    ids: renames.ids.toReversed().map((r) => ({ ...r, from: r.to, to: r.from })),
    ...(assume ? { assume: { before: assume.after, after: assume.before } } : {}),
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

/**
 * A unit path of the renamed file in the terms after a rename: `build`, `build[os=a].#2` and `build/inner` follow a job
 * renamed, `build.detect` and `build[os=a].detect/inner` a step's id; a qualifier stays. Anything else is returned as
 * it is.
 */
export function renamedUnit(path: string, rename: Rename): string {
  const head = unitHead(path);
  if (!head) return path;
  const { job, leg, step, rest } = head;
  const prefix = head.qualifier === undefined ? '' : `${head.qualifier}:`;
  const dot = step === undefined ? '' : `.${step}`;
  if (rename.kind === 'job') return job === rename.from ? `${prefix}${rename.to}${leg}${dot}${rest}` : path;
  if (job !== rename.job || step !== rename.from) return path;
  return `${prefix}${job}${leg}.${rename.to}${rest}`;
}

/** Whether a workflow qualifier (`ci.yml`, `ci`, `.github/workflows/ci.yml`) names a workflow's path. */
export function namesWorkflow(qualifier: string, path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return qualifier === path || qualifier === base || qualifier === base.replace(/\.ya?ml$/i, '');
}

/** What the assume entries' unit paths name, from the Outline: the workflows' jobs and the workflows they call. */
export interface World {
  /** Whether a workflow other than `file` has a job of that id. */
  others(file: string, job: string): boolean;
  /** The workflow a qualifier names, or the one workflow that has the job an unqualified path starts with. */
  fileOf(qualifier: string | undefined, job: string): string | undefined;
  /** The local workflow a job calls (`uses: ./.github/workflows/x.yml`). */
  callee(file: string, job: string): string | undefined;
}

function worldOf(outline: Outline | undefined): World {
  const workflows = outline?.workflows ?? [];
  const jobOf = (file: string, job: string) =>
    workflows.find((w) => w.path === file)?.jobs.find((j) => j.id === job);
  return {
    others: (file, job) => workflows.some((w) => w.path !== file && w.jobs.some((j) => j.id === job)),
    fileOf: (qualifier, job) => {
      const owners = workflows.filter((w) =>
        qualifier === undefined ? w.jobs.some((j) => j.id === job) : namesWorkflow(qualifier, w.path),
      );
      return owners.length === 1 ? owners[0]!.path : undefined;
    },
    callee: (file, job) => {
      const uses = jobOf(file, job)?.uses;
      return uses?.startsWith('./') ? uses.slice(2).replace(/@.*$/, '') : undefined;
    },
  };
}

/**
 * The assume entries in the terms after the renames: each `job` and `step` unit path of the renamed file, and the
 * segment of a path through a caller (`call/inner`) that names a job of it. A path qualified by its workflow (in the
 * path or the entry) is of that file. One without names the job in whichever workflow has it, so what it covers must
 * not change: it is renamed as it is while no other workflow has the old id or the new one; it is qualified by the
 * renamed file when another has the new id; and when another has the old id, it stays for that one and a qualified
 * copy follows the rename. The same array when none changes.
 */
export function renamedAssume(assume: AssumeEntry[], ids: readonly Rename[], world: World): AssumeEntry[] {
  const next = ids.reduce<AssumeEntry[]>(
    (list, r) => list.flatMap((entry) => entryRenamed(entry, r, world)),
    assume,
  );
  return next.length === assume.length && next.every((e, i) => e === assume[i]) ? assume : next;
}

/** One entry after one rename: as it is, renamed, renamed and qualified, or kept beside a qualified copy. */
function entryRenamed(entry: AssumeEntry, r: Rename, world: World): AssumeEntry[] {
  const at = pathOf(entry);
  if (!at) return [entry];
  const named = at.head.qualifier ?? entry.workflow;
  const renamed = renamedUnit(at.path, r);
  if (renamed === at.path) {
    const through = throughCallers(at.path, world.fileOf(named, at.head.job), r, world);
    return through === at.path ? [entry] : [withPath(entry, through)];
  }
  if (named === undefined) return unqualified(entry, at.head.job, renamed, r, world);
  return namesWorkflow(named, r.file) ? [withPath(entry, renamed)] : [entry];
}

/** An entry's unit path, its step's or its job's, and its first segment. */
function pathOf(entry: AssumeEntry): { path: string; head: UnitHead } | undefined {
  const path = entry.step ?? entry.job;
  const head = path === undefined ? undefined : unitHead(path);
  return path === undefined || !head ? undefined : { path, head };
}

/**
 * An entry that names its job in whichever workflow has it, renamed so that it covers what it did: as it is, qualified
 * by the renamed file when another workflow has the new id, or beside a qualified copy when another has the old one.
 */
function unqualified(
  entry: AssumeEntry,
  job: string,
  renamed: string,
  r: Rename,
  world: World,
): AssumeEntry[] {
  const qualified = { ...withPath(entry, renamed), workflow: r.file.slice(r.file.lastIndexOf('/') + 1) };
  if (world.others(r.file, job)) return [entry, qualified];
  return r.kind === 'job' && world.others(r.file, r.to) ? [qualified] : [withPath(entry, renamed)];
}

/**
 * A path through callers (`call/inner`, `call/inner.step`) with the segment that names a job or a step of the renamed
 * file renamed: each caller's job leads to the workflow it calls. `file` is the workflow of the path's first job.
 */
function throughCallers(path: string, file: string | undefined, r: Rename, world: World): string {
  const head = unitHead(path);
  const callee = head && calleeOf(head, file, world);
  if (!head || callee === undefined) return path;
  const inner = head.rest.slice(1);
  const renamed = callee === r.file ? renamedUnit(inner, r) : inner;
  const next = renamed === inner ? throughCallers(inner, callee, r, world) : renamed;
  if (next === inner) return path;
  return `${head.qualifier === undefined ? '' : `${head.qualifier}:`}${head.job}${head.leg}/${next}`;
}

/** The workflow a path's first job calls, when the path goes on into it (`call/…`, not a step's inner `x.y/…`). */
const calleeOf = (head: UnitHead, file: string | undefined, world: World): string | undefined =>
  file !== undefined && head.step === undefined && head.rest.startsWith('/')
    ? world.callee(file, head.job)
    : undefined;

const withPath = (entry: AssumeEntry, path: string): AssumeEntry =>
  entry.step === undefined ? { ...entry, job: path } : { ...entry, step: path };

const sameEntries = (a: AssumeEntry[], b: AssumeEntry[]): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** The origins of commits that put a file back as it was, and so take back the renames since: Revert, a disk take. */
const TAKES_BACK: ReadonlySet<TxInput['origin']> = new Set(['revert', 'disk']);

/**
 * A transaction as the store commits it: a rename's with the assume entries before and after; a revert's or a disk
 * take's with the renames it takes back, when it puts a file back to its text before them.
 */
export function carried(
  s: Pick<SessionState, 'assume' | 'edit' | 'files' | 'project'>,
  input: TxInput,
): TxInput {
  const renames =
    input.renames ??
    (TAKES_BACK.has(input.origin) ? takenBack(s.edit.past, textsOf(s.files.byPath, input.files)) : undefined);
  if (!renames || renames.assume)
    return renames === input.renames ? input : { ...input, ...(renames ? { renames } : {}) };
  const outline = s.project.held?.outline ?? s.project.outline;
  const after = renamedAssume(s.assume, renames.ids, worldOf(outline));
  return {
    ...input,
    renames: after === s.assume ? renames : { ...renames, assume: { before: s.assume, after } },
  };
}

/** Each file's text after a transaction's edits, `null` for a file it removes. */
function textsOf(
  byPath: Readonly<Record<string, string>>,
  files: readonly TxFile[],
): Record<string, string | null> {
  return Object.fromEntries(
    files.map((f) => [
      f.path,
      f.remove ? null : applyEdits(f.create ? '' : (byPath[f.path] ?? ''), f.edits).text,
    ]),
  );
}

/**
 * The renames a commit takes back by putting a file back to a text it had before them: those of the entries since
 * the file last held that text, newest first, each undone. None when the history does not reach back to that text.
 */
function takenBack(
  past: readonly Transaction[],
  texts: Readonly<Record<string, string | null>>,
): Renames | undefined {
  const undone: Renames[] = [];
  for (const [path, text] of Object.entries(texts)) {
    const stamp = text === null ? '-' : stampOf(text);
    const found: Renames[] = [];
    for (const tx of past.toReversed()) {
      const file = tx.files.find((f) => f.path === path);
      if (!file) continue;
      if (tx.renames?.ids.some((r) => r.file === path)) found.push(inverse(tx.renames));
      if (file.before === stamp) {
        undone.push(...found);
        break;
      }
    }
  }
  return undone.length === 0 ? undefined : undone.reduce(chained);
}

/** Two renames one after the other as one. */
const chained = (a: Renames, b: Renames): Renames => ({
  nodes: composeNodes(a.nodes, b.nodes),
  ids: [...a.ids, ...b.ids],
});

/**
 * What a commit that renames changes beside its texts, in the same `set()` (§ 4.10): the canvas's open cards and the
 * assume entries follow the ids (the commit's own before and after when the list is still that before, as after an
 * undo of nothing else), and the unknown under the pointer goes. An assume entry renamed is the same entry, so the
 * change it opens still counts the plan before as simulated from the scenario the answer is simulated from.
 */
export function renamedBeside(
  s: Pick<SessionState, 'ui' | 'assume'>,
  outline: Outline | undefined,
  renames: Renames,
  change: Change | undefined,
): Partial<SessionState> {
  const kept = renames.assume;
  const assume =
    kept && sameEntries(s.assume, kept.before)
      ? kept.after
      : renamedAssume(s.assume, renames.ids, worldOf(outline));
  const before = change?.before;
  const answerable =
    change && before && assume !== s.assume && before.for.assume === s.assume
      ? { ...change, before: { ...before, for: { ...before.for, assume } } }
      : change;
  return {
    ui: renamedUi(s.ui, renames.nodes),
    hoveredUnknown: undefined,
    change: answerable,
    ...(assume === s.assume ? {} : { assume }),
  };
}

/** The NodeIds a change maps, after one more commit that may rename: the two maps composed. */
export const changeRenames = (
  open: Readonly<Record<NodeId, NodeId>> | undefined,
  next: Renames | undefined,
): { renames?: Readonly<Record<NodeId, NodeId>> } =>
  next ? { renames: open ? composeNodes(open, next.nodes) : next.nodes } : {};
