import type { NodeId } from '@simulci/engine';
import { MARK } from '@simulci/engine/render';
import type { MouseEvent } from 'react';
import { cellAt, cellChars, clip, histogram, legTitle } from '../card';
import { MARK_LABEL } from '../../lib/words';
import { legGrid } from '../size';
import type { LegCell } from '../types';

/**
 * A job's legs as one grid: a cell per leg, its values while they fit (up to 48 legs), a mark and its index above,
 * one histogram row above 512. Each cell's `<title>` names the leg, its verdict, why only the run knows it and its
 * result. A click selects the leg and makes it the one whose steps and callee the card shows.
 */
export function LegGrid({
  legs,
  representative,
  selected,
  onPick,
}: {
  legs: readonly LegCell[];
  representative?: NodeId;
  /** The selected leg, when it is one of these. */
  selected?: NodeId;
  onPick: (leg: NodeId) => void;
}) {
  const g = legGrid(legs.length);
  if (g.histogram) return <Histogram legs={legs} width={g.width} height={g.height} />;
  const chars = cellChars(g);
  return (
    <svg
      className="sc-legs font-mono"
      width={g.width}
      height={g.height}
      role="group"
      aria-label={`${legs.length} legs`}
    >
      {legs.map((leg, i) => {
        const at = cellAt(i, g);
        const pick = (e: MouseEvent): void => {
          e.stopPropagation();
          onPick(leg.id);
        };
        return (
          <g
            key={leg.id}
            data-leg={leg.id}
            data-verdict={leg.verdict}
            data-representative={leg.id === representative ? 'true' : undefined}
            data-selected={leg.id === selected ? 'true' : undefined}
            transform={`translate(${at.x},${at.y})`}
            onClick={pick}
          >
            <title>{legTitle(leg)}</title>
            <rect
              className="sc-cell"
              x="1"
              y="1"
              width={g.cell.width - 2}
              height={g.cell.height - 2}
              rx="3"
            />
            {leg.id === representative && (
              <rect className="sc-rep" x="3" y={g.cell.height - 3} width={g.cell.width - 6} height="1.5" />
            )}
            {g.values ? (
              <text x="4" y={g.cell.height / 2} dominantBaseline="central">
                {clip(leg.label, chars)}
              </text>
            ) : (
              <IndexCell verdict={leg.verdict} index={i + 1} height={g.cell.height} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** A 26 px cell: the mark, then an index of up to three digits in a smaller face. */
function IndexCell({
  verdict,
  index,
  height,
}: {
  verdict: LegCell['verdict'];
  index: number;
  height: number;
}) {
  const cy = height / 2;
  return (
    <>
      <circle className="sc-glyph" data-verdict={verdict} cx="6" cy={cy} r="3" />
      {verdict === 'maybe' && <path className="sc-glyph-half" d={`M6 ${cy - 3} A3 3 0 0 1 6 ${cy + 3} Z`} />}
      <text className="sc-index" x="11" y={cy} dominantBaseline="central">
        {index}
      </text>
    </>
  );
}

function Histogram({ legs, width, height }: { legs: readonly LegCell[]; width: number; height: number }) {
  const parts = histogram(legs);
  const words = parts.map((p) => `${p.n} ${MARK_LABEL[p.verdict]}`).join(', ');
  return (
    <svg
      className="sc-legs font-mono"
      width={width}
      height={height}
      role="img"
      aria-label={`${legs.length.toLocaleString('en')} legs: ${words}`}
    >
      <text x="0" y={height / 2} dominantBaseline="central">
        {parts.map((p) => (
          <tspan key={p.verdict} dx={p.verdict === 'yes' ? 0 : 8}>
            <tspan className="sc-glyph-text" data-verdict={p.verdict}>
              {p.glyph}
            </tspan>{' '}
            {p.n}
          </tspan>
        ))}
      </text>
    </svg>
  );
}

/**
 * The grid's room on a skipped matrix job, which has no legs in the plan: as many empty skipped cells, or the
 * histogram row with every leg skipped. The subline already says skipped and `×count`, so it is not read out.
 */
export function SkippedGrid({ count }: { count: number }) {
  const g = legGrid(count);
  if (g.histogram)
    return (
      <svg className="sc-legs font-mono" width={g.width} height={g.height} aria-hidden="true">
        <text x="0" y={g.height / 2} dominantBaseline="central">
          <tspan className="sc-glyph-text" data-verdict="no">
            {MARK.no}
          </tspan>{' '}
          {count.toLocaleString('en')}
        </text>
      </svg>
    );
  return (
    <svg className="sc-legs" width={g.width} height={g.height} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const at = cellAt(i, g);
        return (
          <g key={i} data-verdict="no" transform={`translate(${at.x},${at.y})`}>
            <rect
              className="sc-cell"
              x="1"
              y="1"
              width={g.cell.width - 2}
              height={g.cell.height - 2}
              rx="3"
            />
          </g>
        );
      })}
    </svg>
  );
}
