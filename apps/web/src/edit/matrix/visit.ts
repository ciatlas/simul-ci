import type { WorkflowOp } from '@simulci/document';
import { type FocusEvent, useMemo, useState } from 'react';
import { useApp } from '../../app/providers';
import { dispatch } from '../dispatch';
import { fieldSession } from '../property/session';

/**
 * How the matrix editor commits (synthesis § 4.7, § 6): through `dispatch`, as Properties' fields do. A visit to one
 * of its inputs is a focus session: every commit of the visit is one undo entry, closed when the focus leaves it,
 * and checked against the file's revision read when the focus came in. A click (a ×, the switch) is a gesture of its
 * own, checked against the revision the panel was drawn from.
 */

export interface Visit {
  /** The refusal of the visit's last commit, for its callout. */
  refusedSeq: number | undefined;
  /** Handlers for the element that holds the visit's inputs: the visit begins and ends with the focus inside it. */
  focus: { onFocus: (event: FocusEvent) => void; onBlur: (event: FocusEvent) => void };
  /** Commits the op for `text`, unless the visit last committed that text; whether it was written. */
  commit: (text: string, op: WorkflowOp) => boolean;
  /** Ends the visit now: its input is about to go. */
  end: () => void;
}

export function useVisit(file: string, group: string, shown = ''): Visit {
  const { store } = useApp();
  const session = useMemo(() => fieldSession(store, { file }, group), [store, file, group]);
  const [refusedSeq, setRefusedSeq] = useState<number>();
  return {
    refusedSeq,
    focus: {
      onFocus: (event) => {
        if (!within(event)) session.begin(shown);
      },
      onBlur: (event) => {
        if (!within(event)) session.end();
      },
    },
    commit: (text, op) => {
      const result = session.commit(text, () => op);
      if (result) setRefusedSeq(result.ok ? undefined : result.refused.seq);
      return result?.ok ?? false;
    },
    end: () => session.end(),
  };
}

/** The focus moves between two elements inside the visit's: the visit goes on. */
const within = (event: FocusEvent): boolean =>
  event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);

export interface Gesture {
  refusedSeq: number | undefined;
  run: (op: WorkflowOp) => void;
}

/** A one-off gesture on the text the panel shows: an op made from revision `rev` refuses `stale` once it moved. */
export function useGesture(file: string, rev: number): Gesture {
  const { store } = useApp();
  const [refusedSeq, setRefusedSeq] = useState<number>();
  return {
    refusedSeq,
    run: (op) => {
      const result = dispatch(store, op, { revs: { [file]: rev } });
      setRefusedSeq(result.ok ? undefined : result.refused.seq);
    },
  };
}
