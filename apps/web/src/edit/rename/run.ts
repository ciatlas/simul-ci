import {
  type Fp,
  planOp,
  type Reference,
  type Refusal,
  type Rename,
  type Warning,
  type WorkflowOp,
} from '@simulci/document';
import type { FoundRefs, Session } from '../../engine/session';
import { fileLabel } from '../../lib/file-label';
import { listed } from '../../lib/words';
import { newestOutline, newestOutlined, type SessionState, type SessionStore } from '../../state/store';
import type { Outline } from '../../worker/protocol';
import { type Dispatched, dispatch, storeLock } from '../dispatch';
import { documents } from '../documents';
import { testsNaming } from './tests';

/**
 * A rename through the one dispatch path (synthesis § 3.3, § 9.2 C11). The worker finds where the id is written in
 * the newest texts (`Session.refs`, the engine's `referencesOf`); the rename is planned against the text of the
 * revision those references were found in, each checked against the text it is written over, and committed as one
 * entry. A text that moved between the answer and the commit is looked up again once; then the rename refuses
 * `stale`. Once the Outline of the renamed text is in, the rename is checked against it: no `needs` names the old id
 * and the new one is there. If not, and the rename is still the newest entry, it is undone, and the author is told why.
 */

/** A job of the focused workflow, or a step of one with the fingerprint the author saw, at the revision read. */
export interface RenameTarget {
  file: string;
  rev: number;
  job: string;
  step?: { index: number; fp: Fp };
}

/** The references found, for the texts of a files version. */
export type Found = Extract<FoundRefs, { ok: true }>;

/** The id the target has now: a step may have none yet. */
export const oldId = (target: RenameTarget): string | undefined =>
  target.step ? target.step.fp.id : target.job;

function renameOp(target: RenameTarget, to: string): WorkflowOp {
  const { file, job } = target;
  return target.step
    ? { op: 'renameStepId', file, job, index: target.step.index, fp: target.step.fp, to }
    : { op: 'renameJob', file, job, to };
}

/** The history entry's label, in the past tense as the other gestures' are. */
function renameLabel(target: RenameTarget, to: string): string {
  if (!target.step) return `Renamed job ${target.job} to ${to}`;
  const old = target.step.fp.id;
  return old === undefined
    ? `Gave step ${target.step.index + 1} of ${target.job} the id ${to}`
    : `Renamed step ${target.job}.${old} to ${to}`;
}

/**
 * Where the target's id is written, found by the worker in the newest texts. A step without an id has nothing to find:
 * the rename writes its `id:` and nothing reads it yet.
 */
export function findRefs(
  session: Pick<Session, 'refs'>,
  store: SessionStore,
  target: RenameTarget,
): Promise<FoundRefs> {
  const old = oldId(target);
  if (old === undefined) {
    const s = store.getState();
    const found: Found = {
      ok: true,
      project: s.project.version ?? 0,
      files: s.files.version,
      revs: s.files.revs,
      refs: [],
      exact: true,
      notes: [],
    };
    return Promise.resolve(found);
  }
  const { file: workflow, job } = target;
  return session.refs(
    target.step ? { kind: 'step', workflow, job, step: old } : { kind: 'job', workflow, job },
  );
}

/** Whether references found are of the file's text now: they are positions in the text of that revision. */
export const fresh = (s: Pick<SessionState, 'files'>, found: Found, file: string): boolean =>
  found.revs[file] !== undefined && s.files.revs[file] === found.revs[file];

/** What a rename would write, planned and not committed: for the popover that lists what else changes. */
export type Preview =
  | {
      ok: true;
      /** Each place written, by its 1-based line in the text now, with that line's text. */
      lines: { line: number; text: string }[];
      places: number;
      roles: Record<Reference['role'], number>;
      warnings: Warning[];
      notes: string[];
      renames: Rename[];
    }
  | { ok: false; refusal: Refusal };

export function preview(store: SessionStore, target: RenameTarget, to: string, found: Found): Preview {
  const s = store.getState();
  const lock = storeLock(s, target.file);
  if (lock) return { ok: false, refusal: lock };
  const docs = documents(store);
  const plan = planOp(renameOp(target, to), { doc: (path) => docs.of(s, path), refs: found.refs });
  if (!plan.ok) return { ok: false, refusal: plan };
  const text = s.files.byPath[target.file] ?? '';
  const edits = plan.value[target.file] ?? [];
  const lines = [...new Set(edits.map((e) => text.slice(0, e.from).split('\n').length))];
  const all = text.split('\n');
  const roles = { key: 0, needs: 0, read: 0 };
  for (const ref of found.refs) if (ref.file === target.file) roles[ref.role]++;
  const renames = plan.renames ?? [];
  return {
    ok: true,
    lines: lines.map((line) => ({ line, text: (all[line - 1] ?? '').replace(/\r$/, '') })),
    places: edits.length,
    roles,
    warnings: [...plan.warnings, ...renames.flatMap((r) => testsNaming(s.files.byPath, r))],
    notes: found.notes,
    renames,
  };
}

