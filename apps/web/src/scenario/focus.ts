import type { FieldFocus } from '../state/store';

/**
 * Where a focus request lands (`FieldFocus`, which a pin or a reason's Set … button makes): the field that shows its
 * path, the part of the field's text the focus selects so the author types over the example, and the frames the
 * form waits for the field to show. The form (app/ScenarioForm.tsx) finds the control by its `data-field`.
 */

/** How many frames the form waits for a field to show: Advanced mounts its rows after it opens. */
export const FOCUS_FRAMES = 10;

/**
 * The field that shows a request's path, as `deriveForm` routes the worker's issues: the path's own field, else the
 * field of its key (`workflow_run.name` is the Triggering workflow); none when the form shows neither.
 */
export function resolveField(
  focus: Pick<FieldFocus, 'path'>,
  fields: ReadonlyMap<string, string>,
): string | undefined {
  const own = fields.get(focus.path);
  if (own !== undefined) return own;
  const at = focus.path.indexOf('.');
  return at === -1 ? undefined : fields.get(focus.path.slice(0, at));
}

/** A focus request resolved to the field that shows it. */
export interface FieldRequest {
  field: string;
  seq: number;
}

/** The field a request asks for, with its `seq`; none without a request, or when the form shows no field for it. */
export function requestedField(
  focus: FieldFocus | undefined,
  fields: ReadonlyMap<string, string>,
): FieldRequest | undefined {
  if (!focus) return undefined;
  const field = resolveField(focus, fields);
  return field === undefined ? undefined : { field, seq: focus.seq };
}

/**
 * The request a closed group opens for: one that asks for a field the group holds and that it has not opened for
 * (`opened`, the `seq` of the last one), so each request opens it once and the author can close it again.
 */
export function opensFor(
  request: FieldRequest | undefined,
  held: readonly string[],
  opened: number | undefined,
): number | undefined {
  if (!request || request.seq === opened || !held.includes(request.field)) return undefined;
  return request.seq;
}

/** The fields written as `name=value` lines, whose entry's value the focus selects. */
const ENTRY_FIELDS = new Set(['vars']);

/**
 * The range of a field's text the focus selects: an entry's value in a field written as `name=value` lines (a caret
 * right after `=` when the value is empty, the caret at the end when no line names the entry), the whole text in any
 * other; none for a control that holds no text (`textOf`).
 */
export function selectionFor(
  field: string,
  entry: string | undefined,
  value: string | undefined,
): [start: number, end: number] | undefined {
  if (value === undefined) return undefined;
  if (entry === undefined || !ENTRY_FIELDS.has(field)) return [0, value.length];
  return entryRange(value, entry) ?? [value.length, value.length];
}

/** The value of the last line naming the entry, the one `parseVars` keeps. */
function entryRange(text: string, entry: string): [number, number] | undefined {
  let found: [number, number] | undefined;
  let offset = 0;
  for (const line of text.split('\n')) {
    const range = valueRange(line, entry);
    if (range) found = [offset + range[0], offset + range[1]];
    offset += line.length + 1;
  }
  return found;
}

/**
 * Where a line naming the entry holds its value: after `=`, without the spaces around it (a caret right after `=`
 * when it is empty); the line's end when it has no `=`, which names a variable whose value is empty.
 */
function valueRange(line: string, entry: string): [number, number] | undefined {
  const at = line.indexOf('=');
  if ((at === -1 ? line : line.slice(0, at)).trim() !== entry) return undefined;
  if (at === -1) return [line.trimEnd().length, line.trimEnd().length];
  const value = line.slice(at + 1);
  if (value.trim() === '') return [at + 1, at + 1];
  const start = at + 1 + value.length - value.trimStart().length;
  return [start, at + 1 + value.trimEnd().length];
}

/** The input types whose text can be selected; `textarea` is a textarea's own. */
const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'textarea']);

/** The text a control holds, or none for one whose text cannot be selected: a select, a switch, a number. */
export function textOf(control: { type: string; value: string }): string | undefined {
  return TEXT_TYPES.has(control.type) ? control.value : undefined;
}

/** Waits for the next frame to run a callback; what it returns stops the wait. */
export type NextFrame = (callback: () => void) => () => void;

const animationFrame: NextFrame = (callback) => {
  const id = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(id);
};

/**
 * Tries `attempt` on each of the next `frames` frames until it succeeds, then calls `done`, which also follows the
 * last attempt that failed. What it returns stops the attempts without calling `done`.
 */
export function retryFrames(
  attempt: () => boolean,
  done: () => void,
  frames: number,
  next: NextFrame = animationFrame,
): () => void {
  let left = frames;
  let stop = (): void => {};
  const tick = (): void => {
    left -= 1;
    if (attempt() || left <= 0) done();
    else stop = next(tick);
  };
  stop = next(tick);
  return () => stop();
}
