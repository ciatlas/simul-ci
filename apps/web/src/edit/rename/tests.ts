import { type Rename, type Warning, WorkflowDocument } from '@simulci/document';
import { isTestFile } from '../../input/filter';
import { fileLabel } from '../../lib/file-label';
import { namesWorkflow, renamedUnit } from '../../state/renames';

/**
 * The route tests a rename leaves behind (synthesis § 3.3, `tests-name`): a rename edits one workflow only, so the
 * test files that name the old id are counted, not rewritten. A case names it in what it expects of the units
 * (`run`, `skip`, `maybe`, `units`) or in its mocks (`assume`); the file's `given` mocks count once.
 */

/** One warning per open test file of the renamed workflow that names the old id. */
export function testsNaming(byPath: Readonly<Record<string, string>>, rename: Rename): Warning[] {
  return Object.entries(byPath).flatMap(([path, text]) => {
    if (!isTestFile(path)) return [];
    const file = WorkflowDocument.open(text, { path, kind: 'test' }).value();
    const message = isRecord(file) ? naming(path, file, rename) : undefined;
    return message ? [{ code: 'tests-name', message }] : [];
  });
}

/** What a test file of the workflow says names the old id, as a sentence; undefined when nothing does. */
function naming(path: string, file: Record<string, unknown>, rename: Rename): string | undefined {
  if (typeof file.workflow !== 'string' || !namesWorkflow(file.workflow, rename.file)) return undefined;
  const cases = Array.isArray(file.cases) ? file.cases.filter((c) => names(c, rename)).length : 0;
  const given = isRecord(file.given) && mocksName(file.given.assume, rename);
  return cases === 0 && !given ? undefined : sentence(fileLabel(path), cases, given, rename.from);
}

/** "2 cases in ci.test.yml name build", "ci.test.yml's given and 1 case name build"; and that they stay. */
function sentence(label: string, cases: number, given: boolean, id: string): string {
  const counted = cases === 1 ? '1 case' : `${cases} cases`;
  if (!given)
    return `${counted} in ${label} ${cases === 1 ? 'names' : 'name'} ${id}; ${cases === 1 ? 'it is' : 'they are'} not renamed.`;
  if (cases === 0) return `${label}'s given names ${id}; it is not renamed.`;
  return `${label}'s given and ${counted} name ${id}; they are not renamed.`;
}

/** A case whose expectations or mocks name the old id. */
function names(c: unknown, rename: Rename): boolean {
  if (!isRecord(c)) return false;
  const then = isRecord(c.then) ? c.then : {};
  const units = [...entries(then.run), ...entries(then.skip), ...entries(then.maybe)];
  if (isRecord(then.units)) units.push(...Object.keys(then.units));
  return (
    units.some((u) => renamedUnit(u, rename) !== u) || (isRecord(c.when) && mocksName(c.when.assume, rename))
  );
}

/** The unit paths of `run`, `skip` or `maybe`: `- deploy` or `- deploy: if`. */
const entries = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.flatMap((e) => (typeof e === 'string' ? [e] : isRecord(e) ? Object.keys(e) : []))
    : [];

/** Assume entries whose `job` or `step` names the old id. */
const mocksName = (assume: unknown, rename: Rename): boolean =>
  Array.isArray(assume) &&
  assume.some(
    (a) => isRecord(a) && [a.job, a.step].some((p) => typeof p === 'string' && renamedUnit(p, rename) !== p),
  );

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
