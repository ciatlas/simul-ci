import { useState } from 'react';
import { reportText } from '../state/report';
import { useSession } from './providers';

const HEADLINE = {
  boot: 'The page is out of date or the engine failed to load.',
  engine: 'The simulator failed on this scenario.',
  source: 'The files could not be used.',
  scenario: 'The scenario was refused.',
  assume: 'An assumption was refused.',
  workflow: 'The workflow was not found.',
} as const;

/** One banner for whatever went wrong; the author's own mistakes dismiss themselves on the next edit. */
export function ErrorBanner() {
  const error = useSession((s) => s.error);
  const clearError = useSession((s) => s.clearError);
  const engine = useSession((s) => s.engine);
  const scenario = useSession((s) => s.scenario);
  const assume = useSession((s) => s.assume);
  const files = useSession((s) => s.files.byPath);
  const [copied, setCopied] = useState(false);
  if (!error) return null;

  const report = (): void => {
    navigator.clipboard?.writeText(reportText({ engine, error, scenario, assume, files })).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  const blocking = error.kind === 'boot';
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-start gap-x-4 gap-y-1 border-b px-4 py-2 text-sm ${
        blocking ? 'border-danger bg-danger-soft' : 'border-border bg-might-soft'
      }`}
    >
      <p className="font-medium">{HEADLINE[error.kind]}</p>
      <p className="min-w-0 flex-1 break-words font-mono text-xs">
        {error.issues?.length
          ? error.issues.map((i, n) => (
              <span key={n} className="block">
                {i.path.length ? `${i.path.join('.')}: ` : ''}
                {i.message}
              </span>
            ))
          : error.message}
      </p>
      <div className="flex gap-2">
        {blocking && (
          <button
            type="button"
            className="rounded border border-border bg-surface px-2 py-0.5 text-xs"
            onClick={() => location.reload()}
          >
            Reload
          </button>
        )}
        {error.kind === 'engine' && (
          <button
            type="button"
            className="rounded border border-border bg-surface px-2 py-0.5 text-xs"
            onClick={report}
          >
            {copied ? 'Copied' : 'Copy report'}
          </button>
        )}
        {!blocking && (
          <button
            type="button"
            className="rounded border border-border bg-surface px-2 py-0.5 text-xs"
            onClick={clearError}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
