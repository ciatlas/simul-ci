import type { WorkflowDocument, WorkflowOp } from '@simulci/document';
import type { Reason } from '@simulci/engine';
import { createContext, useContext, useState } from 'react';
import { useApp } from '../../app/providers';
import type { OutlineFile, OutlineWorkflow } from '../../worker/protocol';
import { dispatch } from '../dispatch';
import type { EventTable } from './model';

/** Selectors of the editor's controls, for where the focus goes after an edit removed the focused one. */
export const at = {
  event: (event: string): string => `[data-event="${event}"] input[type="radio"]`,
  addFilter: (event: string): string => `[data-event="${event}"] select[data-add-filter]`,
  filterAdd: (event: string, key: string): string =>
    `[data-event="${event}"] [data-filter="${key}"] button[data-add]`,
  filterMore: (event: string, key: string): string =>
    `[data-event="${event}"] [data-filter="${key}"] button[data-more]`,
  addEvent: '[data-add-event]',
};

/** What every row of the triggers editor reads: the focused workflow's document, its hints and the plan's reasons. */
export interface Triggers {
  file: string;
  doc: WorkflowDocument;
  /** The file's revision the rows were read at: a gesture on a text that moved since refuses `stale`. */
  rev: number | undefined;
  /** The file takes no edit (generated, broken YAML, mixed line endings): the rows show, no control writes. */
  locked: boolean;
  table: EventTable;
  /** The Outline's view of the workflow and of its file: crons in words, the converter's problems. */
  hints?: OutlineWorkflow;
  outlined?: OutlineFile;
  /** The plan's trigger reasons when the plan is of this event, for the rows' checks. */
  chain: (event: string) => Reason[] | undefined;
  /** The plan shown is behind the text: checks say "as of the last plan". */
  behind: boolean;
  /**
   * Says an edit in the editor's live region. When the edit took the focused control away (the last chip of a filter,
   * a removed event), the focus goes to the element `focus` selects in the editor once it shows, else to Add event.
   */
  say: (words: string, focus?: string) => void;
}

export const TriggersContext = createContext<Triggers | undefined>(undefined);

export function useTriggers(): Triggers {
  const triggers = useContext(TriggersContext);
  if (!triggers) throw new Error('a trigger row outside TriggerRows');
  return triggers;
}

/**
 * One control's edits: each is dispatched against the revision the rows were read at, and said when it changed the
 * file. A refusal's `seq` is kept, so its sentence and fixes show under the control (`RefusalNote`).
 */
export function useGesture(): {
  refused: number | undefined;
  run: (ops: WorkflowOp | readonly WorkflowOp[], words: string, focus?: string) => boolean;
} {
  const { store } = useApp();
  const { file, rev, say } = useTriggers();
  const [refused, setRefused] = useState<number>();
  const run = (ops: WorkflowOp | readonly WorkflowOp[], words: string, focus?: string): boolean => {
    const result = dispatch(store, ops, rev === undefined ? {} : { revs: { [file]: rev } });
    if (!result.ok) {
      setRefused(result.refused.seq);
      return false;
    }
    setRefused(undefined);
    if (result.changed) say(words, focus);
    return true;
  };
  return { refused, run };
}
