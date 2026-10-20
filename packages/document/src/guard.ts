import { isMap, isSeq, type ParsedNode } from 'yaml';
import type { AnchorDef } from './anchors';
import type { WorkflowDocument } from './document';
import * as refusals from './refusal';
import type { Refusal } from './refusal';
import { locate, type Located } from './tree';
import type { YamlPath } from './types';

export interface ReachOptions {
  /** Change every use of a shared anchor (the "Change all N uses" fix). */
  shared?: 'all';
  /** The target may be an alias itself (removing or moving `- *checkout`), though nothing on the way may be. */
  aliasTarget?: boolean;
  /** Check shared anchors on the target's ancestors only: removing an anchored node is the orphan check's. */
  sharedAbove?: boolean;
}

/** Why no edit can touch this document at all: its status, mixed line endings, or an alias that names nothing. */
export function editable(doc: WorkflowDocument, eolExempt = false): Refusal | undefined {
  if (!doc.status.editable) return doc.status.refusal;
  if (!eolExempt && /\r\n/.test(doc.text) && /(?:^|[^\r])\n/.test(doc.text))
    return refusals.mixedEol(doc.path);
  return aliasLock(doc);
}

/**
 * What locks a file whose aliases no edit can reason about: one that names nothing, one inside the node it names, a
 * key that is not plain text (an alias as a key hides its pair from every path), aliases that expand too far.
 */
function aliasLock(doc: WorkflowDocument): Refusal | undefined {
  const { anchors } = doc;
  const dangling = anchors.dangling[0];
  if (dangling)
    return refusals.danglingAlias(doc.path, dangling, anchors.definitions(dangling.name)[0]?.line);
  const loop = anchors.aliases.find((a) => a.recursive);
  if (loop) return refusals.recursiveAlias(doc.path, loop.name, loop.line);
  const odd = anchors.oddKeys[0];
  if (odd !== undefined)
    return refusals.unsupported(doc.path, [], `the key on line ${odd} is not plain text`, odd);
  return anchors.aliases.length > 0 && doc.value() === undefined ? refusals.aliasBomb(doc.path) : undefined;
}

/**
 * The node at a path, or why an edit may not touch it: it is missing, the way to it goes through an alias or a map
 * with a merge key, or it sits inside an anchored node that aliases repeat elsewhere.
 */
export function reach(doc: WorkflowDocument, path: YamlPath, options: ReachOptions = {}): Located | Refusal {
  const at = locate(doc.tree, path);
  if (!at) return missing(doc, path);
  if (at.alias && !(options.aliasTarget && at.alias.at === path.length)) {
    const def = doc.anchors.aliases.find((a) => a.node === at.alias!.node)?.target;
    return refusals.aliasRefusal(doc.path, path.slice(0, at.alias.at), at.alias.node.source, def?.line);
  }
  const chain: (ParsedNode | null)[] = [doc.tree.doc?.contents ?? null, ...at.hops.map((hop) => hop.node)];
  // Removing or renaming an entry is about what holds it: the entry's own anchor, tag or `<<` are not in the way.
  const above = options.sharedAbove ? chain.slice(0, -1) : chain;
  return chainRefusal(doc, path, above, options) ?? at;
}

function chainRefusal(
  doc: WorkflowDocument,
  path: YamlPath,
  chain: readonly (ParsedNode | null)[],
  options: ReachOptions,
): Refusal | undefined {
  const merge = doc.anchors.merges.find(
    (m) => chain.includes(m.map) && !(options.sharedAbove && path.at(-1) === '<<'),
  );
  if (merge) return refusals.mergeKey(doc.path, merge.path, merge.line);
  const tagged = chain.find((node) => node?.tag !== undefined);
  if (tagged)
    return refusals.unsupported(
      doc.path,
      path,
      `${refusals.describe(path)} is under a YAML tag (\`${tagged.tag}\`)`,
    );
  if (options.shared === 'all') return undefined;
  const defs = sharedOn(doc, chain);
  if (defs.length === 0) return undefined;
  const uses = [...new Set(defs.flatMap((def) => def.aliases.map((a) => a.line)))].sort((a, b) => a - b);
  const named = defs.map((def) => ({
    name: def.name,
    line: def.line,
    redefined: doc.anchors.definitions(def.name).length > 1,
  }));
  // As many places as the edit would change: an entry's removal or rename reaches its collection's uses.
  const places = (options.sharedAbove ? entryEquivalents(doc, path) : equivalents(doc, path)).length;
  return refusals.sharedAnchor(doc.path, path, named, uses, places);
}

