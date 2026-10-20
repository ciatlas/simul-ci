import { type FormEvent, useId, useMemo, useState } from 'react';
import { useApp, useSession } from '../../app/providers';
import { newestOutline } from '../../state/store';
import { documents } from '../documents';
import { RefusalNote } from '../Refusal';
import { addJob, checkoutOf, type GestureUi, idProblem, offeredId, type Open, runsOnFor } from './actions';
import { AnchoredPopover } from './Popover';

const INPUT = 'w-full rounded border border-border bg-bg px-2 py-1 font-mono text-text text-xs';
const BUTTON = 'rounded border border-border px-2 py-1 text-xs hover:bg-chrome';

/**
 * Add job (synthesis § 4.2), at the card it follows or the workflow's frame: an id offered free, the runner of the job
 * it follows, that job as its need, and a first step that checks the repository out, at the ref the repository uses.
 * Enter adds it; the new card is selected and takes the focus once it is drawn. An id that is not one, or is taken,
 * is said under the field before anything is written.
 */
export function AddJobPopover({
  open,
  ui,
  onClose,
}: {
  open: Extract<Open, { kind: 'addJob' }>;
  ui: GestureUi;
  onClose: () => void;
}) {
  const { store } = useApp();
  // The text the gesture read: an op made from this form refuses `stale` once it moved.
  const [doc] = useState(() => documents(store).of(store.getState(), open.file));
  const outline = useSession(newestOutline);
  const jobs = useMemo(() => doc?.jobs().map((j) => j.id) ?? [], [doc]);
  const [id, setId] = useState(() => (doc ? offeredId(doc) : 'job'));
  const [runsOn, setRunsOn] = useState(() => (doc ? runsOnFor(doc, open.after) : 'ubuntu-latest'));
  const [needs, setNeeds] = useState<string[]>(open.after === undefined ? [] : [open.after]);
  const [checkout, setCheckout] = useState(true);
  const ref = useMemo(() => checkoutOf(outline), [outline]);
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const problem = idProblem(id.trim(), jobs);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (problem) return;
    const form = { id: id.trim(), runsOn, needs, ...(open.after === undefined ? {} : { after: open.after }) };
    const result = addJob(store, ui, open, checkout ? { ...form, checkout: ref } : form);
    if (result.ok) onClose();
    else setRefusedSeq(result.refused.seq);
  };
  const title = open.after === undefined ? 'Add a job' : `Add a job after ${open.after}`;
  return (
    <AnchoredPopover anchor={open.anchor} side="right" label={title} onClose={onClose} className="w-72">
      <form className="flex flex-col gap-2.5" onSubmit={submit}>
        <h2 className="font-semibold text-sm">{title}</h2>
        <IdField id={id} problem={problem} onChange={setId} />
        <label className="flex flex-col gap-1">
          <span className="text-muted">Runs on</span>
          <input
            className={INPUT}
            value={runsOn}
            spellCheck={false}
            onChange={(e) => setRunsOn(e.target.value)}
          />
        </label>
        <NeedsChoice jobs={jobs} needs={needs} onChange={setNeeds} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />
          <span>
            Start with Checkout <code className="font-mono text-muted">{ref}</code>
          </span>
        </label>
        <RefusalNote seq={refusedSeq} />
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={`${BUTTON} border-accent bg-accent text-on-accent hover:bg-accent`}
            aria-disabled={problem !== undefined}
          >
            Add job
          </button>
        </div>
      </form>
    </AnchoredPopover>
  );
}

/** The id, its text selected when the popover opens so typing replaces it, and why it cannot be one. */
function IdField({
  id,
  problem,
  onChange,
}: {
  id: string;
  problem?: string;
  onChange: (id: string) => void;
}) {
  const ids = useId();
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-muted">Id</span>
        <input
          data-autofocus
          className={INPUT}
          value={id}
          spellCheck={false}
          aria-invalid={problem !== undefined}
          aria-describedby={problem ? `${ids}-id` : undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {problem && (
        <p id={`${ids}-id`} className="text-danger">
          {problem}
        </p>
      )}
    </>
  );
}

/** A checkbox for each job of the file: what the new job needs. */
function NeedsChoice({
  jobs,
  needs,
  onChange,
}: {
  jobs: readonly string[];
  needs: readonly string[];
  onChange: (needs: string[]) => void;
}) {
  if (jobs.length === 0) return null;
  const toggle = (job: string, on: boolean): void =>
    onChange(on ? [...needs, job] : needs.filter((x) => x !== job));
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-muted">Needs</legend>
      <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
        {jobs.map((job) => (
          <label key={job} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={needs.includes(job)}
              onChange={(e) => toggle(job, e.target.checked)}
            />
            <span className="font-mono">{job}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
