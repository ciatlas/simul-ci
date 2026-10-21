import { isAlias, isCollection, isMap, isPair, isScalar, isSeq, type ParsedNode } from 'yaml';
import type { AnchorIndex } from './anchors';
import { blockHeader } from './cst';
import { contentEnd, itemSpan, ownStart, ownStarts } from './spans';
import { entriesOf, isFlow, keyOf, locate, toJson, type Collection, type Hop, type Tree } from './tree';
import type { Json, Span, YamlPath } from './types';

/** What is at a path, for reading: a property panel's value, whether a control may edit it, where to reveal it. */
export interface NodeInfo {
  kind: 'scalar' | 'map' | 'seq' | 'alias' | 'null';
  /** The value as plain JSON, aliases resolved; undefined when an alias dangles. */
  value?: Json;
  /** The node's exact text: what a field shows. */
  source: string;
  /** The node's own characters, from its first to the end of its content (not its comment). */
  span: Span;
  /** 1-based. */
  line: number;
  /** Written in flow, or inside a flow collection. */
  flow: boolean;
  block?: 'literal' | 'folded';
  /** The node's own `&anchor`. */
  anchor?: string;
  /** The node is an alias, or the path goes through one: its name. The rest then describes what it names. */
  alias?: string;
  /** The node is, or is inside, an anchored node that aliases use elsewhere; changing it changes them. */
  sharedAnchor?: { name: string; uses: number };
  /** A map on the path uses `<<`. */
  merge: boolean;
}

export interface JobInfo {
  id: string;
  /** 1-based line of the job's key. */
  line: number;
  steps: StepInfo[];
}

/** What identifies a step to the author: what the canvas and the step list show. */
export interface StepInfo {
  index: number;
  id?: string;
  name?: string;
  uses?: string;
  /** The first line of its `run:`. */
  runHead?: string;
  line: number;
}

export function nodeInfo(tree: Tree, anchors: AnchorIndex, path: YamlPath): NodeInfo | undefined {
  const at = locate(tree, path, (alias) => anchors.target(alias));
  if (!at) return undefined;
  const { node } = at;
  const ancestors = [tree.doc?.contents ?? null, ...at.hops.map((hop) => hop.node)];
  const span = nodeSpan(tree, node, at.hops.at(-1));
  const info: NodeInfo = {
    kind: kindOf(node),
    source: tree.text.slice(span.from, span.to),
    span,
    line: tree.lines.lineAt(span.from) + 1,
    flow: ancestors.some((n) => isFlow(n)),
    merge: ancestors.some((n) => anchors.merges.some((m) => m.map === n)),
  };
  const value = toJson(tree, isAlias(node) ? (anchors.target(node) ?? node) : node);
  if (value !== undefined) info.value = value as Json;
  if (isScalar(node) && node.srcToken?.type === 'block-scalar') info.block = blockStyle(node);
  if (node?.anchor) info.anchor = node.anchor;
  if (at.alias) info.alias = at.alias.node.source;
  const shared = ancestors
    .toReversed()
    .map((n) => anchors.definedOn(n))
    .find((def) => def && def.aliases.length > 0);
  if (shared) info.sharedAnchor = { name: shared.name, uses: shared.aliases.length };
  return info;
}

function kindOf(node: ParsedNode | null): NodeInfo['kind'] {
  if (isAlias(node)) return 'alias';
  if (isMap(node)) return 'map';
  if (isSeq(node)) return 'seq';
  return isScalar(node) && node.value !== null ? 'scalar' : 'null';
}

function blockStyle(node: ParsedNode): 'literal' | 'folded' {
  return blockHeader(node.srcToken).startsWith('>') ? 'folded' : 'literal';
}

/** A node's own characters: its start to its content's end. An empty value is an empty span where it would be. */
function nodeSpan(tree: Tree, node: ParsedNode | null, hop: Hop | undefined): Span {
  if (!node) {
    const at = hop?.pair ? hop.pair.key.range[1] : 0;
    return { from: at, to: at };
  }
  const from = node.range[0];
  return { from, to: Math.max(from, contentEnd(tree, node)) };
}

