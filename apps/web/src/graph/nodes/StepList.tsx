import type { NodeId } from '@simulci/engine';
import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
import { listRows } from '../card';
import { Mark, MARK_LABEL } from '../Mark';
import { CARD, type StepMark } from '../types';

/**
 * The open step list: a row per step with its mark, its label and its outputs, a composite action's inner steps
 * indented under it, 40 rows at most and then "+n". Rows are not tab stops (the canvas keys walk them); a click
 * selects the step. A card being edited decorates its job's own rows (`edit`): their drop target and controls.
 */
export function StepList({
  steps,
  selected,
  onPick,
  edit,
}: {
  steps: readonly StepMark[];
  /** The selected step, when it is one of these. */
  selected?: NodeId;
  onPick: (step: NodeId) => void;
  edit?: (step: StepMark, depth: number) => RowEdit | undefined;
}) {
  const { rows, more } = listRows(steps);
  return (
    <ul className={edit ? 'sc-list sc-list-edit' : 'sc-list'} aria-label={`${rows.length + more} steps`}>
      {rows.map(({ step, depth }) => {
        const pick = (e: MouseEvent): void => {
          e.stopPropagation();
          onPick(step.id);
        };
        const extra = edit?.(step, depth);
        return (
          <li
            key={step.id}
            data-step={step.id}
            data-selected={step.id === selected ? 'true' : undefined}
            style={{ height: CARD.listRow, paddingLeft: depth * 12 }}
            onClick={pick}
            {...extra?.attrs}
          >
            {extra?.controls}
            <Mark verdict={step.verdict} title={MARK_LABEL[step.verdict]} />
            <span className="sc-list-label">{step.label}</span>
            {step.outputs && <span className="sc-list-outputs font-mono">{step.outputs}</span>}
          </li>
        );
      })}
      {more > 0 && (
        <li className="sc-list-more" style={{ height: CARD.listRow }}>
          +{more}
        </li>
      )}
    </ul>
  );
}

/** What an edited card adds to one of its job's own rows: the row's drop handlers, and controls before its mark. */
export interface RowEdit {
  attrs?: HTMLAttributes<HTMLLIElement> & { 'data-drop'?: string | undefined };
  controls?: ReactNode;
}
