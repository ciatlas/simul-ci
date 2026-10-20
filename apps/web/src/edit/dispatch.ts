import {
  composeEdits,
  type Fix,
  planOp,
  type Refusal,
  type Rename,
  type TextEdit,
  type Warning,
  type WorkflowDocument,
  type WorkflowOp,
  type YamlPath,
} from '@simulci/document';
import { copyText } from '../lib/clipboard';
import { fileLabel } from '../lib/file-label';
import { markEdit } from '../lib/marks';
import { type SelectionRef, stampOf, type TxFile } from '../state/history';
import type { SessionState, SessionStore } from '../state/store';
import { type Documents, documents, type Lock } from './documents';
import { selectionAfter } from './selection';
import type { OpMeta, PlannedOp, Refused } from './types';

/**
 * The one way a structured gesture changes the files (synthesis § 4.1). The ops are planned synchronously against
 * the documents of the texts now, each on the documents the one before it produced, and committed as one transaction
 * whose every file names the text it was planned against (`expect`), so nothing lands on a text that moved. A refusal
 * comes back with its fixes and stays in the store for the status line; taking a fix runs its ops, then the refused
 * op again, as one transaction: one undo step. A plan that changes nothing is not an entry.
 */

export type Dispatched =
  | { ok: true; changed: boolean; label: string; warnings: Warning[]; renames: Rename[] }
  | { ok: false; refused: Refused };

/** Plans and commits one gesture's ops, in order. */
export function dispatch(
  store: SessionStore,
  op: WorkflowOp | readonly WorkflowOp[],
  meta: OpMeta = {},
): Dispatched {
  const ops = (Array.isArray(op) ? op : [op]).map((o: WorkflowOp) => ({ op: o }));
  return run(store, ops, meta);
}

/**
 * Takes a fix a refusal offered. `ops` runs the fix's ops where the refused op was, then that op again when the fix
 * retries it; `shared-all` runs the refused op (after the fix's own ops) changing every use of the shared anchor;
 * either way the ops before it run first and the ops after it after, all as one transaction. `unlock` lets the
 * generated file be edited and runs the ops again. The others act on the page and commit nothing: undefined.
 */
export function applyFix(store: SessionStore, refused: Refused, fix: Fix): Dispatched | undefined {
  const { ops, at, meta, refusal } = refused;
  const head = ops.slice(0, at);
  const tail = ops.slice(at + 1);
  const failed = ops[at]!;
  const actions = store.getState();
  switch (fix.kind) {
    case 'ops':
      return run(
        store,
        [...head, ...fix.ops.map((op) => ({ op })), ...(fix.retry ? [failed] : []), ...tail],
        meta,
      );
    case 'shared-all':
      return run(
        store,
        [
          ...head,
          ...(fix.ops ?? []).map((op) => ({ op, shared: 'all' as const })),
          { ...failed, shared: 'all' },
          ...tail,
        ],
        meta,
      );
    case 'unlock':
      actions.unlock(refusal.file);
      return run(store, ops, meta);
    case 'reveal':
      actions.refused(undefined);
      actions.setEdit(true);
      actions.revealLine({ file: refusal.file, line: fix.line });
      break;
    case 'undo':
      actions.refused(undefined);
      actions.undo();
      break;
    case 'report':
      void copyText(fix.text);
  }
  return undefined;
}

function run(store: SessionStore, ops: PlannedOp[], meta: OpMeta): Dispatched {
  const s = store.getState();
  const moved = movedSince(s, meta.revs);
  if (moved) return refuse(store, stale(moved), ops, 0, meta);
  const planned = planAll(store, s, ops);
  if ('refusal' in planned) return refuse(store, planned.refusal, ops, planned.at, meta);
  return commit(store, s, planned, ops, meta);
}

/** What the ops write, together. */
interface Plan {
  /** Per file, every op's edits composed into one list in the offsets of the text now. */
  edits: Map<string, TextEdit[]>;
  /** The files the ops create. */
  created: Set<string>;
  /** The documents of the texts the ops leave, and the lock each was opened with. */
  after: Map<string, { doc: WorkflowDocument; lock: Lock }>;
  label: string;
  select?: { file: string; path: YamlPath };
  warnings: Warning[];
  renames: Rename[];
}

/** Each op planned on the documents the ops before it left; the first refusal, and the index of its op, stops it. */
function planAll(
  store: SessionStore,
  s: SessionState,
  ops: readonly PlannedOp[],
): Plan | { refusal: Refusal; at: number } {
  const docs = documents(store);
  const plan: Plan = {
    edits: new Map(),
    created: new Set(),
    after: new Map(),
    label: '',
    warnings: [],
    renames: [],
  };
  const doc = (path: string): WorkflowDocument | undefined => plan.after.get(path)?.doc ?? docs.of(s, path);
  for (const [at, { op, shared }] of ops.entries()) {
    const result = storeLock(s, op.file) ?? planOp(op, shared ? { doc, shared } : { doc });
    if (!result.ok) return { refusal: result, at };
    fold(plan, result, s, docs);
  }
  return plan;
}

type Planned = Extract<ReturnType<typeof planOp>, { ok: true }>;

