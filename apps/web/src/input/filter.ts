/**
 * Which files of a checkout the engine takes, as `@simulci/node`'s `readWorkflowFiles` decides it: workflows are the
 * direct children of `.github/workflows` ending in `.yml` or `.yaml` (any case), actions are every `action.yml` or
 * `action.yaml` under `.github/actions` (any case) and a root `action.yml` or `action.yaml` (exact). A test proves the
 * two agree over the routes lab and a synthetic tree.
 */

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const ACTION = /^\.github\/actions\/(?:[^/]+\/)*action\.ya?ml$/i;
const ROOT_ACTION = /^action\.ya?ml$/;

/** A repository-relative path with forward slashes and no leading `./`. */
export function normalizePath(path: string): string {
  let p = path.split('\\').join('/');
  while (p.startsWith('./')) p = p.slice(2);
  return p.startsWith('/') ? p.slice(1) : p;
}

export function isProjectFile(path: string): boolean {
  const p = normalizePath(path);
  return WORKFLOW.test(p) || ACTION.test(p) || ROOT_ACTION.test(p);
}

/** Keeps the files the engine takes, by normalized path. */
export function filterFiles(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    const p = normalizePath(path);
    if (isProjectFile(p)) out[p] = text;
  }
  return out;
}

/** The directories a folder walk has to enter: nothing else can hold a project file. */
const PROJECT_DIRS = ['.github/workflows', '.github/actions'] as const;

/** Whether a directory at this relative path may hold project files, so a walk can skip the rest of a checkout. */
export function mayHoldProjectFiles(dir: string): boolean {
  const d = normalizePath(dir);
  if (d === '' || d === '.github') return true;
  return PROJECT_DIRS.some((p) => d === p || d.startsWith(`${p}/`));
}
