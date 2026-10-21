import type { Prefs } from '../state/prefs';
import type { SessionActions, SessionState } from '../state/store';

/** A pane the author opens and closes: the scenario column, the right panel, the YAML pane. */
export type Pane = keyof Prefs['collapsed'];

/**
 * Opens or closes a pane (`data-pane` in app/SimulateView.tsx). A pane that closes with the focus inside it first
 * hands the focus to the plan (`data-plan`), so the focus never drops to the page's body.
 */
export function togglePaneKeepingFocus(
  s: Pick<SessionState, 'ui'> & Pick<SessionActions, 'togglePane'>,
  pane: Pane,
  doc: Document = document,
): void {
  const open = !s.ui.prefs.collapsed[pane];
  if (open && doc.querySelector(`[data-pane="${pane}"]`)?.contains(doc.activeElement)) {
    doc.querySelector<HTMLElement>('[data-plan]')?.focus();
  }
  s.togglePane(pane);
}
