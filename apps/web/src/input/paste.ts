import { isProjectFile, normalizePath } from './filter';
import { LIMITS } from './limits';

/** Where a pasted workflow goes unless the author says otherwise. */
export const DEFAULT_PASTE_PATH = '.github/workflows/pasted.yml';

export type PasteCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A pasted buffer is a file at a path the engine takes. A route-test file is refused: tests run in the CLI, and a
 * `cases:` document under `.github/workflows` would only be reported as not a workflow.
 */
export function checkPaste(rawPath: string, text: string): PasteCheck {
  const path = normalizePath(rawPath.trim() || DEFAULT_PASTE_PATH);
  if (!isProjectFile(path))
    return {
      ok: false,
      reason: `${path} is not a path the engine reads: use .github/workflows/<name>.yml, .github/actions/<name>/action.yml or action.yml`,
    };
  if (text.trim() === '') return { ok: false, reason: 'nothing to paste' };
  if (text.length > LIMITS.fileBytes) return { ok: false, reason: 'a file may be at most 2 MB' };
  if (/^cases:\s*(#.*)?$/m.test(text) && !/^jobs:\s*(#.*)?$/m.test(text))
    return { ok: false, reason: 'route tests run in the CLI (simulci test); paste a workflow' };
  return { ok: true, path };
}

/** A name for the next pasted file that no buffer uses yet. */
export function nextPastePath(taken: Iterable<string>): string {
  const set = new Set(Array.from(taken, normalizePath));
  if (!set.has(DEFAULT_PASTE_PATH)) return DEFAULT_PASTE_PATH;
  for (let i = 2; ; i++) {
    const candidate = `.github/workflows/pasted-${i}.yml`;
    if (!set.has(candidate)) return candidate;
  }
}
