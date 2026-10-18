import { useSession } from '../app/providers';

const MARK_CLASS: Record<string, string> = { '●': 'text-run', '○': 'text-skip', '◐': 'text-might' };

/** The plan as `simulci plan` prints it, the marks coloured by run state; dimmed while the inputs are ahead of it. */
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
  return (
    <pre
      className={`overflow-x-auto p-4 font-mono text-[13px] leading-5 whitespace-pre ${stale ? 'opacity-60' : ''}`}
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
