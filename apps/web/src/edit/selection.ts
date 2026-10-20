import {
  fingerprint,
  type Fp,
  kindOf,
  unitPathAt,
  type WorkflowDocument,
  type YamlPath,
  yamlPathOf,
} from '@simulci/document';
import type { SelectionRef } from '../state/history';
import type { SessionState, SessionStore } from '../state/store';
import { documents } from './documents';

/**
 * The selection and the text (synthesis § 4.10). The store selects by unit path (`build`, `build.#3`,
 * `test[node=22]`), which the URL carries and a new plan resolves. An op needs the place in the text instead: the
 * selection is mapped through the document of the text now, not through the plan or the Outline, which lag behind the
 * pane's typing. A step op also carries the fingerprint of the step the author saw, read when the gesture starts, so
 * it refuses `moved` rather than land on another step. After an op, the place it selects becomes a unit path of the
 * new text, applied once the plan of that text is in.
 */

/** What a gesture is about, read from the document of the file's text when it starts. */
export interface Target {
  file: string;
  /** The file's revision the target was read at: an op made from it refuses `stale` once the text moved. */
  rev: number;
  /** `[]` for the workflow, `['jobs', id]` for a job, `['jobs', id, 'steps', n]` for a step. */
  path: YamlPath;
  job?: string;
  /** A step's index in its job and the fingerprint of the step the author saw. */
  step?: { index: number; fp: Fp };
}

/**
 * The selection as a place in its file. A leg is its job, whose text it shares; a step of a called workflow or of a
 * composite action is not in this file, and a unit path the text no longer has names nothing: both undefined.
 */
export function targetOf(
  store: SessionStore,
  focus: string | undefined,
  sel: string | undefined,
): Target | undefined {
  const s = store.getState();
  if (focus === undefined) return undefined;
  const doc = documents(store).of(s, focus);
  const rev = s.files.revs[focus];
  if (!doc || rev === undefined) return undefined;
  if (!sel) return { file: focus, rev, path: [] };
  if (sel.includes('/')) return undefined;
  const path = yamlPathOf(doc, sel);
  if (!path) return undefined;
  const job = String(path[1]);
  if (path.length === 2) return { file: focus, rev, path, job };
  const index = Number(path[3]);
  const fp = fingerprint(doc, job, index);
  return fp ? { file: focus, rev, path, job, step: { index, fp } } : undefined;
}

/**
 * Where an op leaves the selection: the unit path of the place it selects, in the text it wrote. A selection that
 * already names that place (a leg of the job an op edited, a step by an index that is still its index) stays as it
 * is; a place outside the workflows (a test file) leaves the selection alone.
 */
export function selectionAfter(
  s: Pick<SessionState, 'focus' | 'sel'>,
  select: { file: string; path: YamlPath },
  doc: WorkflowDocument,
): SelectionRef | undefined {
  if (kindOf(select.file) !== 'workflow') return undefined;
  const sel = unitPathAt(doc, select.path);
  if (s.focus === select.file && sameplace(doc, s.sel, sel))
    return { focus: s.focus, ...(s.sel ? { sel: s.sel } : {}) };
  return { focus: select.file, ...(sel === undefined ? {} : { sel }) };
}

/** Whether two unit paths of a workflow name one place in its text: a leg and its job, say. */
function sameplace(doc: WorkflowDocument, a: string | undefined, b: string | undefined): boolean {
  const [pa, pb] = [placeOf(doc, a), placeOf(doc, b)];
  return pa !== undefined && pb !== undefined && pa.length === pb.length && pa.every((x, i) => x === pb[i]);
}

/** The place in the text a unit path names; none selects the workflow itself, a called workflow's job nothing. */
const placeOf = (doc: WorkflowDocument, sel: string | undefined): YamlPath | undefined =>
  !sel ? [] : sel.includes('/') ? undefined : yamlPathOf(doc, sel);
