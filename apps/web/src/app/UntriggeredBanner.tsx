import { useMemo } from 'react';
import { withEvent } from '../scenario/form';
import { useSession } from './providers';
import { untriggeredNote } from './untriggered';

const button = 'rounded border border-border bg-surface px-2 py-0.5 text-xs hover:border-border-strong';

/**
 * Over the plan in edit mode, while the focused workflow is not triggered and the canvas draws its jobs dimmed
 * anyway: why it does not run, and a button that simulates another of its events, as the form's Event field would.
 */
export function UntriggeredBanner() {
  const editing = useSession((s) => s.edit.on);
  const plan = useSession((s) => s.plan);
  const focus = useSession((s) => s.focus);
  const outline = useSession((s) => s.project.outline);
  const scenario = useSession((s) => s.scenario);
  const setScenario = useSession((s) => s.setScenario);
  const note = useMemo(
    () => (editing ? untriggeredNote(plan, focus, outline, scenario) : undefined),
    [editing, plan, focus, outline, scenario],
  );
  if (!note) return null;
  const { instead } = note;
  return (
    <div
      role="status"
      data-untriggered
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-b bg-chrome px-4 py-1.5 text-sm"
    >
      <p className="min-w-0 flex-1">
        Not triggered by {note.by}
        {note.clause !== undefined && (
          <>
            {' ('}
            <span className="font-mono text-xs">{note.clause}</span>)
          </>
        )}
        . Showing its jobs as they would be planned.
      </p>
      {instead !== undefined && (
        <button type="button" className={button} onClick={() => setScenario(withEvent(scenario, instead))}>
          Simulate {instead} instead
        </button>
      )}
    </div>
  );
}
