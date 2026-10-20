import type { Fix } from '@simulci/document';
import { useApp, useSession } from '../app/providers';
import { applyFix } from './dispatch';
import type { Refused } from './types';

/**
 * A refused edit where the author meets it (synthesis § 2.8, § 4.1): its sentence and a button per fix, under the
 * field or the card whose gesture was refused, and in the status line; never a modal. Both show the store's last
 * refusal, which goes when the next edit commits, when a fix is taken, or when the author dismisses it.
 */

const BUTTON =
  'rounded border border-border bg-surface px-2 py-0.5 text-text text-xs hover:bg-chrome focus-visible:outline-2 focus-visible:outline-accent';

/**
 * The refusal under the control whose gesture it answers: shown while the store's last refusal is the one that
 * gesture got (`seq`). The status line says it aloud; this one is not a live region, so it is not read twice.
 */
export function RefusalNote({ seq }: { seq: number | undefined }) {
  const refused = useSession((s) => s.edit.refused);
  if (!refused || refused.seq !== seq) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded border border-might bg-might-soft px-2 py-1.5 text-xs">
      <RefusalView refused={refused} />
    </div>
  );
}

/** The last refusal in the status line, whatever gesture it answered. */
export function RefusalLine() {
  const refused = useSession((s) => s.edit.refused);
  if (!refused) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-text">
      <RefusalView refused={refused} />
    </div>
  );
}

/**
 * A refusal's sentence and its fixes. Taking a fix runs it against the texts the refusal was made on; Dismiss takes
 * the store's refusal away (one shown before any edit, a field's read-only reason, has none to dismiss).
 */
export function RefusalView({ refused, dismiss = true }: { refused: Refused; dismiss?: boolean }) {
  const { store } = useApp();
  const take = (fix: Fix): void => {
    applyFix(store, refused, fix);
  };
  return (
    <>
      <p className="min-w-0 break-words">
        <Sentence text={refused.refusal.message} />
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {refused.refusal.fixes.map((fix) => (
          <button key={`${fix.kind}:${fix.label}`} type="button" className={BUTTON} onClick={() => take(fix)}>
            <Sentence text={fix.label} />
          </button>
        ))}
        {dismiss && (
          <button
            type="button"
            className="rounded px-1.5 text-muted hover:text-text"
            aria-label="Dismiss"
            onClick={() => store.getState().refused(undefined)}
          >
            ×
          </button>
        )}
      </div>
    </>
  );
}

/** A refusal's sentence or a fix's label, its `quoted` parts set as code. */
function Sentence({ text }: { text: string }) {
  const parts = text.split('`');
  // An odd backtick count leaves the last part plain.
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 && i < parts.length - 1 ? (
          <code key={i} className="font-mono">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
