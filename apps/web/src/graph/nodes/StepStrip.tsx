import type { NodeId } from '@simulci/engine';
import type { MouseEvent } from 'react';
import { stripLayout } from '../card';
import { MARK_LABEL } from '../../lib/words';
import { Mark } from '../Mark';
import type { StepMark } from '../types';

/**
 * The representative leg's steps as one row of marks (more rows past 26), composite inner steps left to the list.
 * A mark's shape is its verdict; its label names the step. A click selects the step.
 */
export function StepStrip({
  steps,
  width,
  selected,
  onPick,
}: {
  steps: readonly StepMark[];
  /** The width the strip may take. */
  width: number;
  /** The selected step, when it is one of these. */
  selected?: NodeId;
  onPick: (step: NodeId) => void;
}) {
  const layout = stripLayout(steps.length, width);
  return (
    <svg
      className="sc-strip"
      width={layout.width}
      height={layout.height}
      role="group"
      aria-label={`${steps.length} steps`}
    >
      {steps.map((step, i) => {
        const at = layout.at(i);
        const pick = (e: MouseEvent): void => {
          e.stopPropagation();
          onPick(step.id);
        };
        return (
          <g
            key={step.id}
            data-step={step.id}
            data-selected={step.id === selected ? 'true' : undefined}
            transform={`translate(${at.x},${at.y})`}
            onClick={pick}
          >
            <rect className="sc-hit" x="-1" y="-1" width={layout.size + 2} height={layout.size + 2} rx="2" />
            <Mark
              verdict={step.verdict}
              size={layout.size}
              title={`${step.label}: ${MARK_LABEL[step.verdict]}`}
            />
          </g>
        );
      })}
    </svg>
  );
}
