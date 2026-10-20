import { isCollection, isPair } from 'yaml';
import type { WorkflowDocument } from './document';
import type { TextEdit } from './edits';
import * as refusals from './refusal';
import type { Refusal } from './refusal';
import { inlineScalar, type Scalar } from './scalar';
import { contentEnd, ownStart } from './spans';
import type { Collection } from './tree';
import type { YamlPath } from './types';

/**
 * A flow collection edited in place: one line (so no comment inside), nothing nested. Its items are spliced inside the
 * brackets, so the pair is never written again and a comment after `]` stays (`branches: [main] # protected`).
 * Anything else is the YAML pane's (`flow-shape`).
 */
export function simpleFlow(doc: WorkflowDocument, node: Collection, path: YamlPath): Refusal | undefined {
  const { lines } = doc.tree;
  const [start, end] = node.range;
  const line = lines.lineAt(start) + 1;
  if (lines.lineAt(start) !== lines.lineAt(Math.max(end - 1, start)))
    return refusals.flowShape(
      doc.path,
      path,
      line,
      `over ${lines.lineAt(end - 1) - lines.lineAt(start) + 1} lines`,
    );
  const values = node.items.map((item) => (isPair(item) ? item.value : item));
  if (values.some((v) => isCollection(v)))
    return refusals.flowShape(doc.path, path, line, 'with a collection inside');
  return undefined;
}

/** Where a flow item starts: at its anchor or tag (`[&n a, !!str 1]`), which go with it. */
function itemStart(node: Collection, index: number): number {
  const own = ownStart(node, index);
  const token = node.srcToken;
  const item = token?.type === 'flow-collection' ? token.items[index] : undefined;
  const props = item?.start.find((t) => (t.type === 'anchor' || t.type === 'tag') && t.offset < own);
  return props?.offset ?? own;
}

/** The text between a flow collection's brackets, and where it is. */
function inner(doc: WorkflowDocument, node: Collection): { from: number; to: number; text: string } {
  const [start, end] = node.range;
  return { from: start + 1, to: end - 1, text: doc.text.slice(start + 1, end - 1) };
}

/** An item spliced into a flow sequence at `index`, or a pair appended to a flow map. */
export function flowInsert(doc: WorkflowDocument, node: Collection, index: number, text: string): TextEdit {
  if (node.items.length === 0) {
    const { from, to } = inner(doc, node);
    const pad = doc.style.flowPadding ? ' ' : '';
    return { from, to, insert: `${pad}${text}${pad}` };
  }
  if (index >= node.items.length) {
    const end = contentEnd(doc.tree, node.items.at(-1)!);
    return { from: end, to: end, insert: `, ${text}` };
  }
  const at = itemStart(node, index);
  return { from: at, to: at, insert: `${text}, ` };
}

/** An item and the separator next to it, out of a flow collection of two or more. */
export function flowRemove(doc: WorkflowDocument, node: Collection, index: number): TextEdit {
  const items = node.items;
  if (index < items.length - 1)
    return { from: itemStart(node, index), to: itemStart(node, index + 1), insert: '' };
  return {
    from: contentEnd(doc.tree, items[index - 1]!),
    to: contentEnd(doc.tree, items[index]!),
    insert: '',
  };
}

/** Whether a value is a string holding an expression, which a flow list does not take (G5). */
export const holdsExpression = (value: unknown): boolean =>
  typeof value === 'string' && value.includes('${{');

/** A scalar as a flow item, or `key: value` as a flow pair. */
export function flowText(doc: WorkflowDocument, value: Scalar, key?: string): string | undefined {
  const text = inlineScalar(value, 'flow', doc.style);
  if (key === undefined || text === undefined) return text;
  const name = inlineScalar(key, 'flowKey', doc.style);
  return name === undefined ? undefined : `${name}: ${text}`;
}
