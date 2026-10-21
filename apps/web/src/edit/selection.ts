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
import { callsOut } from '../lib/unit-path';
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

export interface TargetOptions {
  /**
   * The author picked the node on the plan (a canvas card), not in the text. A step named by its position is then
   * refused while the plan is older than the file's text: typing in the pane may have put another step at that index
   * (§ 4.10, rule 1). Properties shows the text's own step, so it reads the text as it is.
   */
  planned?: boolean;
}

/**
 * The selection as a place in its file. A leg is its job, whose text it shares; a step of a called workflow or of a
 * composite action is not in this file, and a unit path the text no longer has names nothing: both undefined. The
 * job is matched by its exact id, as the plan's unit paths spell it.
 */
export function targetOf(
  store: SessionStore,
  focus: string | undefined,
  sel: string | undefined,
  options: TargetOptions = {},
): Target | undefined {
  const s = store.getState();
  if (focus === undefined) return undefined;
  const doc = documents(store).of(s, focus);
  const rev = s.files.revs[focus];
  if (!doc || rev === undefined) return undefined;
  if (!sel) return { file: focus, rev, path: [] };
  if (callsOut(sel) || (options.planned && sel.includes('#') && behind(s, focus))) return undefined;
  const path = yamlPathOf(doc, sel);
  if (!path || path[1] !== jobOf(sel)) return undefined;
  const job = jobOf(sel);
  if (path.length === 2) return { file: focus, rev, path, job };
  const index = Number(path[3]);
  const fp = fingerprint(doc, job, index);
  return fp ? { file: focus, rev, path, job, step: { index, fp } } : undefined;
}

/** The plan shown is older than the file's text, or there is none. */
const behind = (s: Pick<SessionState, 'plan' | 'files'>, file: string): boolean =>
  s.plan === undefined || s.plan.for.files < (s.files.revs[file] ?? 0);

/** The job a unit path starts with: `build` of `build[os=a].#2`. */
const jobOf = (sel: string): string => sel.split(/[[.]/)[0]!;

/**
 * Where an op leaves the selection: the unit path of the place it selects, in the text it wrote, as the plan of that
 * text will spell it. A leg of the job it selects stays the leg. The workflow's own keys (`on:`, `name:`) and places
 * outside the workflows (a test file) leave the selection alone; the workflow itself is selected only when an op
 * selects it (a removal with nothing before it).
 */
export function selectionAfter(
  s: Pick<SessionState, 'focus' | 'sel'>,
  select: { file: string; path: YamlPath },
  doc: WorkflowDocument,
): SelectionRef | undefined {
  if (kindOf(select.file) !== 'workflow' || (select.path.length > 0 && select.path[0] !== 'jobs'))
    return undefined;
  const sel = unitPathAt(doc, select.path);
  const leg =
    s.focus === select.file && s.sel !== undefined && sel !== undefined && withoutLegs(s.sel) === sel;
  return { focus: select.file, ...(leg ? { sel: s.sel } : sel === undefined ? {} : { sel }) };
}

const withoutLegs = (sel: string): string => sel.replace(/\[[^\]]*\]/g, '');
