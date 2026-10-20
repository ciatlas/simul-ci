import {
  isAlias,
  isCollection,
  isMap,
  isScalar,
  isSeq,
  type Alias,
  type CST,
  type Document,
  type Pair,
  type ParsedNode,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type { Lines } from './lines';
import type { YamlPath } from './types';

export type Collection = YAMLMap.Parsed | YAMLSeq.Parsed;
export type ParsedPair = Pair<ParsedNode, ParsedNode | null>;

/** One parse of a text: its lines, its CST tokens and the AST of its first document. */
export interface Tree {
  readonly text: string;
  readonly lines: Lines;
  readonly tokens: readonly CST.Token[];
  /** The first document; absent when the text was not parsed (too large). */
  readonly doc: Document.Parsed | undefined;
}

/** One segment of a walk down a path: the collection walked into, the item taken and, in a map, its pair. */
export interface Hop {
  parent: Collection;
  index: number;
  pair?: ParsedPair;
  node: ParsedNode | null;
}

export interface Located {
  /** The node at the path or, when the walk stopped at an alias, that alias. */
  node: ParsedNode | null;
  /** One hop per segment walked. Fewer than the path's segments when the walk stopped at an alias. */
  hops: Hop[];
  /** The first alias on the path, and how many segments lead to it (`path.slice(0, at)` is the alias). */
  alias?: { node: Alias.Parsed; at: number };
}

/** Where an alias points, or undefined when it dangles. */
export type Resolve = (alias: Alias.Parsed) => ParsedNode | undefined;

/**
 * Walks a path from the root. Without `resolve` the walk stops at the first alias that has segments after it; with it,
 * the walk goes on inside the anchored node the alias names. Map keys match by their text (`on`, `'on'` and `"on"`
 * are one key); sequence segments are 0-based indices.
 */
export function locate(tree: Tree, path: YamlPath, resolve?: Resolve): Located | undefined {
  let node: ParsedNode | null = tree.doc?.contents ?? null;
  const out: Located = { node, hops: [] };
  for (const [at, segment] of path.entries()) {
    if (isAlias(node)) {
      out.alias ??= { node, at };
      if (!resolve) return { ...out, node };
      node = resolve(node) ?? null;
    }
    const hop = step(node, segment);
    if (!hop) return undefined;
    out.hops.push(hop);
    node = hop.node;
  }
  if (isAlias(node)) out.alias ??= { node, at: path.length };
  out.node = node;
  return out;
}

function step(node: ParsedNode | null, segment: string | number): Hop | undefined {
  if (typeof segment === 'number') {
    if (!isSeq(node) || !Number.isInteger(segment) || segment < 0) return undefined;
    const item = node.items[segment];
    return item === undefined ? undefined : { parent: node, index: segment, node: item };
  }
  if (!isMap(node)) return undefined;
  const map = node;
  const index = map.items.findIndex((pair) => keyOf(pair) === segment);
  if (index === -1) return undefined;
  const pair = map.items[index]!;
  return { parent: map, index, pair, node: pair.value };
}

/** A pair's key as a path segment: the text of a scalar key, else undefined. */
export function keyOf(pair: ParsedPair): string | undefined {
  return isScalar(pair.key) ? String(pair.key.value) : undefined;
}

/** Whether a collection is written in flow style (`[a, b]`, `{a: 1}`). */
export function isFlow(node: ParsedNode | null | undefined): boolean {
  return isCollection(node) && node.srcToken?.type === 'flow-collection';
}

/** A node's value as plain JSON, aliases resolved; undefined when an alias dangles or expands too far. */
export function toJson(tree: Tree, node: ParsedNode | null): unknown {
  if (!node || !tree.doc) return null;
  try {
    return node.toJS(tree.doc, { maxAliasCount: MAX_ALIAS_COUNT });
  } catch {
    return undefined;
  }
}

/** yaml's guard against alias bombs; 100 by default, which a file reusing one `runs-on` in 101 jobs would trip. */
const MAX_ALIAS_COUNT = 10_000;

/** The pairs and items of a node, each with its path segment, in text order. Scalars and aliases have none. */
export function entriesOf(
  node: ParsedNode | null,
): { segment: string | number; node: ParsedNode | null; pair?: ParsedPair }[] {
  if (isMap(node))
    return node.items.flatMap((pair) => {
      const key = keyOf(pair);
      return key === undefined ? [] : [{ segment: key, node: pair.value, pair }];
    });
  if (isSeq(node)) return node.items.map((item, i) => ({ segment: i, node: item }));
  return [];
}

/**
 * Visits every node under `root` in text order, a pair's key before its value, with its path. The path is one array
 * reused for the whole walk: copy it to keep it. Pairs whose key is not a scalar are not entered.
 */
export function walkNodes(
  root: ParsedNode | null,
  visit: (node: ParsedNode, path: readonly (string | number)[], isKey: boolean) => void,
): void {
  const path: (string | number)[] = [];
  const go = (node: ParsedNode | null, isKey: boolean): void => {
    if (!node) return;
    visit(node, path, isKey);
    for (const entry of entriesOf(node)) {
      path.push(entry.segment);
      if (entry.pair) go(entry.pair.key, true);
      go(entry.node, false);
      path.pop();
    }
  };
  go(root, false);
}
