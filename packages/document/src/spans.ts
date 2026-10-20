import { isCollection, isPair, isScalar, type ParsedNode } from 'yaml';
import { blockHeader, seqIndicators } from './cst';
import type { Lines } from './lines';
import { isFlow, type Collection, type ParsedPair, type Tree } from './tree';

/**
 * The lines an item of a collection owns. yaml cannot give these directly: a map key's indentation sits in the token
 * before it, a comment line deeper than the next key ends up in the map before it, and a block collection's range runs
 * on to its last item's end, over the comments, the blank lines and the next item's indentation that follow (`jobs.a`
 * ended inside `jobs.b`). So an item's span is computed in whole lines:
 *
 * - it starts at its own key or `-` (`own`), extended upward over the contiguous comment lines at exactly its column
 *   (except the document's first key: the comments above it are the file's header);
 * - it ends with the line that holds its content's end (`contentEnd`), its inline comment and break included, extended
 *   downward over the contiguous comment lines indented deeper than its column;
 * - an item that does not start its line (`name` in `- name: x`) starts at `own` itself.
 */
export interface ItemSpan {
  from: number;
  to: number;
  /** The key's offset (its anchor or tag, when it has one), or the `-`'s. */
  own: number;
  /** `own` does not start its line. */
  inline: boolean;
  /** `own`'s 0-based column. */
  column: number;
}

export function itemSpan(tree: Tree, parent: Collection, index: number): ItemSpan {
  const item = parent.items[index]!;
  if (isFlow(parent)) return flowItemSpan(tree, item);
  const { lines } = tree;
  const own = ownStart(parent, index);
  const line = lines.lineAt(own);
  const column = own - lines.start(line);
  const inline = !lines.startsLine(own);
  // The comments above the document's first key are the file's header (a licence, a generated marker), not the key's.
  const header = index === 0 && parent === tree.doc?.contents;
  const first = inline || header ? line : leadingComments(lines, line, column);
  const last = lines.lineAt(Math.max(contentEnd(tree, item) - 1, own));
  const to = lines.end(trailingComments(lines, last, column));
  return { from: inline ? own : lines.start(first), to, own, inline, column };
}

/** In a flow collection an item owns its own characters: `b` in `[a, b]`, `k: v` in `{k: v}`. */
function flowItemSpan(tree: Tree, item: ParsedPair | ParsedNode): ItemSpan {
  const from = isPair(item) ? item.key.range[0] : item.range[0];
  const to = contentEnd(tree, item);
  return { from, to, own: from, inline: !tree.lines.startsLine(from), column: tree.lines.column(from) };
}

/** Where item `index` of a block collection begins: its `-`, or its key (or the anchor or tag before the key). */
export function ownStart(parent: Collection, index: number): number {
  return ownOf(parent.items[index]!, () => seqIndicators(parent.srcToken)[index]);
}

/** Where each item of a collection begins, as `ownStart`; in a flow collection, at its first character. */
export function ownStarts(parent: Collection): number[] {
  const dashes = seqIndicators(parent.srcToken);
  return parent.items.map((item, i) => ownOf(item, () => dashes[i]));
}

/** What may come before a key on its own line: its anchor, its tag, a `?`. */
const PROPS = new Set(['anchor', 'tag', 'explicit-key-ind']);

function ownOf(item: ParsedPair | ParsedNode, dash: () => number | undefined): number {
  if (!isPair(item)) return dash() ?? item.range[0];
  const props = item.srcToken?.start.find((t) => PROPS.has(t.type));
  return props?.offset ?? item.key.range[0];
}

/**
 * Where an item's content ends: after the deepest last scalar, alias or flow collection in it, or after the last
 * non-empty line of a block scalar (every line under keep chomping, `|+`). An empty value (`push:`) ends where it
 * would start, on its key's line.
 */
export function contentEnd(tree: Tree, item: ParsedPair | ParsedNode | null): number {
  const leaf = lastLeaf(item);
  if (!leaf) return 0;
  if (isScalar(leaf) && leaf.srcToken?.type === 'block-scalar') return blockScalarEnd(tree.lines, leaf);
  return leaf.range[1];
}

function lastLeaf(item: ParsedPair | ParsedNode | null): ParsedNode | null {
  let node = isPair(item) ? (item.value ?? item.key) : item;
  while (isCollection(node) && !isFlow(node) && node.items.length > 0) {
    const last = node.items.at(-1)!;
    node = isPair(last) ? (last.value ?? last.key) : last;
  }
  return node;
}

function blockScalarEnd(lines: Lines, scalar: ParsedNode): number {
  const [start, end] = scalar.range;
  const header = lines.lineAt(start);
  let line = lines.lineAt(Math.max(end - 1, start));
  if (keepsTrailing(scalar)) return end;
  // Only lines of spaces are empty to a block scalar: a tab there is content.
  while (line > header && /^ *$/.test(lines.textOf(line))) line--;
  return lines.breakAt(line);
}

function keepsTrailing(scalar: ParsedNode): boolean {
  return blockHeader(scalar.srcToken).includes('+');
}

function leadingComments(lines: Lines, line: number, column: number): number {
  let first = line;
  while (first > 0 && isCommentAt(lines, first - 1, (indent) => indent === column)) first--;
  return first;
}

function trailingComments(lines: Lines, line: number, column: number): number {
  let last = line;
  while (last + 1 < lines.count && isCommentAt(lines, last + 1, (indent) => indent > column)) last++;
  return last;
}

function isCommentAt(lines: Lines, line: number, column: (indent: number) => boolean): boolean {
  const { kind, indent } = lines.kind(line);
  return kind === 'comment' && column(indent);
}
