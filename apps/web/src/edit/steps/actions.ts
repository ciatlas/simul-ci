import type { Fp } from '@simulci/document';
import type { SessionStore } from '../../state/store';
import { type GestureUi, removal, warningsOf } from '../canvas/ui';
import { dispatch } from '../dispatch';
import { documents } from '../documents';
import { type Target, targetOf } from '../selection';

/**
 * The step gestures (synthesis § 4.2): remove a step, move it up, down or to another place in its job, each an op with
 * the fingerprint of the step the author saw, read when the gesture starts; a step that moved under it since (typing
 * in the pane, a plan behind the text) is refused `moved` and nothing is written. Picked on the plan's picture (the
 * canvas, the outline), the target is read with `planned`; picked in Properties, from the text as it is.
 */

/** A step as a sentence names it: `step 2 of build (npm ci)`. */
export function stepWords(job: string, index: number, fp: Fp): string {
  const what = fp.name ?? fp.uses ?? fp.runHead ?? fp.id;
  const cut = what !== undefined && what.length > 40 ? `${what.slice(0, 39)}…` : what;
  return `step ${index + 1} of ${job}${cut === undefined ? '' : ` (${cut})`}`;
}

type StepTarget = Target & { job: string; step: NonNullable<Target['step']> };

const isStep = (target: Target | undefined): target is StepTarget =>
  target?.job !== undefined && target.step !== undefined;

/** The step of a job at an index of the text now, as a target to act on. */
export function stepTarget(
  store: SessionStore,
  file: string,
  job: string,
  index: number,
): StepTarget | undefined {
  const s = store.getState();
  const doc = documents(store).of(s, file);
  const rev = s.files.revs[file];
  const sel = doc?.jobs().find((j) => j.id === job)?.steps[index]?.id ?? `#${index + 1}`;
  const target = rev === undefined ? undefined : targetOf(store, file, `${job}.${sel}`);
  return isStep(target) && target.step.index === index ? target : undefined;
}

/** Where a step gesture's refusal shows, and whether the selection stays (Properties' list keeps its job). */
export interface StepGesture {
  anchor?: Element | undefined;
  keepSelection?: boolean;
}

/** Removes a step, asking first when its id is still read; the notice offers Undo. */
export function removeStep(
  store: SessionStore,
  ui: GestureUi,
  target: Target,
  how: StepGesture = {},
): boolean {
  if (!isStep(target)) return false;
  const { file, job, step } = target;
  const words = stepWords(job, step.index, step.fp);
  removal(store, ui, {
    op: { op: 'removeStep', file, job, index: step.index, fp: step.fp },
    meta: {
      revs: { [file]: target.rev },
      label: `Removed ${words}`,
      keepSelection: how.keepSelection ?? false,
    },
    toast: `Removed ${words}`,
    ask: { title: `Remove ${words}?`, action: 'Remove the step', lines: [] },
    anchor: how.anchor,
  });
  return true;
}

/**
 * Moves a step to another index of its job; the selection follows it. One that would then read a step's outputs
 * before that step runs asks first. Past either end, nothing moves.
 */
export function moveStep(
  store: SessionStore,
  ui: GestureUi,
  target: Target,
  to: number,
  how: StepGesture = {},
): boolean {
  if (!isStep(target)) return false;
  const { file, job, step } = target;
  const count =
    documents(store)
      .of(store.getState(), file)
      ?.jobs()
      .find((j) => j.id === job)?.steps.length ?? 0;
  if (to < 0 || to >= count || to === step.index) return false;
  const words = stepWords(job, step.index, step.fp);
  const where = to === step.index - 1 ? 'up' : to === step.index + 1 ? 'down' : `to place ${to + 1}`;
  const op = { op: 'moveStep', file, job, from: step.index, to, fp: step.fp } as const;
  const meta = {
    revs: { [file]: target.rev },
    label: `Moved ${words} ${where}`,
    keepSelection: how.keepSelection ?? false,
  };
  const run = (): void => {
    const result = dispatch(store, op, meta);
    if (!result.ok) ui.refused(result.refused.seq, how.anchor);
  };
  const warnings = warningsOf(store, op)
    .filter((w) => w.code !== 'callers')
    .map((w) => w.message);
  if (warnings.length === 0) run();
  else ui.confirm({ title: `Move ${words} ${where}?`, lines: warnings, action: 'Move the step', run });
  return true;
}