/**
 * The rename committed (§ 9.2 C11): wait until the worker holds the newest texts, find the references, check that the
 * file is still at the revision they were found in, dispatch; a text that moved meanwhile is looked up once more, and
 * then the rename refuses `stale`. References already found (the popover's) are used while their revision holds.
 */
export async function dispatchRename(
  app: { store: SessionStore; session: Pick<Session, 'refs'> },
  target: RenameTarget,
  to: string,
  known?: Found,
): Promise<Dispatched> {
  const { store } = app;
  const op = renameOp(target, to);
  let found = known;
  let last: Dispatched | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!found || !fresh(store.getState(), found, target.file)) {
      const next = await findRefs(app.session, store, target);
      if (!next.ok) return unavailable(store, op, next.message);
      found = next;
    }
    if (fresh(store.getState(), found, target.file)) {
      last = dispatch(store, op, {
        refs: found.refs,
        revs: { [target.file]: found.revs[target.file]! },
        label: renameLabel(target, to),
      });
      if (last.ok || last.refused.refusal.reason !== 'stale') return committed(store, last);
    }
    found = undefined;
  }
  return (
    last ??
    unavailable(
      store,
      op,
      `${fileLabel(target.file)} kept changing while the rename looked for its references; try again.`,
    )
  );
}

/** A rename that cannot be planned now (the texts do not load, the engine is gone), kept for the status line. */
function unavailable(store: SessionStore, op: WorkflowOp, message: string): Dispatched {
  const refusal: Refusal = { ok: false, reason: 'stale', message, file: op.file, fixes: [] };
  const stored = { refusal, ops: [{ op }], at: 0, meta: {} };
  const seq = store.getState().refused(stored);
  return { ok: false, refused: { ...stored, seq } };
}

/**
 * A rename that wrote: a notice that offers Undo and names the route tests it left naming the old id, and the check
 * of the next Outline.
 */
function committed(store: SessionStore, result: Dispatched): Dispatched {
  if (!result.ok || !result.changed) return result;
  const s = store.getState();
  const tx = s.edit.past.at(-1);
  if (!tx) return result;
  const tests = result.renames.flatMap((r) => testsNaming(s.files.byPath, r).map((w) => w.message));
  s.notify([tx.label, ...tests].join('. '), tx);
  watchRename(store, tx, result.renames, s.files.version);
  return result;
}

/**
 * Why the Outline of the renamed text says a rename did not hold, or undefined when it did or the Outline does not
 * know the workflow: a job renamed that a `needs` still names by its old id, or a new id not there.
 */
export function renameBroken(outline: Outline | undefined, rename: Rename): string | undefined {
  const wf = outline?.workflows.find((w) => w.path === rename.file);
  if (!wf) return undefined;
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  if (rename.kind === 'job') {
    const stale = wf.jobs.filter((j) => j.needs.some((n) => same(n, rename.from) && n !== rename.to));
    if (stale.length > 0)
      return `${listed(stale.map((j) => j.id))} still ${stale.length === 1 ? 'needs' : 'need'} ${rename.from}`;
    return wf.jobs.some((j) => j.id === rename.to) ? undefined : `no job has the id ${rename.to}`;
  }
  const job = wf.jobs.find((j) => j.id === rename.job);
  return !job || job.steps.some((step) => step.id === rename.to)
    ? undefined
    : `no step of ${rename.job} has the id ${rename.to}`;
}

/**
 * Checks a rename against the first Outline of its text or a newer one. When it did not hold and is still the newest
 * entry, with no typing open after it, it is undone; else the author is told what is left. A new source ends the
 * watch. The undo runs after the store's listeners, never inside one.
 */
export function watchRename(
  store: SessionStore,
  tx: { id: number; label: string },
  renames: readonly Rename[],
  files: number,
): () => void {
  const { epoch } = store.getState().files;
  let done = false;
  const check = (s: SessionState): void => {
    if (done) return;
    const at = newestOutlined(s);
    if (s.files.epoch === epoch && (at === undefined || at < files)) return;
    done = true;
    stop();
    if (s.files.epoch !== epoch) return;
    const broken = renames.map((r) => renameBroken(newestOutline(s), r)).find((b) => b !== undefined);
    if (broken !== undefined) queueMicrotask(() => undoBroken(store, tx, broken));
  };
  const stop = store.subscribe(check);
  check(store.getState());
  return stop;
}

function undoBroken(store: SessionStore, tx: { id: number; label: string }, broken: string): void {
  const s = store.getState();
  if (!s.edit.group && s.edit.past.at(-1)?.id === tx.id && s.undo()) {
    s.notify(`Undid “${tx.label}”: ${broken}.`);
    return;
  }
  s.notify(`“${tx.label}” did not hold: ${broken}. Fix it in the YAML pane, or undo it.`);
}
