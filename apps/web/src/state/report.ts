import type { AssumeEntry, ScenarioInput } from '@simulci/engine';
import { PROTOCOL } from '../worker/protocol';
import type { SessionError, SessionState } from './store';

/** What an engine failure report holds: versions, the error, the inputs, the file names and sizes, never contents. */
export function reportText(s: {
  engine: SessionState['engine'];
  error: SessionError;
  scenario: ScenarioInput;
  assume: AssumeEntry[];
  files: Record<string, string>;
}): string {
  return [
    `simulci web: engine ${s.engine.version ?? '?'}, protocol ${PROTOCOL}, restarts ${s.engine.restarts}`,
    `error: ${s.error.kind}: ${s.error.message}`,
    s.error.stack ?? '',
    `scenario: ${JSON.stringify(s.scenario)}`,
    `assume: ${JSON.stringify(s.assume)}`,
    `files: ${Object.entries(s.files)
      .map(([p, t]) => `${p} (${t.length} chars)`)
      .join(', ')}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The errors a report is offered for: the engine threw, or it stopped and could not be restarted. */
export function reportable(error: SessionError): boolean {
  return error.kind === 'engine' || error.kind === 'stopped';
}