/** One op's plan added to the plan of the ops before it. */
function fold(plan: Plan, result: Planned, s: SessionState, docs: Documents): void {
  for (const path of result.created ?? []) plan.created.add(path);
  for (const [path, edits] of Object.entries(result.value))
    plan.edits.set(path, composed(plan, s, path, edits));
  for (const [path, doc] of Object.entries(result.documents))
    plan.after.set(path, { doc, lock: plan.after.get(path)?.lock ?? docs.lockOf(s, path) });
  plan.label = result.label;
  if (result.select) plan.select = result.select;
  plan.warnings.push(...result.warnings);
  plan.renames.push(...(result.renames ?? []));
}

/** A file's edits so far and an op's, which are in the text the ones so far wrote, as one list against its text now. */
function composed(plan: Plan, s: SessionState, path: string, edits: readonly TextEdit[]): TextEdit[] {
  const sofar = plan.edits.get(path);
  return sofar ? composeEdits(textOf(s, path) ?? '', sofar, edits) : [...edits];
}

/** The transaction of a plan, with the selection it leaves for the plan of its texts. */
function commit(
  store: SessionStore,
  s: SessionState,
  plan: Plan,
  ops: PlannedOp[],
  meta: OpMeta,
): Dispatched {
  const files = txFiles(s, plan);
  const done = {
    ok: true,
    label: meta.label ?? plan.label,
    warnings: plan.warnings,
    renames: plan.renames,
  } as const;
  const actions = store.getState();
  if (files.length === 0) {
    actions.refused(undefined);
    return { ...done, changed: false };
  }
  const after = meta.keepSelection ? undefined : leftSelection(s, plan);
  const outcome = actions.transact({
    label: done.label,
    origin: meta.origin ?? 'op',
    files,
    ...(after ? { selectionAfter: after } : {}),
  });
  // Ops plan on the texts of this tick, so a text that moved under them is a fault of the page, said as `stale`.
  if (!outcome.ok)
    return outcome.refusal
      ? refuse(store, stale(outcome.refusal.path), ops, ops.length - 1, meta)
      : { ...done, changed: false };
  const now = store.getState();
  for (const [path, { doc, lock }] of plan.after) documents(store).seed(now, path, doc, lock);
  markEdit('edit:tx', now.files.version);
  return { ...done, changed: true };
}

/** Each file's edits, against the text the ops were planned on, or creating it; files left as they are drop out. */
function txFiles(s: SessionState, plan: Plan): TxFile[] {
  const files: TxFile[] = [];
  for (const [path, edits] of plan.edits) {
    const text = textOf(s, path);
    if (text !== undefined) {
      if (edits.length > 0) files.push({ path, edits, expect: stampOf(text) });
    } else if (plan.created.has(path)) files.push({ path, edits, create: true });
  }
  return files;
}

/** Where the plan leaves the selection: the place its last op selects, in the text it wrote. */
function leftSelection(s: SessionState, plan: Plan): SelectionRef | undefined {
  const at = plan.select && plan.after.get(plan.select.file);
  return at && plan.select ? selectionAfter(s, plan.select, at.doc) : undefined;
}

const textOf = (s: SessionState, path: string): string | undefined =>
  Object.hasOwn(s.files.byPath, path) ? s.files.byPath[path] : undefined;

/**
 * Stores a refusal for the status line and the gesture's callout. Its fixes run against the texts it was refused
 * on: the revisions of the files its ops touch are kept, so a fix taken after the text moved refuses `stale` rather
 * than land on lines the refusal did not mean.
 */
function refuse(
  store: SessionStore,
  refusal: Refusal,
  ops: PlannedOp[],
  at: number,
  meta: OpMeta,
): Dispatched {
  const { revs } = store.getState().files;
  const touched = new Set([...ops.map((o) => o.op.file), ...Object.keys(meta.revs ?? {})]);
  const kept = Object.fromEntries(
    [...touched].flatMap((path) => (revs[path] === undefined ? [] : [[path, revs[path]]])),
  );
  const stored = { refusal, ops, at, meta: { ...meta, revs: kept } };
  const seq = store.getState().refused(stored);
  return { ok: false, refused: { ...stored, seq } };
}

/** The first file whose text moved since the gesture read it. */
function movedSince(s: SessionState, revs: OpMeta['revs']): string | undefined {
  return Object.entries(revs ?? {}).find(([path, rev]) => s.files.revs[path] !== rev)?.[0];
}

const stale = (path: string): Refusal => ({
  ok: false,
  reason: 'stale',
  message: `${fileLabel(path)} changed since this edit began; try again.`,
  file: path,
  fixes: [],
});

/**
 * What locks a file in the store before the document is asked: bytes that are not UTF-8, which would not be written
 * back as read (`not-utf8`), and a file whose generated marker is not known yet (no Outline of the epoch has come).
 */
function storeLock(s: SessionState, path: string): Refusal | undefined {
  const meta = s.files.meta[path];
  if (meta && !meta.utf8 && textOf(s, path) !== undefined)
    return {
      ok: false,
      reason: 'not-utf8',
      message: `${fileLabel(path)} is not valid UTF-8, so simulci keeps it read-only.`,
      file: path,
      fixes: [],
    };
  if (s.generated === undefined)
    return {
      ok: false,
      reason: 'stale',
      message: `${fileLabel(path)} is still loading; try again in a moment.`,
      file: path,
      fixes: [],
    };
  return undefined;
}
