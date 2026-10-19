import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import { memo } from 'react';
import { edgeAttrs } from '../card';
import type { NeedsEdgeData, NeedsFlowEdge } from '../flow';

/**
 * A `needs` edge, from the needed job to the one that needs it, as a rounded step path. From a skipped job it is
 * faded, from a might-run one dashed in the might colour; the need that decided its target's verdict is drawn in
 * the danger colour with the result that decided it as a label; on the selected job's path it takes the accent.
 */
function NeedsEdgeView({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
}: EdgeProps<NeedsFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });
  const look = edgeAttrs(data ?? PLAIN);
  return (
    <>
      <BaseEdge id={id} path={path} className="sc-edge" interactionWidth={0} {...look} />
      {data?.deciding && data.label && (
        <EdgeLabelRenderer>
          <div
            className="sc-edge-label font-mono"
            data-path={look['data-path']}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** An edge without data draws as a plain need between two jobs that run. */
const PLAIN: NeedsEdgeData = { from: 'yes', deciding: false, onPath: false, faded: false };

export const NeedsEdge = memo(NeedsEdgeView);
