import type { NodeId } from '@simulci/engine';
import type { MouseEvent } from 'react';
import { listRows } from '../card';
import { Mark, MARK_LABEL } from '../Mark';
import { CARD, type StepMark } from '../types';

/**
 * The open step list: a row per step with its mark, its label and its outputs, a composite action's inner steps
 * indented under it, 40 rows at most and then "+n". Rows are not tab stops (the canvas keys walk them); a click
 * selects the step.
 */
export function StepList({
  steps,
  selected,
  onPick,
}: {
  steps: readonly StepMark[];
  /** The selected step, when it is one of these. */
  selected?: NodeId;
  onPick: (step: NodeId) => void;
}) {
  const { rows, more } = listRows(steps);
  return (
    <ul className="sc-list" aria-label={`${rows.length + more} steps`}>
      {rows.map(({ step, depth }) => {
        const pick = (e: MouseEvent): void => {
          e.stopPropagation();
          onPick(step.id);
        };
        return (
          <li
            key={step.id}
            data-step={step.id}
            data-selected={step.id === selected ? 'true' : undefined}
            style={{ height: CARD.listRow, paddingLeft: depth * 12 }}
            onClick={pick}
          >
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
