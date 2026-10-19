import { useEffect, useState } from 'react';
import { summarize } from '../plan/summary';
import { useSession } from './providers';

/** One sentence per plan, for the eye and the screen reader, half a second behind so bursts read once. */
export function StatusBar() {
  const plan = useSession((s) => s.plan?.plan);
  const project = useSession((s) => s.project.status);
  const stale = useSession((s) => s.stale);
  const [sentence, setSentence] = useState('');

  useEffect(() => {
    const next = plan ? summarize(plan).sentence : project === 'loading' ? 'loading the files…' : '';
    const t = setTimeout(() => setSentence(next), 500);
    return () => clearTimeout(t);
  }, [plan, project]);

  return (
    <footer
      aria-live="polite"
      className="flex items-center gap-3 border-border border-t bg-chrome px-4 py-1 text-muted text-xs"
    >
      <span className={stale ? 'opacity-60' : undefined}>{sentence}</span>
    </footer>
  );
}
