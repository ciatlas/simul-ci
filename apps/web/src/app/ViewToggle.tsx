import { useId } from 'react';
import { useSession } from './providers';
import { shownView, useNarrow } from './shortcuts';

const button =
  'px-2 py-1 text-xs text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-surface aria-pressed:text-text';

/**
 * Graph | Text: the view the author picked, kept in the URL (`view`), also switched by `t`. Below 1024 px the text
 * view is the only one: Text shows pressed, Graph is disabled, and a line beside them says why.
 */
export function ViewToggle() {
  const view = useSession((s) => s.ui.view);
  const setView = useSession((s) => s.setView);
  const narrow = useNarrow();
  const shown = shownView(view, narrow);
  const hint = useId();
  return (
    <div role="group" aria-label="View" className="flex items-center gap-2">
      <div className="inline-flex divide-x divide-border overflow-hidden rounded border border-border bg-chrome">
        <button
          type="button"
          className={button}
          aria-pressed={shown === 'graph'}
          aria-keyshortcuts="t"
          aria-describedby={narrow ? hint : undefined}
          disabled={narrow}
          onClick={() => setView('graph')}
        >
          Graph
        </button>
        <button
          type="button"
          className={button}
          aria-pressed={shown === 'text'}
          aria-keyshortcuts="t"
          onClick={() => setView('text')}
        >
          Text
        </button>
      </div>
      {narrow && (
        <span id={hint} className="text-muted text-xs">
          the graph needs 1024 px
        </span>
      )}
    </div>
  );
}
