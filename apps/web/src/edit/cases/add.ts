import { type CaseJson, caseFileText, freeCaseName, type WorkflowOp } from '@simulci/document';
import { isTestFile } from '../../input/filter';
import { fileLabel } from '../../lib/file-label';
import type { SessionStore } from '../../state/store';
import { testFilePath } from '../../testcase/case';
import { type Dispatched, dispatch } from '../dispatch';
import { type DocumentSource, type Documents, documents } from '../documents';

/**
 * Adding a generated case to the repository (synthesis § 4.9): where the case dialog puts it (its destination), the op
 * that writes it there, and what the page shows once it is written.
 */

/**
 * Where a workflow's case goes: added to a loaded route test (its revision as read, how many cases it has and their
 * names, and its `given` as JSON text, which `simulci test` merges into every case there), or a new file.
 */
export type Placement =
  | { kind: 'add'; path: string; rev: number | undefined; cases: number; names: string[]; given?: string }
  | { kind: 'create'; path: string };

/** A workflow as a test file's `workflow:` names it: `ci.yml` and `.github/workflows/ci.yml` are one. */
const shortName = (workflow: string): string => workflow.replace(/^\.github\/workflows\//, '');

/** The cases of a test file's document, as its value holds them. */
function casesOf(docs: Documents, s: DocumentSource, path: string): unknown[] {
  const cases = docs.of(s, path)?.get(['cases'])?.value;
  return Array.isArray(cases) ? cases : [];
}

/**
 * The workflow's own test file, `.github/simulci/tests/<stem>.test.yml`, when it is loaded; else the first loaded
 * route test, by path, whose `workflow:` names the workflow; else the own file, created. The own file is taken
 * whatever it tests: one testing another workflow refuses the case (`other-workflow`), and the refusal offers the
 * file beside it, so the author sees why the case went elsewhere.
 */
export function placementOf(s: DocumentSource, docs: Documents, workflow: string): Placement {
  const own = testFilePath(workflow);
  const tests = (path: string): boolean => {
    const named = docs.of(s, path)?.get(['workflow'])?.value;
    return typeof named === 'string' && shortName(named) === shortName(workflow);
  };
  const path = Object.hasOwn(s.files.byPath, own)
    ? own
    : Object.keys(s.files.byPath)
        .filter(isTestFile)
        .sort((a, b) => a.localeCompare(b))
        .find(tests);
  if (path === undefined) return { kind: 'create', path: own };
  const doc = docs.of(s, path);
  const cases = casesOf(docs, s, path);
  const names = cases.flatMap((c) => {
    const name = typeof c === 'object' && c !== null ? (c as { name?: unknown }).name : undefined;
    return typeof name === 'string' ? [name] : [];
  });
  const given = doc?.get(['given'])?.value;
  const to: Placement = { kind: 'add', path, rev: s.files.revs[path], cases: cases.length, names };
  return typeof given === 'object' && given !== null ? { ...to, given: JSON.stringify(given) } : to;
}

/** The name the case is written under: a name the file already has gets ` (2)`, as `addCase` writes it. */
export const nameIn = (to: Placement, name: string): string =>
  to.kind === 'add' ? freeCaseName(name, to.names) : name;

/**
 * The op that writes the case: `addCase` into a loaded file, else `createFile` with the one-case file `addCase` would
 * write into an empty one, in the workflow's line endings.
 */
function caseOp(
  s: Pick<DocumentSource, 'files'>,
  to: Placement,
  workflow: string,
  testCase: CaseJson,
): WorkflowOp {
  if (to.kind === 'add') return { op: 'addCase', file: to.path, workflow, testCase };
  const eol = s.files.meta[workflow]?.eol === 'crlf' ? '\r\n' : '\n';
  return {
    op: 'createFile',
    file: to.path,
    text: caseFileText(to.path, shortName(workflow), testCase, eol),
  };
}

/**
 * Writes the case where it goes, as one undoable entry named for it, planned against the revision the destination
 * was read at; then shows it. A refusal comes back with its fixes (`other-workflow`: the file beside it).
 */
export function addTestCase(
  store: SessionStore,
  to: Placement,
  workflow: string,
  testCase: CaseJson,
): Dispatched {
  const s = store.getState();
  const named = { ...testCase, name: nameIn(to, testCase.name) };
  const result = dispatch(store, caseOp(s, to, workflow, named), {
    revs: to.kind === 'add' && to.rev !== undefined ? { [to.path]: to.rev } : {},
    label: `Added test case '${named.name}'`,
    keepSelection: true,
  });
  if (result.ok && result.changed) showAdded(store);
  return result;
}

/**
 * The case the newest entry added, shown: edit mode on, so it can be undone, changed and saved; the pane on its file
 * at its first line; and a notice that names it and offers Undo. Also after a refusal's fix wrote it elsewhere.
 */
export function showAdded(store: SessionStore): void {
  const s = store.getState();
  const entry = s.edit.past.at(-1);
  const path = entry?.files.map((f) => f.path).find(isTestFile);
  if (!entry || path === undefined) return;
  const cases = casesOf(documents(store), s, path);
  const last = cases.at(-1) as { name?: unknown } | undefined;
  const line = cases.length
    ? documents(store)
        .of(s, path)
        ?.lineOf(['cases', cases.length - 1])
    : undefined;
  s.setEdit(true);
  s.revealLine({ file: path, line: line ?? 1 });
  const name = typeof last?.name === 'string' ? `test case '${last.name}'` : 'a test case';
  s.notify(`Added ${name} to ${fileLabel(path)}`, entry);
}
