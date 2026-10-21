import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import { memo, type MouseEvent, useMemo } from 'react';
import { useApp } from '../../app/providers';
import { gestures } from '../../edit/gestures';
import { edgeAttrs } from '../card';
import type { NeedsEdgeData, NeedsFlowEdge } from '../flow';

/**
 * A `needs` edge, from the needed job to the one that needs it, as a rounded step path. From a skipped job it is
 * faded, from a might-run one dashed in the might colour; the need that decided its target's verdict is drawn in
 * the danger colour with the result that decided it as a label; on the selected job's path it takes the accent. In
 * edit mode an edge of the workflow being edited shows ✕ while the pointer or the focus is on it (Delete on the
 * focused edge does the same), and a need written since the picture is drawn dashed until the next one has it.
 */
function NeedsEdgeView({
  id,
  source,
  target,
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
      <BaseEdge
        id={id}
        path={path}
        className="sc-edge"
        interactionWidth={data?.removable ? 12 : 0}
        data-pending={data?.pending || undefined}
        {...look}
      />
      {data?.removable && <Remove source={source} target={target} hot={data.hot} x={labelX} y={labelY} />}
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

/**
 * ✕ beside the edge's middle, shown while the edge is hot and while the pointer is on it, so it stays to be clicked
 * once the pointer leaves the line. The keyboard's way is Delete on the focused edge, so it is no tab stop.
 */
function Remove({
  source,
  target,
  hot,
  x,
  y,
}: {
  source: string;
  target: string;
  hot?: boolean;
  x: number;
  y: number;
}) {
  const { store } = useApp();
  const name = useMemo(
    () => `Remove the need: ${needName(target)} needs ${needName(source)}`,
    [source, target],
  );
  const remove = (e: MouseEvent): void => {
    e.stopPropagation();
    gestures.of(store)?.disconnect(source, target);
  };
  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        tabIndex={-1}
        className="sc-edge-remove nodrag nopan"
        data-hot={hot || undefined}
        aria-label={name}
        title={name}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y + 14}px)` }}
        onClick={remove}
      >
        ✕
      </button>
    </EdgeLabelRenderer>
  );
}

/** A job's id from its node id, as the file names it: `build` of `ci.yml#build`. */
const needName = (node: string): string => node.slice(node.lastIndexOf('#') + 1);

/** An edge without data draws as a plain need between two jobs that run. */
const PLAIN: NeedsEdgeData = { from: 'yes', deciding: false, onPath: false, faded: false };

export const NeedsEdge = memo(NeedsEdgeView);
