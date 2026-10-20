import { composeEdits } from '../compose';
import type { WorkflowDocument } from '../document';
import type { TextEdit } from '../edits';
import { isRefusal } from '../guard';
import type { Refusal } from '../refusal';
import type { Draft } from '../verify';

/** One step of an op: a draft against the document as the steps before left it, or nothing to do. */
export type Step = (doc: WorkflowDocument) => Draft | Refusal | undefined;

/**
 * An op made of steps, each planned on the text the ones before it produce, as one draft against the first
 * document: its splices composed, its meanings one after the other. A step's refusal is the op's.
 */
export function chain(doc: WorkflowDocument, label: string, steps: readonly Step[]): Draft | Refusal {
  let current = doc;
  let edits: TextEdit[] = [];
  const expects: Draft['expect'][] = [];
  const warnings: NonNullable<Draft['warnings']> = [];
  for (const step of steps) {
    const draft = step(current);
    if (!draft) continue;
    if (isRefusal(draft)) return current === doc ? draft : asFirst(step, doc, draft);
    expects.push(draft.expect);
    warnings.push(...(draft.warnings ?? []));
    if (draft.edits.length === 0) continue;
    edits = composeEdits(doc.text, edits, draft.edits);
    current = current.apply(draft.edits);
  }
  const out: Draft = { edits, label, warnings };
  if (expects.every((e) => e !== undefined)) out.expect = (js) => expects.reduce((v, e) => e(v), js);
  return out;
}

/**
 * A later step's refusal, told in the first document's lines (a fix names lines the author sees): the step planned
 * on the first document, when it is refused there too.
 */
function asFirst(step: Step, doc: WorkflowDocument, refusal: Refusal): Refusal {
  const first = step(doc);
  return first !== undefined && isRefusal(first) ? first : refusal;
}