/** The anchored nodes on a chain that aliases use elsewhere, innermost first. */
function sharedOn(doc: WorkflowDocument, chain: readonly (ParsedNode | null)[]): AnchorDef[] {
  return chain
    .toReversed()
    .map((node) => doc.anchors.definedOn(node))
    .filter((def): def is AnchorDef => def !== undefined && def.aliases.length > 0);
}

/** Not found, or out of range when the missing segment indexes a sequence that exists. */
function missing(doc: WorkflowDocument, path: YamlPath): Refusal {
  for (let n = path.length - 1; n >= 0; n--) {
    const parent = locate(doc.tree, path.slice(0, n));
    if (!parent) continue;
    const segment = path[n];
    if (typeof segment === 'number' && isSeq(parent.node))
      return refusals.outOfRange(doc.path, path.slice(0, n + 1), parent.node.items.length);
    if (typeof segment === 'string' && !isMap(parent.node))
      return refusals.notFound(doc.path, path.slice(0, n + 1));
    return refusals.notFound(doc.path, path.slice(0, n + 1));
  }
  return refusals.notFound(doc.path, path);
}

export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;

/**
 * The paths whose values follow a path's: itself, and, where it sits inside an anchored node, the same place under
 * each alias of that anchor (and their aliases in turn). Only "Change all N uses" ever edits a node that has more
 * than one.
 */
export function equivalents(doc: WorkflowDocument, path: YamlPath, depth = 3): YamlPath[] {
  const out: YamlPath[] = [path];
  if (depth === 0) return out;
  for (const def of doc.anchors.shared) {
    // An anchor on a key names the key's text, which an edit inside the pair does not change.
    const inside = !def.key && def.path.length <= path.length && def.path.every((s, i) => path[i] === s);
    if (!inside) continue;
    const rest = path.slice(def.path.length);
    for (const alias of def.aliases) out.push(...equivalents(doc, [...alias.path, ...rest], depth - 1));
  }
  return out;
}

/**
 * The paths of an entry wherever its collection appears: what removing or renaming the entry changes. The entry's own
 * anchor does not count, as its value is not what changes (the removal of a used anchor is refused before).
 */
export function entryEquivalents(doc: WorkflowDocument, path: YamlPath): YamlPath[] {
  return equivalents(doc, path.slice(0, -1)).map((p) => p.concat(path.at(-1)!));
}

/**
 * Refuses an edit that takes text out of a range in which an anchor is defined that aliases outside the range still
 * use (`anchor`): they would name nothing.
 */
export function orphanedIn(
  doc: WorkflowDocument,
  range: { from: number; to: number },
  path: YamlPath,
): Refusal | undefined {
  const inside = (offset: number) => offset >= range.from && offset < range.to;
  const orphans = doc.anchors.shared.filter(
    (def) => inside(def.from) && def.aliases.some((a) => !inside(a.from)),
  );
  if (orphans.length === 0) return undefined;
  const uses = orphans.flatMap((def) => def.aliases.filter((a) => !inside(a.from)).map((a) => a.line));
  const defs = orphans.map((def) => ({
    name: def.name,
    line: def.line,
    redefined: doc.anchors.definitions(def.name).length > 1,
  }));
  return refusals.orphanedAnchor(
    doc.path,
    path,
    defs,
    [...new Set(uses)].sort((a, b) => a - b),
  );
}
