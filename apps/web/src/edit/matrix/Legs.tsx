import type { JobPlan } from '@simulci/engine';
import { useMemo } from 'react';
import { useApp, useSession } from '../../app/providers';
import { cardActions } from '../../graph/card';
import { legCells } from '../../graph/model';
import { LegGrid, SkippedGrid } from '../../graph/nodes/LegGrid';
import { useSelected } from '../../panels/kit';
import { planNodes } from '../../plan/nodes';
import type { PlanState } from '../../state/store';
import { legLimit, legLine } from './model';

/**
 * The matrix's legs as the plan has them (synthesis § 4.7): the line that counts them by verdict, the card's leg grid
 * (a click picks a leg, as on the card), and the `matrix-limit` warning past 256 legs. They come from the plan's
 * `MatrixPlan` and legs, never from expanding the matrix on the page, so they say "(as of the last plan)" until the
 * plan of the text now is in.
 */
export function Legs({ file, job }: { file: string; job: string }) {
  const plan = useSession((s) => s.plan);
  const behind = useSession((s) => s.stale !== false);
  const planned = jobPlanOf(plan, file, job);
  const line = planned && legLine(planned);
  if (!planned || line === undefined) return null;
  const limit = legLimit(planned);
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-legs>
      <p className="text-xs" data-leg-line>
        {line}
        {behind && <span className="text-muted"> (as of the last plan)</span>}
      </p>
      <Grid job={planned} />
      {limit && (
        <p className="text-might-text text-xs" data-warning="matrix-limit">
          {limit}
        </p>
      )}
    </div>
  );
}

/** The job as the plan has it: a job of the workflow at `file`, by its exact id. */
function jobPlanOf(plan: PlanState | undefined, file: string, job: string): JobPlan | undefined {
  const node = plan && planNodes(plan.plan).get(`${file}#${job}`);
  return node?.kind === 'job' ? node.job : undefined;
}

/** The card's grid: a cell per leg, the selected one marked; a skipped job's legs as skipped cells. */
function Grid({ job }: { job: JobPlan }) {
  const { store } = useApp();
  const selected = useSelected()?.node;
  const representative = useSession((s) => s.ui.representative[job.id]);
  const act = useMemo(() => cardActions(store), [store]);
  const cells = legCells(job);
  const count = job.matrix?.count ?? 0;
  if (!cells) return count > 0 ? <SkippedGrid count={count} /> : null;
  const picked = cells.find((cell) => cell.id === selected);
  return (
    <div className="overflow-x-auto">
      <LegGrid
        legs={cells}
        representative={representative ?? cells[0]?.id}
        {...(picked ? { selected: picked.id } : {})}
        onPick={act.select}
      />
    </div>
  );
}
