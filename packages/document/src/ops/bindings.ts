import type { WorkflowDocument } from '../document';
import { isRefusal } from '../guard';
import { removeDraft } from '../remove';
import * as refusals from '../refusal';
import type { Refusal } from '../refusal';
import { setDraft } from '../set';
import type { YamlPath } from '../types';
import type { Draft } from '../verify';
import { jobMissing } from './fields';
import { checkId, sameId } from './ids';
import { orderFor } from './order';
import { checkStep } from './steps';
import type { WorkflowOp } from './types';

type Op<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

/** One pair of a job's `outputs`, the map created in order when missing; the last one out takes the key. */
export function setOutput(doc: WorkflowDocument, op: Op<'setOutput'>, shared?: 'all'): Draft | Refusal {
  const job = ['jobs', op.job];
  const name = keyIn(doc, [...job, 'outputs'], op.name);
  const bad = jobMissing(doc, op.job) ?? (op.value === null ? undefined : newOutput(doc, op, name));
  if (bad) return bad;
  return pairDraft(doc, [...job, 'outputs', name], op.value, shared);
}

/** Refuses an output a job cannot get: on a reusable call, or a new one whose name is no id (one there keeps its). */
function newOutput(doc: WorkflowDocument, op: Op<'setOutput'>, name: string): Refusal | undefined {
  if (doc.get(['jobs', op.job, 'uses'])) return jobKind(doc, op.job, "its outputs are the called workflow's");
  const exists = doc.get(['jobs', op.job, 'outputs', name]) !== undefined;
  return exists ? undefined : checkId(doc, 'output', op.name, [], (id) => ({ ...op, name: id }));
}

/** One pair of a job's or a step's `with`, `env` or `secrets`, the map created in order when missing. */
export function setBinding(doc: WorkflowDocument, op: Op<'setBinding'>, shared?: 'all'): Draft | Refusal {
  const owner: YamlPath = op.step ? ['jobs', op.job, 'steps', op.step.index] : ['jobs', op.job];
  const bad =
    (op.step ? checkStep(doc, op.job, op.step.index, op.step.fp) : jobMissing(doc, op.job)) ??
    (op.value === null ? undefined : bindingKind(doc, op, owner));
  if (bad) return bad;
  if (op.step && op.kind === 'secrets')
    return refusals.refuse(
      'unsupported-shape',
      doc.path,
      'A step takes no `secrets`: pass them in its `with` or `env`.',
      { at: [...owner, 'secrets'] },
    );
  const draft = pairDraft(
    doc,
    [...owner, op.kind, keyIn(doc, [...owner, op.kind], op.name)],
    op.value,
    shared,
  );
  return isRefusal(draft) ? draft : { ...draft, select: owner };
}

/** A key as the map writes it whatever its case (`CI` for `ci`): GitHub reads one key per name. */
export function keyIn(doc: WorkflowDocument, mapPath: YamlPath, name: string): string {
  const map = doc.get(mapPath)?.value;
  const keys = typeof map === 'object' && map !== null && !Array.isArray(map) ? Object.keys(map) : [];
  return keys.find((key) => sameId(key, name)) ?? name;
}

/**
 * Refuses a binding the owner's kind does not take: `with` and `secrets` are a reusable call's, `env` is not; a step's
 * `with` is an action's.
 */
function bindingKind(doc: WorkflowDocument, op: Op<'setBinding'>, owner: YamlPath): Refusal | undefined {
  if (op.step) {
    const action = doc.get([...owner, 'uses']) !== undefined;
    return op.kind === 'with' && !action
      ? refusals.unsupported(
          doc.path,
          owner,
          `${refusals.describe(owner)} runs a script, which takes no \`with\``,
          doc.lineOf(owner),
        )
      : undefined;
  }
  const call = doc.get([...owner, 'uses']) !== undefined;
  if (op.kind === 'env' && call) return jobKind(doc, op.job, 'it takes no `env`');
  if (op.kind !== 'env' && !call)
    return refusals.unsupported(
      doc.path,
      owner,
      `the job ${op.job} runs steps; \`${op.kind}\` is for a job that calls a reusable workflow`,
      doc.lineOf(owner),
    );
  return undefined;
}

const jobKind = (doc: WorkflowDocument, job: string, why: string): Refusal =>
  refusals.unsupported(
    doc.path,
    ['jobs', job],
    `the job ${job} calls a reusable workflow: ${why}`,
    doc.lineOf(['jobs', job]),
  );

function pairDraft(doc: WorkflowDocument, path: YamlPath, value: unknown, shared?: 'all'): Draft | Refusal {
  const options = shared ? { shared } : {};
  // Through an alias: a pair that is not there is nothing to remove, the alias untouched.
  if (value === null)
    return doc.get(path) !== undefined
      ? removeDraft(doc, path, 'remove', options)
      : { edits: [], label: 'Nothing to remove' };
  return setDraft(doc, path, value as never, { order: orderFor, ...options });
}
