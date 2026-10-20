import type { WorkflowDocument } from '../document';
import type { TextEdit } from '../edits';
import { editable, isRefusal } from '../guard';
import { fileName, refuse, type Fix, type Refusal } from '../refusal';
import { locate } from '../tree';
import { verify, type Draft, type EditPlan, type Warning } from '../verify';
import { setBinding, setOutput } from './bindings';
import { fixDraft } from './fixes';
import { labelOf } from './labels';
import { addJob, removeJob, setJobField, setWorkflowField } from './jobs';
import { setNeeds } from './needs';
import { addStep, moveStep, removeStep, setStepField } from './steps';
import type { OpContext, WorkflowOp } from './types';

type Planned = EditPlan<Record<string, TextEdit[]>>;

/**
 * Plans an op against the open documents: one draft, checked (G6) before it is offered, or the refusal with its
 * fixes. A file's lock answers before anything the op asks. Planning never throws for the author's input. Every op
 * of this set writes one file.
 */
export function planOp(op: WorkflowOp, ctx: OpContext): Planned {
  return planned(op, ctx, FIX_DEPTH);
}

/** How many refusals in a row a fix may clear (an alias inside a shared anchor, two anchors in a removed job). */
const FIX_DEPTH = 3;

function planned(op: WorkflowOp, ctx: OpContext, depth: number): Planned {
  const doc = ctx.doc(op.file);
  if (!doc) return refuse('not-found', op.file, `${fileName(op.file)} is not open.`);
  const locked = editable(doc, op.op === 'convertEol');
  if (locked) return locked;
  const draft = draftOf(doc, op, ctx.shared);
  if (isRefusal(draft)) return depth > 0 ? throughFixes(draft, op, ctx, depth) : draft;
  // Copies and line-ending conversions keep the value: the workflows that call this one plan as before.
  const changes = draft.edits.length > 0 && !FIX_OPS.has(op.op);
  const plan = verify(doc, {
    ...draft,
    label: labelOf(op),
    warnings: [...(draft.warnings ?? []), ...(changes ? callers(doc) : [])],
  });
  return plan.ok ? { ...plan, value: { [doc.path]: plan.value } } : plan;
}

const FIX_OPS = new Set<WorkflowOp['op']>(['dealias', 'dealiasAnchor', 'convertEol']);

/**
 * A refusal whose fixes each clear every blocker: a fix's ops are run, and when the op is still refused after them
 * for another reason that a fix of the same kind clears, that fix's ops are added, so one click gets the op through.
 */
function throughFixes(refusal: Refusal, op: WorkflowOp, ctx: OpContext, depth: number): Refusal {
  if (!refusal.fixes) return refusal;
  // The anchors "Change only here" copies make the target shared: "Change all" may not copy them away.
  const sharing = new Set(
    refusal.fixes.flatMap((fix) =>
      fix.kind === 'ops' ? fix.ops.flatMap((o) => (o.op === 'dealiasAnchor' ? [o.anchor] : [])) : [],
    ),
  );
  const fixes = refusal.fixes.flatMap((fix) => fullFix(fix, op, ctx, depth, sharing) ?? []);
  return { ...refusal, fixes };
}

/**
 * A fix that retries the op, with the ops of the fix its retry would be refused with added. None for a fix that
 * cannot get the op through: its ops or its retry refused with nothing to clear it, or a "Change all" that could only
 * go through by copying away the anchor it is about (it would then change one place).
 */
function fullFix(
  fix: Fix,
  op: WorkflowOp,
  ctx: OpContext,
  depth: number,
  sharing: Set<string>,
): Fix | undefined {
  if (!retries(fix)) return fix;
  const all = fix.kind === 'shared-all';
  const ops = fix.ops ?? [];
  const next = nextFix(ops, op, all ? { ...ctx, shared: 'all' } : ctx, depth);
  if (next === 'through') return fix;
  // The same ops again would clear nothing new.
  if (next === 'stuck' || JSON.stringify(next) === JSON.stringify(ops)) return undefined;
  return all && copiesAway(next, sharing) ? undefined : { ...fix, ops: [...ops, ...next] };
}

/** A fix that runs the refused op again: "Change all", or ops with `retry`. */
const retries = (fix: Fix): fix is Extract<Fix, { kind: 'ops' | 'shared-all' }> =>
  fix.kind === 'shared-all' || (fix.kind === 'ops' && fix.retry);

const copiesAway = (ops: readonly WorkflowOp[], anchors: Set<string>): boolean =>
  ops.some((o) => o.op === 'dealiasAnchor' && anchors.has(o.anchor));

/** What follows `ops`: the op goes `through`, or is refused with a fix that clears that (its ops), or is `stuck`. */
function nextFix(
  ops: readonly WorkflowOp[],
  op: WorkflowOp,
  ctx: OpContext,
  depth: number,
): WorkflowOp[] | 'through' | 'stuck' {
  const after = runOps(ops, ctx);
  if (!after) return 'stuck';
  const retry = planned(op, after, depth - 1);
  if (retry.ok) return 'through';
  const next = retry.fixes.find((f) => f.kind === 'ops' && f.retry);
  return next?.kind === 'ops' ? next.ops : 'stuck';
}

/** The context after a fix's ops, each planned on the documents the ones before left; undefined when one fails. */
function runOps(ops: readonly WorkflowOp[], ctx: OpContext): OpContext | undefined {
  const docs = new Map<string, WorkflowDocument>();
  const current: OpContext = { ...ctx, doc: (path) => docs.get(path) ?? ctx.doc(path) };
  for (const fixOp of ops) {
    const plan = planned(fixOp, current, 0);
    if (!plan.ok) return undefined;
    for (const [path, doc] of Object.entries(plan.documents)) docs.set(path, doc);
  }
  return current;
}

type Planner = (doc: WorkflowDocument, op: never, shared?: 'all') => Draft | Refusal;

const PLANNERS: Record<WorkflowOp['op'], Planner> = {
  setWorkflowField,
  addJob,
  removeJob,
  setJobField,
  setNeeds,
  setOutput,
  setBinding,
  addStep,
  removeStep,
  moveStep,
  setStepField,
  dealias: fixDraft,
  dealiasAnchor: fixDraft,
  convertEol: fixDraft,
};

function draftOf(doc: WorkflowDocument, op: WorkflowOp, shared?: 'all'): Draft | Refusal {
  return PLANNERS[op.op](doc, op as never, shared);
}

/** An edit to a workflow other workflows call changes their plans too. */
function callers(doc: WorkflowDocument): Warning[] {
  const on = doc.get(['on'])?.value;
  const called =
    on === 'workflow_call' ||
    (Array.isArray(on) && on.includes('workflow_call')) ||
    (typeof on === 'object' && on !== null && Object.hasOwn(on, 'workflow_call'));
  return called && locate(doc.tree, ['jobs'])
    ? [
        {
          code: 'callers',
          message: `${fileName(doc.path)} is a reusable workflow: the workflows that call it may plan differently.`,
        },
      ]
    : [];
}
