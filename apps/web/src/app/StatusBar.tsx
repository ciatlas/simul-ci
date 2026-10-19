import type { RunPlan } from '@simulci/engine';
import { useEffect, useState } from 'react';
import { summarize } from '../plan/summary';
import type { Pin } from '../state/store';
import { useSession } from './providers';

/**
 * The sentence the line says, and the key of the element that says it. A polite live region reads a node that comes,
 * or a text that changes: two pins in a row whose sentence is the same change no text, so each pin's sentence comes
 * in an element of its own (`pin-<seq>`). A summary keeps one element, and says only what changed.
 */
interface Line {
  text: string;
  key: string;
}

/** The key of every sentence but a pin's. */
const SUMMARY = 'summary';

/**
 * One sentence per plan, for the eye and the screen reader, half a second behind so bursts read once. The plan that
 * answers a pin says what the pin changed ("pinned; deploy now runs"); every other plan says its summary. While the
 * inputs have changed since the plan, the sentence is set in italics: the top bar says "· stale" in words, and the
 * sentence keeps the contrast of the rest of the line.
 */
export function StatusBar() {
  const plan = useSession((s) => s.plan?.plan);
  const pin = useSession((s) => s.pin);
  const project = useSession((s) => s.project.status);
  const stale = useSession((s) => s.stale);
  const [line, setLine] = useState<Line>({ text: '', key: SUMMARY });

  // Keyed on the plan, not the pin: a pin is answered together with its plan, and one made since says nothing until
  // its own plan comes, so each plan reads one sentence.
  useEffect(() => {
    const next = plan
      ? planLine(plan, pin)
      : { text: project === 'loading' ? 'loading the files…' : '', key: SUMMARY };
    const t = setTimeout(() => setLine(next), 500);
    return () => clearTimeout(t);
  }, [plan, project]);

  return (
    <footer
      aria-live="polite"
      className="flex items-center gap-3 border-border border-t bg-chrome px-4 py-1 text-muted text-xs"
    >
      <span key={line.key} className={stale ? 'italic' : undefined}>
        {line.text}
      </span>
    </footer>
  );
}

/** The pin's sentence for the plan that answered it, in the pin's own element; the summary for any other. */
function planLine(plan: RunPlan, pin: Pin | undefined): Line {
  if (pin?.after?.plan === plan) return { text: pin.after.sentence, key: `pin-${pin.seq}` };
  return { text: summarize(plan).sentence, key: SUMMARY };
}
