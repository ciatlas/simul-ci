import { useSession } from '../app/providers';

const MARK_CLASS: Record<string, string> = { '●': 'text-run', '○': 'text-skip', '◐': 'text-might' };

/**
 * The plan as `simulci plan` prints it, the marks coloured by run state. While the inputs are ahead of it (a refused
 * input keeps the last good plan) a dashed rule runs down its left edge; the text is not faded, so it keeps 4.5:1.
 */
export function TextView() {
  const text = useSession((s) => s.plan?.text);
  const stale = useSession((s) => s.stale);
  const project = useSession((s) => s.project.status);

  if (text === undefined)
    return (
      <p className="p-4 text-muted">
        {project === 'loading' ? 'Loading the files…' : project === 'error' ? 'No plan.' : 'Simulating…'}
      </p>
    );
  // A tab stop, so the keys scroll it: sideways here, and down through the section around it, since nothing in the
  // text takes the focus (WCAG 2.1.1). It fills that section, so its ring is drawn inside it (`focus-inset`). The
  // left border is always there, transparent while the plan is current, so the text does not move when it shows.
  return (
    <pre
      tabIndex={0}
      className={`focus-inset overflow-x-auto border-l-2 border-dashed p-4 font-mono text-[13px] leading-5 whitespace-pre ${stale ? 'border-border-strong' : 'border-transparent'}`}
      aria-label="The plan"
    >
      {text.split('\n').map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </pre>
  );
}

function Line({ line }: { line: string }) {
  const at = line.search(/[●○◐]/);
  if (at === -1) return <span className="block">{line}</span>;
  const mark = line[at]!;
  return (
    <span className="block">
      {line.slice(0, at)}
      <span className={MARK_CLASS[mark]} aria-hidden="true">
        {mark}
      </span>
      {line.slice(at + 1)}
    </span>
  );
}
