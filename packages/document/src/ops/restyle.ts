import { isMap, isScalar, isSeq } from 'yaml';
import type { WorkflowDocument } from '../document';
import { commentLines, flowMap } from '../fragment';
import { removeDraft } from '../remove';
import * as refusals from '../refusal';
import type { Refusal } from '../refusal';
import { inlineScalar } from '../scalar';
import { contentEnd, itemSpan } from '../spans';
import { isFlow, locate } from '../tree';
import type { Json, YamlPath } from '../types';
import type { Draft } from '../verify';

/**
 * Steps that restyle text an op has just written, its value unchanged: the renderer writes new maps in block and
 * scalars plain where they read back, and these put them as the file writes them. Each runs on the document the
 * write produced, so what it rewrites has no comment inside.
 */

const same = (js: unknown): unknown => js;

/** A new plain string at a path rewritten in the file's quotes (a cron holds `*`); nothing for any other token. */
export function quoted(doc: WorkflowDocument, path: YamlPath): Draft | undefined {
  const found = locate(doc.tree, path);
  const node = found?.node;
  if (!isScalar(node) || typeof node.value !== 'string' || node.srcToken?.type !== 'scalar') return undefined;
  const parent = found!.hops.at(-1)!.parent;
  const place = isFlow(parent) ? 'flow' : isSeq(parent) ? 'item' : 'value';
  const text = inlineScalar(node.value, place, doc.style, doc.style.quote);
  if (text === undefined) return undefined;
  return { edits: [{ from: node.range[0], to: node.range[1], insert: text }], expect: same, label: '' };
}

/**
 * A new block map at a path rewritten on one line in flow (`when: { event: push }`, `- { os: linux }`), when it can
 * be and the line stays within `width` columns; nothing otherwise.
 */
export function inFlow(
  doc: WorkflowDocument,
  path: YamlPath,
  padded: boolean,
  width = 100,
): Draft | undefined {
  const found = locate(doc.tree, path);
  const node = found?.node;
  if (!isMap(node) || isFlow(node) || node.items.length === 0) return undefined;
  const text = flowMap(doc.get(path)!.value as { [key: string]: Json }, doc.style, padded);
  if (text === undefined) return undefined;
  const { lines } = doc.tree;
  const pair = found!.hops.at(-1)!.pair;
  // After a key, the map's lines become the rest of the key's line; as an item, they follow its `- `.
  const from = pair ? lines.breakAt(lines.lineAt(pair.key.range[0])) : node.range[0];
  const head = doc.text.slice(lines.start(lines.lineAt(from)), from);
  if (head.length + (pair ? 1 : 0) + text.length > width) return undefined;
  const to = lines.breakAt(lines.lineAt(contentEnd(doc.tree, node) - 1));
  return { edits: [{ from, to, insert: pair ? ` ${text}` : text }], expect: same, label: '' };
}

/** Comment lines written right above the item at a path, at its column: its leading comments. */
export function commentsBefore(
  doc: WorkflowDocument,
  path: YamlPath,
  comments: readonly string[],
): Draft | Refusal | undefined {
  if (comments.length === 0) return undefined;
  const parent = locate(doc.tree, path.slice(0, -1))?.node;
  if (!isSeq(parent) || isFlow(parent))
    return refusals.unsupported(doc.path, path, `a comment cannot go above ${refusals.describe(path)}`);
  const span = itemSpan(doc.tree, parent, Number(path.at(-1)));
  if (span.inline)
    return refusals.unsupported(doc.path, path, `${refusals.describe(path)} starts on its parent's line`);
  const eol = doc.style.eol;
  const text = commentLines(comments, span.column).join(eol) + eol;
  return { edits: [{ from: span.from, to: span.from, insert: text }], expect: same, label: '' };
}

/**
 * The pair or item at a path removed, with each collection above it, down to `top` segments, that it would leave
 * empty: the last dimension of a matrix takes `matrix:` with it, and a strategy left with nothing goes too.
 */
export function removeEmptied(
  doc: WorkflowDocument,
  path: YamlPath,
  top: number,
  shared?: 'all',
): Draft | Refusal {
  let target = path;
  while (target.length > top && sizeOf(doc.get(target.slice(0, -1))?.value) === 1)
    target = target.slice(0, -1);
  return removeDraft(doc, target, 'null', shared ? { shared } : {});
}

const sizeOf = (value: unknown): number =>
  Array.isArray(value)
    ? value.length
    : typeof value === 'object' && value !== null
      ? Object.keys(value).length
      : 0;
