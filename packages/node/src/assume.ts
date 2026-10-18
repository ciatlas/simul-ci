import { type AssumeEntry, AssumeListSchema } from '@simulci/engine';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * `--assume` entries from the command line: `build.unit=failure`, `build.unit.outputs.sha=abc123`,
 * `deploy.#1.env.TARGET=prod`, `build.cache=as:hit`, or a YAML mapping (`'{ uses: actions/cache, as: miss }'`).
 * `--assume-file` is a YAML list of entries as a test file writes them.
 */

export class AssumeError extends Error {
  override name = 'AssumeError';
}

export function parseAssume(items: string[], fileText?: string): AssumeEntry[] {
  const entries: unknown[] = items.map(parseOne);
  if (fileText !== undefined) {
    const list: unknown = parse(fileText);
    if (!Array.isArray(list)) throw new AssumeError('an assume file is a YAML list of entries');
    entries.push(...list);
  }
  const checked = AssumeListSchema.safeParse(entries);
  if (!checked.success) throw new AssumeError(`invalid assume entries:\n${z.prettifyError(checked.error)}`);
  return checked.data;
}

function parseOne(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return parse(trimmed);
  const eq = trimmed.indexOf('=');
  if (eq === -1)
    throw new AssumeError(
      `'${text}' is not <unit>=<outcome>, <unit>.outputs.<name>=<value> or a YAML mapping`,
    );
  const left = trimmed.slice(0, eq);
  const value = trimmed.slice(eq + 1);
  const field = /^(.+)\.(outputs|env)\.([^.=]+)$/.exec(left);
  if (field) return { step: field[1], [field[2]!]: { [field[3]!]: value } };
  if (value.startsWith('as:')) return { ...unitOf(left), as: value.slice(3) };
  return { ...unitOf(left), outcome: value };
}

/** A path with a step names a step; a bare job id names the job. */
function unitOf(path: string): { step: string } | { job: string } {
  const last = path.split('/').at(-1)!;
  return /\.[^[\]]*$/.test(last.replace(/\[[^\]]*\]/g, '')) ? { step: path } : { job: path };
}
