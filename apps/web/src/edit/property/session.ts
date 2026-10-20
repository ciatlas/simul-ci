import { fingerprint, type Fp, type WorkflowOp } from '@simulci/document';
import type { SessionStore } from '../../state/store';
import { type Dispatched, dispatch } from '../dispatch';
import { documents } from '../documents';

/**
 * A field's focus session (synthesis § 4.4, § 4.10). Entering the field starts the gesture: the file's revision and,
 * for a step, the fingerprint of the step the author sees are read then, and every commit is checked against them,
 * so a commit never lands on text the author did not see. A commit moves them on to the text it wrote. The commits
 * share one group, so the session is one undo entry, and leaving the field closes it.
 */
export interface FieldSession {
  /** The field took the focus, showing `text`. */
  begin(text: string): void;
  /**
   * Commits the op for `text` unless it is what the session last committed, or was last refused; undefined when
   * nothing was sent.
   */
  commit(text: string, op: (fp: Fp | undefined) => WorkflowOp): Dispatched | undefined;
  /** The field lost the focus: the session's entry closes. */
  end(): void;
}

export interface SessionTarget {
  file: string;
  /** The job and index of the step the field belongs to. */
  step?: { job: string; index: number };
}

/** The fingerprint of the target's step in the text now: a one-off gesture (a remove, an add) reads it as it starts. */
export function fingerprintOf(store: SessionStore, target: SessionTarget): Fp | undefined {
  if (!target.step) return undefined;
  const doc = documents(store).of(store.getState(), target.file);
  return doc && fingerprint(doc, target.step.job, target.step.index);
}

export function fieldSession(store: SessionStore, target: SessionTarget, group: string): FieldSession {
  let at: { rev: number | undefined; fp: Fp | undefined; committed: string; tried?: string } | undefined;
  const read = (): { rev: number | undefined; fp: Fp | undefined } => ({
    rev: store.getState().files.revs[target.file],
    fp: fingerprintOf(store, target),
  });
  return {
    begin: (text) => {
      at = { ...read(), committed: text };
    },
    commit: (text, op) => {
      if (!at || text === at.committed || text === at.tried) return undefined;
      const result = dispatch(store, op(at.fp), {
        origin: 'field',
        group,
        ...(at.rev === undefined ? {} : { revs: { [target.file]: at.rev } }),
      });
      if (!result.ok) at.tried = text;
      else at = { ...(result.changed ? read() : at), committed: text };
      return result;
    },
    end: () => {
      if (!at) return;
      at = undefined;
      store.getState().closeGroup();
    },
  };
}
