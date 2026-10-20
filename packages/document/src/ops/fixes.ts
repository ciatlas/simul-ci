import { dealiasAnchorDraft, dealiasDraft } from '../dealias';
import type { WorkflowDocument } from '../document';
import { convertEolDraft } from '../primitives';
import type { Refusal } from '../refusal';
import type { Draft } from '../verify';
import type { FixOp } from './types';

/**
 * The ops a refusal's fixes run, each also an op of its own: give an alias its own copy (`dealias`), copy an anchor
 * into every use and drop it (`dealiasAnchor`), or convert the line endings. None changes the file's value.
 */
export function fixDraft(doc: WorkflowDocument, op: FixOp): Draft | Refusal {
  if (op.op === 'dealias') return dealiasDraft(doc, op.path);
  if (op.op === 'dealiasAnchor') return dealiasAnchorDraft(doc, op.anchor, op.line);
  return convertEolDraft(doc, op.eol);
}
