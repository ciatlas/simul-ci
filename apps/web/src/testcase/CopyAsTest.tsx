import { useEffect } from 'react';
import { useSession } from '../app/providers';
import { heldSentence } from '../engine/hold';
import { caseAvailability } from './case';
import { CaseDialog } from './CaseDialog';

/**
 * The top bar's Copy as test case: enabled with a plan and a focused depth-0 workflow, and not while the plan waits
 * for valid YAML, which its title then says. It opens the case dialog (so does the `c` key), which stays while the
 * store says it is open. Files dropped behind the open dialog take the plan away: the dialog closes with it rather
 * than offer a case for files no longer loaded. The same files loaded again keep the plan, and the dialog, which asks
 * again once they are. The button names its key only while the page keys are on.
 */
export function CopyAsTest() {
  const available = useSession((s) => caseAvailability(s).ok);
  // The one reason the author can act on: the plan waits for valid YAML (synthesis § 7.2).
  const waits = useSession((s) => (s.project.held ? heldSentence(s.project.held) : undefined));
  const planned = useSession((s) => s.plan !== undefined);
  const open = useSession((s) => s.caseOpen);
  const keys = useSession((s) => s.ui.prefs.keys);
  const openCase = useSession((s) => s.openCase);
  const closeCase = useSession((s) => s.closeCase);
  useEffect(() => {
    if (open && !planned) closeCase();
  }, [open, planned, closeCase]);
  return (
    <>
      <button
        type="button"
        className="rounded border border-border bg-surface px-2 py-1 text-text hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!available}
        title={waits}
        aria-keyshortcuts={keys ? 'c' : undefined}
        onClick={openCase}
      >
        Copy as test case
      </button>
      {open && planned && <CaseDialog />}
    </>
  );
}