/**
 * The path of the innermost item whose lines hold the offset: the pane's cursor. A block item holds its own lines,
 * from its key or `-` (the line's indentation included) to the end of its content's line; a flow item holds its own
 * characters, both ends included.
 */
export function pathAt(tree: Tree, offset: number): YamlPath {
  const path: (string | number)[] = [];
  let node: ParsedNode | null = tree.doc?.contents ?? null;
  for (;;) {
    const next = isCollection(node) ? childAt(tree, node, offset) : undefined;
    if (!next) return path;
    path.push(next.segment);
    node = next.node;
  }
}

/** The item that holds an offset: the last one starting at or before it, when its content's lines reach it. */
function childAt(tree: Tree, parent: Collection, offset: number) {
  const { lines } = tree;
  const flow = isFlow(parent);
  const owns = ownStarts(parent);
  const starts = owns.map((own) => (flow || !lines.startsLine(own) ? own : lines.start(lines.lineAt(own))));
  const index = lastAtOrBefore(starts, offset);
  if (index === -1) return undefined;
  const item = parent.items[index]!;
  const end = contentEnd(tree, item);
  const holds = flow ? offset <= end : offset < lines.end(lines.lineAt(Math.max(end - 1, owns[index]!)));
  const segment = isPair(item) ? keyOf(item) : index;
  if (!holds || segment === undefined) return undefined;
  return { segment, node: isPair(item) ? item.value : item };
}

