import type { Reference, Refusal, WorkflowOp } from '@simulci/document';

/**
 * What the page and the edit runtime share about an op without the runtime's code: the store keeps the last refusal
 * and the selection an op left for its plan in these shapes. Types only, so the page holds none of the document model.
 */

/** How a gesture's ops are committed (`edit/dispatch.ts`). */
export interface OpMeta {
  /**
   * The revision of each file as the gesture read it (`files.revs`): a file whose text moved since refuses `stale`,
   * so an op never lands on text the author did not see (synthesis § 9.4, row 11).
   */
  revs?: Readonly<Record<string, number>>;
  /** `field` for a Properties field's commit; `op` (the default) for any other gesture. */
  origin?: 'op' | 'field';
  /** The entry's label, when not the last op's. */
  label?: string;
  /** Leave the selection where it is, whatever the op would select. */
  keepSelection?: boolean;
  /**
   * The group of a Properties field's focus session (`field:<file>:<path>`): its commits join one undo entry, which
   * closes when the field loses the focus or at any other edit.
   */
  group?: string;
  /**
   * Where the worker found the id a rename changes, in the texts of the revisions in `revs` (`ctx.refs`, synthesis
   * § 3.3): each is checked against the text it is written over, so a reference that moved refuses `stale`.
   */
  refs?: readonly Reference[];
}

/** One op of a dispatch, and whether it changes every use of a shared anchor (the "Change all" fix). */
export interface PlannedOp {
  op: WorkflowOp;
  shared?: 'all';
}

/**
 * The last refusal of a dispatch, for the status line and the gesture's own callout, with what its fixes run again:
 * the ops of the dispatch and which of them was refused. `seq` tells one refusal from the next.
 */
export interface Refused {
  seq: number;
  refusal: Refusal;
  ops: PlannedOp[];
  /** The index in `ops` of the op refused; the ops before it planned. */
  at: number;
  meta: OpMeta;
}

/**
 * Where the selection goes once the plan of a files version is in (synthesis § 4.10): the target of an op, or the
 * selection an undone or redone entry was made under. Until then the old plan would resolve the unit path against the
 * old text, and so possibly to another node.
 */
export interface PendingSel {
  focus?: string;
  sel?: string;
  files: number;
}
