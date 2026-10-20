import { isAlias, isMap, isPair, isScalar, visit, type Alias, type ParsedNode, type YAMLMap } from 'yaml';
import { walkTokens } from './cst';
import { contentEnd } from './spans';
import { keyOf, walkNodes, type Tree } from './tree';
import type { YamlPath } from './types';

/** `&name` on a node. A name may be defined again further down; an alias names the closest definition above it. */
export interface AnchorDef {
  name: string;
  node: ParsedNode;
  /** The anchored node's path. */
  path: YamlPath;
  /** The `&name` token. */
  from: number;
  to: number;
  /** 1-based. */
  line: number;
  /** The aliases that name this definition, in text order. */
  aliases: AliasUse[];
  /** The anchor is on a map key (`&b build:`): its aliases name the key's text, not the pair's value. */
  key: boolean;
}

/** `*name`. */
export interface AliasUse {
  name: string;
  node: Alias.Parsed;
  path: YamlPath;
  from: number;
  to: number;
  line: number;
  /** The definition it names; absent when it dangles. */
  target?: AnchorDef;
  /** It dangles because its anchor comes only after it, which YAML does not allow. */
  forward: boolean;
  /** It is inside the node it names: its value would contain itself. */
  recursive: boolean;
}

/** A map holding a `<<` key: GitHub reads YAML 1.2, where `<<` is an ordinary key and nothing is merged. */
export interface MergeKey {
  map: YAMLMap.Parsed;
  /** The map's path. */
  path: YamlPath;
  /** The `<<` key. */
  from: number;
  line: number;
}

/**
 * Every anchor, alias and merge key of a document. Unlike yaml, the index sees a dangling alias at once (yaml reports
 * it only when `toJS` throws), and tells an alias written before its anchor from one whose anchor does not exist.
 */
export class AnchorIndex {
  readonly anchors: readonly AnchorDef[];
  readonly aliases: readonly AliasUse[];
  readonly merges: readonly MergeKey[];
  /** 1-based lines of keys that are not plain text (`*id :`, `? [a, b]`), which no path can name. */
  readonly oddKeys: readonly number[];
  readonly #byNode: Map<ParsedNode, AnchorDef>;

  constructor(tree: Tree) {
    const found = collect(tree);
    this.anchors = found.anchors;
    this.aliases = found.aliases;
    this.merges = found.merges;
    this.oddKeys = oddKeys(tree);
    this.#byNode = new Map(found.anchors.map((def) => [def.node, def]));
  }

  /** Aliases that name no anchor above them, forward ones included. */
  get dangling(): AliasUse[] {
    return this.aliases.filter((alias) => !alias.target);
  }

  /** Definitions that aliases use. */
  get shared(): AnchorDef[] {
    return this.anchors.filter((def) => def.aliases.length > 0);
  }

  /** The definition on a node, if the node is anchored. */
  definedOn(node: ParsedNode | null | undefined): AnchorDef | undefined {
    return node ? this.#byNode.get(node) : undefined;
  }

  /** The definitions of a name, in text order. */
  definitions(name: string): AnchorDef[] {
    return this.anchors.filter((def) => def.name === name);
  }

  /** The node an alias names, if it does not dangle. */
  target(alias: Alias.Parsed): ParsedNode | undefined {
    return this.aliases.find((use) => use.node === alias)?.target?.node;
  }
}

interface Found {
  anchors: AnchorDef[];
  aliases: AliasUse[];
  merges: MergeKey[];
}

function collect(tree: Tree): Found {
  const found: Found = { anchors: [], aliases: [], merges: [] };
  // The `&name` tokens are looked up only in a file that has anchors.
  let tokens: Map<string, number[]> | undefined;
  const current = new Map<string, AnchorDef>();
  walkNodes(tree.doc?.contents ?? null, (node, path, isKey) => {
    if (node.anchor) addAnchor(tree, found, current, (tokens ??= anchorTokens(tree)), node, [...path], isKey);
    if (isAlias(node)) addAlias(tree, found, current, node, [...path]);
    if (isMap(node)) mergeKey(tree, found, node, path);
  });
  for (const alias of found.aliases) {
    alias.forward = !alias.target && found.anchors.some((def) => def.name === alias.name);
    const node = alias.target?.node;
    alias.recursive = node !== undefined && alias.from > node.range[0] && alias.from < contentEnd(tree, node);
  }
  return found;
}

function addAnchor(
  tree: Tree,
  found: Found,
  current: Map<string, AnchorDef>,
  tokens: Map<string, number[]>,
  node: ParsedNode,
  path: YamlPath,
  key: boolean,
): void {
  const name = node.anchor!;
  // The anchor tokens of a name, in text order, are its definitions in text order.
  const from = tokens.get(name)?.shift() ?? node.range[0];
  const line = tree.lines.lineAt(from) + 1;
  const def: AnchorDef = { name, node, path, from, to: from + name.length + 1, line, aliases: [], key };
  found.anchors.push(def);
  current.set(name, def);
}

function addAlias(
  tree: Tree,
  found: Found,
  current: Map<string, AnchorDef>,
  node: Alias.Parsed,
  path: YamlPath,
): void {
  const [from, to] = node.range;
  const target = current.get(node.source);
  const alias: AliasUse = {
    name: node.source,
    node,
    path,
    from,
    to,
    line: tree.lines.lineAt(from) + 1,
    forward: false,
    recursive: false,
  };
  if (target) {
    alias.target = target;
    target.aliases.push(alias);
  }
  found.aliases.push(alias);
}

function mergeKey(tree: Tree, found: Found, map: YAMLMap.Parsed, path: YamlPath): void {
  const pair = map.items.find((item) => isPair(item) && isScalar(item.key) && keyOf(item) === '<<');
  if (!pair) return;
  const from = pair.key.range[0];
  // A quoted '<<' is a plain string key in every YAML version.
  if (pair.key.srcToken?.type !== 'scalar') return;
  found.merges.push({ map, path: [...path], from, line: tree.lines.lineAt(from) + 1 });
}

/** The offsets of the `&name` tokens, by name, in text order. */
function anchorTokens(tree: Tree): Map<string, number[]> {
  const out = new Map<string, number[]>();
  walkTokens(tree.tokens, (token) => {
    if (token.type !== 'anchor') return;
    const name = token.source.slice(1);
    out.set(name, [...(out.get(name) ?? []), token.offset]);
  });
  return out;
}

/** The lines of keys that are not plain text: an alias or a collection as a key. */
function oddKeys(tree: Tree): number[] {
  const out: number[] = [];
  if (!tree.doc) return out;
  visit(tree.doc, {
    Pair: (_, pair) => {
      const key = pair.key as ParsedNode | null;
      if (key && !isScalar(key)) out.push(tree.lines.lineAt(key.range[0]) + 1);
    },
  });
  return out;
}