/** The index of the last sorted value at or before `at`, or -1. */
function lastAtOrBefore(sorted: readonly number[], at: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The lines the item at a path owns (§ 2.5 of the design); the whole text for the root. */
export function spanOf(tree: Tree, path: YamlPath): Span | undefined {
  if (path.length === 0) return tree.doc ? { from: 0, to: tree.text.length } : undefined;
  const hop = locate(tree, path)?.hops[path.length - 1];
  if (!hop) return undefined;
  const { from, to } = itemSpan(tree, hop.parent, hop.index);
  return { from, to };
}

/** The 1-based line of the item at a path: its key's, or its `-`'s. */
export function lineOf(tree: Tree, path: YamlPath): number | undefined {
  if (path.length === 0) return tree.doc ? 1 : undefined;
  const hop = locate(tree, path)?.hops[path.length - 1];
  if (!hop) return undefined;
  return tree.lines.lineAt(itemSpan(tree, hop.parent, hop.index).own) + 1;
}

/** The jobs and their steps, as the author sees them; aliased jobs and steps are read through. */
export function jobsOf(tree: Tree, anchors: AnchorIndex): JobInfo[] {
  const resolve = (node: ParsedNode | null) => (isAlias(node) ? (anchors.target(node) ?? null) : node);
  const jobs = resolve(locate(tree, ['jobs'])?.node ?? null);
  return entriesOf(isMap(jobs) ? jobs : null).map(({ segment, pair, node }) => ({
    id: String(segment),
    line: tree.lines.lineAt(pair!.key.range[0]) + 1,
    steps: stepsOf(tree, resolve, resolve(node)),
  }));
}

function stepsOf(
  tree: Tree,
  resolve: (node: ParsedNode | null) => ParsedNode | null,
  job: ParsedNode | null,
): StepInfo[] {
  const steps = resolve(entriesOf(isMap(job) ? job : null).find((e) => e.segment === 'steps')?.node ?? null);
  if (!isSeq(steps)) return [];
  return entriesOf(steps).map(({ node }, index) => {
    const fields = new Map(entriesOf(resolve(node)).map((e) => [e.segment, textOf(resolve(e.node))]));
    const own = isFlow(steps) ? node!.range[0] : ownStart(steps as Collection, index);
    const step: StepInfo = { index, line: tree.lines.lineAt(own) + 1 };
    for (const key of ['id', 'name', 'uses'] as const)
      if (fields.get(key) !== undefined) step[key] = fields.get(key);
    const run = fields.get('run');
    if (run !== undefined) step.runHead = run.split('\n')[0];
    return step;
  });
}

/** A scalar's value as text, as GitHub reads a scalar where it expects a string; undefined for null and collections. */
function textOf(node: ParsedNode | null): string | undefined {
  const value: unknown = isScalar(node) ? node.value : undefined;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

/**
 * The unit path of the job or step a path is in, as the engine names them: `build`, `build.detect` for a step with an
 * id, `build.#3` for the third step without one. Undefined outside the jobs.
 */
export function unitPathIn(jobs: readonly JobInfo[], path: YamlPath): string | undefined {
  if (path[0] !== 'jobs' || typeof path[1] !== 'string') return undefined;
  const job = jobs.find((j) => j.id === path[1]);
  if (!job) return undefined;
  if (path[2] !== 'steps' || typeof path[3] !== 'number') return job.id;
  const step = job.steps[path[3]];
  if (!step) return job.id;
  return `${job.id}.${step.id ?? `#${step.index + 1}`}`;
}

/**
 * The path of the job or step a unit path names, in this file. A leg selector names its job (legs share the job's
 * text); a step of a called workflow or of a composite action names the calling job or step, the nearest node here.
 */
export function yamlPathIn(jobs: readonly JobInfo[], unitPath: string): YamlPath | undefined {
  const head = headOf(withoutQualifier(unitPath).trim());
  if (!head) return undefined;
  const { id, stepName } = head;
  const job = jobs.find((j) => j.id === id) ?? jobs.find((j) => j.id.toLowerCase() === id.toLowerCase());
  if (!job) return undefined;
  if (stepName === undefined) return ['jobs', job.id];
  const index = stepIndex(job, stepName);
  return index === undefined ? undefined : ['jobs', job.id, 'steps', index];
}

function stepIndex(job: JobInfo, name: string): number | undefined {
  const position = /^#(\d+)$/.exec(name);
  if (position) {
    const index = Number(position[1]) - 1;
    return index >= 0 && index < job.steps.length ? index : undefined;
  }
  return job.steps.find((step) => step.id === name)?.index;
}

/**
 * A unit path's job and step, up to a `/` that leaves the file (a called workflow's job, a composite's inner step). A
 * leg selector's brackets nest and hide what they hold, so a matrix value may hold `/`, `.` or brackets
 * (`build[dir=packages/a].x`, `build[install=.[dev]]`).
 */
function headOf(path: string): { id: string; stepName?: string } | undefined {
  const idEnd = scanTo(path, 0, '[./');
  const legEnd = path[idEnd] === '[' ? closingOf(path, idEnd) : idEnd;
  if (idEnd === 0 || legEnd < 0 || (legEnd < path.length && !'./'.includes(path[legEnd]!))) return undefined;
  const id = path.slice(0, idEnd);
  if (path[legEnd] !== '.') return { id };
  const end = path.indexOf('/', legEnd);
  return { id, stepName: path.slice(legEnd + 1, end === -1 ? undefined : end) };
}

/** The first index from `from` holding one of `stops`, else the end. */
function scanTo(text: string, from: number, stops: string): number {
  let at = from;
  while (at < text.length && !stops.includes(text[at]!)) at++;
  return at;
}

/** Just past the `]` that closes the `[` at `open`; -1 when none does. */
function closingOf(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === '[') depth++;
    else if (text[at] === ']' && --depth === 0) return at + 1;
  }
  return -1;
}

/** `ci.yml:build.test` → `build.test`: the colon outside a leg selector ends the workflow qualifier. */
function withoutQualifier(unitPath: string): string {
  const colon = unitPath.split('[')[0]!.indexOf(':');
  return colon === -1 ? unitPath : unitPath.slice(colon + 1);
}
