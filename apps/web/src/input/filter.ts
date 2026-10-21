/**
 * Which files of a checkout the page takes, as `@simulci/node` decides it. The engine's project files, as
 * `readWorkflowFiles` reads them: workflows are the direct children of `.github/workflows` ending in `.yml` or `.yaml`
 * (any case), actions are every `action.yml` or `action.yaml` under `.github/actions` (any case) and a root
 * `action.yml` or `action.yaml` (exact). Route tests, as `discoverTests` finds them: every `*.test.yml` or
 * `*.test.yaml` (exact case) under `.github/simulci/tests`, at any depth, but none under a `__snapshots__` directory.
 * Tests never reach the engine's project; the page keeps them beside it, to add cases to and save. A test proves the
 * filter and the two agree over the routes lab, this repository and a synthetic tree.
 */

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const ACTION = /^\.github\/actions\/(?:[^/]+\/)*action\.ya?ml$/i;
const ROOT_ACTION = /^action\.ya?ml$/;
const TESTS_DIR = '.github/simulci/tests';
const TEST = /^\.github\/simulci\/tests\/(?:[^/]+\/)*[^/]*\.test\.ya?ml$/;
const SNAPSHOTS = /(?:^|\/)__snapshots__(?:\/|$)/;

/** A repository-relative path with forward slashes and no leading `./`. */
export function normalizePath(path: string): string {
  let p = path.split('\\').join('/');
  while (p.startsWith('./')) p = p.slice(2);
  return p.startsWith('/') ? p.slice(1) : p;
}

/** A file the engine loads: a workflow or an action. */
export function isProjectFile(path: string): boolean {
  const p = normalizePath(path);
  return WORKFLOW.test(p) || ACTION.test(p) || ROOT_ACTION.test(p);
}

/** A route test `simulci test` runs. */
export function isTestFile(path: string): boolean {
  const p = normalizePath(path);
  return TEST.test(p) && !SNAPSHOTS.test(p);
}

/** A file the page keeps: a project file or a route test. */
export const isKeptFile = (path: string): boolean => isProjectFile(path) || isTestFile(path);

/** Keeps the files the page takes, by normalized path. */
export function filterFiles(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    const p = normalizePath(path);
    if (isKeptFile(p)) out[p] = text;
  }
  return out;
}

/** The directories a folder walk has to enter: nothing else can hold a file the page keeps. */
const KEPT_DIRS = ['.github/workflows', '.github/actions', TESTS_DIR] as const;

/**
 * Whether a directory at this relative path may hold a file the page keeps, so a walk can skip the rest of a checkout
 * (and the tests' snapshots).
 */
export function mayHoldProjectFiles(dir: string): boolean {
  const d = normalizePath(dir);
  if (d === '' || d === '.github' || d === '.github/simulci') return true;
  if (SNAPSHOTS.test(d)) return false;
  return KEPT_DIRS.some((p) => d === p || d.startsWith(`${p}/`));
}
