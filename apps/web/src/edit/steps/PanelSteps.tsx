import { unitPathAt, type WorkflowDocument } from '@simulci/document';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/providers';
import { SectionTitle } from '../../panels/kit';
import { hostUi } from '../canvas/ui';
import { gestures } from '../gestures';
import { moveStep, removeStep, stepTarget } from './actions';
import { DragHandle, InsertGap, useStepDrag } from './rows';

/**
 * A job's steps in Properties (synthesis § 4.4), read from the text now, so they are there for a job the plan skips
 * (whose card draws no step list): a row selects its step; + between rows and + Add step open the palette there; a
 * row's handle drags it to another place; on a focused row Alt+↑/↓ move it, keeping the focus on it, and Delete
 * removes it. The job stays selected, so the list stays where the author works.
 */
export function PanelSteps({
  doc,
  file,
  job,
  locked,
}: {
  doc: WorkflowDocument;
  file: string;
  job: string;
  locked: boolean;
}) {
  const { store } = useApp();
  const steps = doc.jobs().find((j) => j.id === job)?.steps ?? [];
  const list = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState<number>();
  useEffect(() => {
    if (follow === undefined) return;
    const active = document.activeElement;
    if (active === document.body || list.current?.contains(active))
      list.current?.querySelector<HTMLElement>(`[data-row="${follow}"] [data-step-name]`)?.focus();
    setFollow(undefined);
  }, [doc]);
  const keep = { keepSelection: true };
  const move = (from: number, to: number): void => {
    const target = stepTarget(store, file, job, from);
    const ui = hostUi.of(store);
    if (target && ui && moveStep(store, ui, target, to, keep)) setFollow(to);
  };
  const remove = (index: number): void => {
    const target = stepTarget(store, file, job, index);
    const ui = hostUi.of(store);
    if (target && ui && removeStep(store, ui, target, keep)) setFollow(Math.max(0, index - 1));
  };
  const insert = (index: number): void => void gestures.of(store)?.palette({ job, index });
  const drag = useStepDrag(move);
  // F2 on a row renames that step's id, as its other keys act on it while the job stays selected.
  const rename = (index: number, at: Element): boolean => {
    const target = stepTarget(store, file, job, index);
    const ui = hostUi.of(store);
    if (!target || !ui) return false;
    ui.open({ kind: 'rename', target, anchor: at });
    return true;
  };
  const onKeyDown = (index: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const by = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
    if (e.altKey && by !== 0) {
      e.preventDefault();
      move(index, index + by);
    } else if (plain && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      remove(index);
    } else if (plain && !e.shiftKey && e.key === 'F2' && rename(index, e.currentTarget)) e.preventDefault();
  };
  return (
    <section className="flex flex-col gap-1" aria-label="Steps">
      <SectionTitle>Steps</SectionTitle>
      <ol ref={list} className="sc-step-rows flex flex-col">
        {steps.map((step) => (
          <li
            key={step.index}
            data-row={step.index}
            className="sc-step-row"
            {...(locked ? {} : drag.target(step.index))}
          >
            <button
              type="button"
              data-step-name
              className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-sm hover:bg-chrome"
              aria-keyshortcuts={locked ? undefined : 'Alt+ArrowUp Alt+ArrowDown Delete F2'}
              onClick={() =>
                store.getState().select(file, unitPathAt(doc, ['jobs', job, 'steps', step.index]))
              }
              onKeyDown={locked ? undefined : onKeyDown(step.index)}
            >
              <span className="mr-1.5 font-mono text-muted text-xs">{step.index + 1}</span>
              {step.name ?? step.uses ?? step.runHead ?? `step ${step.index + 1}`}
            </button>
            {/* After the name in the DOM, so the row's first control is the step; the handle shows at the left. */}
            {!locked && <DragHandle {...drag.handle(step.index)} />}
            {!locked && (
              <InsertGap
                label={`Add a step before step ${step.index + 1}`}
                onInsert={() => insert(step.index)}
              />
            )}
          </li>
        ))}
      </ol>
      {!locked && (
        <>
          <button
            type="button"
            className="self-start rounded border border-border px-2 py-0.5 text-xs hover:bg-chrome"
            aria-keyshortcuts="S"
            onClick={() => insert(steps.length)}
          >
            + Add step
          </button>
          {steps.length > 1 && (
            <p className="text-muted text-xs">
              Drag a step, or Alt+↑ and Alt+↓ on it, to move it; Delete removes it; F2 renames its id.
            </p>
          )}
        </>
      )}
    </section>
  );
}
