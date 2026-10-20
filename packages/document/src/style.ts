import { isMap, isScalar, isSeq, type CST, type ParsedNode, type YAMLSeq } from 'yaml';
import { walkTokens } from './cst';
import { itemSpan } from './spans';
import { entriesOf, isFlow, locate, walkNodes, type Collection, type Tree } from './tree';
import type { Eol, YamlPath } from './types';

/** The kinds of short lists whose flow or block form a file keeps per kind. */
export type ListFamily = 'needs' | 'filters' | 'types' | 'matrix' | 'runs-on' | 'other';

/** How a file writes YAML, read once per parse so that new text looks like the text around it. */
export interface Style {
  /** Spaces per block-map level; 2 when nothing says. */
  indent: number;
  /** `key:\n  - x` (true) or `key:\n- x` (false). A sequence's own `-` column wins where it already exists. */
  indentSeq: boolean;
  quote: "'" | '"';
  /** `[ a, b ]` (true) or `[a, b]`. */
  flowPadding: boolean;
  /**
   * Whether lists of a family are written in flow (`[a, b]`). Undefined when no short list in the file says either
   * way: then a list is written in flow when it has at most 4 items and fits in 100 columns.
   */
  flow: Record<ListFamily, boolean | undefined>;
  /** `if: x == y` (bare) or `if: ${{ x == y }}` (wrapped). */
  ifStyle: 'bare' | 'wrapped';
  /** CRLF when every line break is one; a file with mixed breaks never reaches an op. */
  eol: Eol;
  finalNewline: boolean;
  /** Whether jobs, and steps, are separated by blank lines. */
  blank: { jobs: boolean; steps: boolean };
  /** Spaces before an inline `#`. */
  commentGap: number;
}

const FAMILIES: readonly ListFamily[] = ['needs', 'filters', 'types', 'matrix', 'runs-on', 'other'];
const FILTERS = ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore', 'workflows'];
const FAMILY_OF_KEY = new Map<string, ListFamily>([
  ['needs', 'needs'],
  ['types', 'types'],
  ['runs-on', 'runs-on'],
  ...FILTERS.map((key): [string, ListFamily] => [key, 'filters']),
]);

/** The style of a text that was not parsed: what its characters say, defaults for the rest. */
export function textStyle(text: string): Style {
  return {
    indent: 2,
    indentSeq: true,
    quote: "'",
    flowPadding: false,
    flow: {
      needs: undefined,
      filters: undefined,
      types: undefined,
      matrix: undefined,
      'runs-on': undefined,
      other: undefined,
    },
    ifStyle: 'bare',
    eol: eolOf(text),
    finalNewline: text.endsWith('\n'),
    blank: { jobs: false, steps: false },
    commentGap: 1,
  };
}

export function inferStyle(tree: Tree): Style {
  const tokens = tokenCounts(tree);
  const nodes = nodeCounts(tree);
  return {
    ...textStyle(tree.text),
    indent: mode(tokens.indents) ?? 2,
    indentSeq: tokens.seqFlush <= tokens.seqIndented,
    quote: tokens.double > tokens.single ? '"' : "'",
    flowPadding: tokens.padded > tokens.tight,
    flow: flowByFamily(nodes.lists),
    ifStyle: nodes.wrappedIf > nodes.bareIf ? 'wrapped' : 'bare',
    blank: { jobs: blankJobs(tree), steps: blankSteps(tree) },
    commentGap: mode(tokens.gaps) ?? 1,
  };
}

/** CRLF when the text has line breaks and every one is CRLF. */
export function eolOf(text: string): Eol {
  const lf = text.split('\n').length - 1;
  const crlf = text.split('\r\n').length - 1;
  return lf > 0 && lf === crlf ? '\r\n' : '\n';
}

interface TokenCounts {
  indents: number[];
  seqIndented: number;
  seqFlush: number;
  single: number;
  double: number;
  padded: number;
  tight: number;
  gaps: number[];
}

function tokenCounts(tree: Tree): TokenCounts {
  const counts: TokenCounts = {
    indents: [],
    seqIndented: 0,
    seqFlush: 0,
    single: 0,
    double: 0,
    padded: 0,
    tight: 0,
    gaps: [],
  };
  walkTokens(tree.tokens, (token) => {
    if (token.type === 'block-map') countNesting(token, counts);
    else if (token.type === 'single-quoted-scalar') counts.single++;
    // A double-quoted scalar with escapes needs its quotes; it says nothing about the file's preference.
    else if (token.type === 'double-quoted-scalar' && !token.source.includes('\\')) counts.double++;
    else if (token.type === 'flow-collection') countPadding(tree.text, token, counts);
    else if (token.type === 'comment') countGap(tree, token, counts);
  });
  return counts;
}

/** The indent step of block maps nested in a block map, and whether sequences under its keys are indented. */
function countNesting(map: CST.BlockMap, counts: TokenCounts): void {
  for (const { value } of map.items) {
    if (value?.type === 'block-map' && value.indent > map.indent)
      counts.indents.push(value.indent - map.indent);
    if (value?.type === 'block-seq') {
      if (value.indent > map.indent) counts.seqIndented++;
      else counts.seqFlush++;
    }
  }
}

function countPadding(text: string, token: CST.FlowCollection, counts: TokenCounts): void {
  if (token.items.length === 0) return;
  const next = text[token.start.offset + 1];
  if (next === ' ') counts.padded++;
  else if (next !== '\n' && next !== '\r') counts.tight++;
}

/** Spaces before a comment that follows content on its line. */
function countGap(tree: Tree, token: CST.SourceToken, counts: TokenCounts): void {
  const before = tree.text.slice(tree.lines.start(tree.lines.lineAt(token.offset)), token.offset);
  const content = before.trimEnd();
  if (content.trim() !== '') counts.gaps.push(before.length - content.length);
}

interface NodeCounts {
  lists: { family: ListFamily; flow: boolean }[];
  wrappedIf: number;
  bareIf: number;
}

function nodeCounts(tree: Tree): NodeCounts {
  const counts: NodeCounts = { lists: [], wrappedIf: 0, bareIf: 0 };
  walkNodes(tree.doc?.contents ?? null, (node, path, isKey) => {
    if (isKey) return;
    if (isScalarList(node)) counts.lists.push({ family: familyOf(path), flow: isFlow(node) });
    if (path.at(-1) === 'if' && isScalar(node) && typeof node.value === 'string') {
      if (/^\s*\$\{\{[\s\S]*\}\}\s*$/.test(node.value)) counts.wrappedIf++;
      else counts.bareIf++;
    }
  });
  return counts;
}

function isScalarList(node: ParsedNode | null): node is YAMLSeq.Parsed {
  return isSeq(node) && node.items.length > 0 && node.items.every((item) => isScalar(item));
}

/** The family of the list at a path: by its key, and for matrix dimensions by where the key is. */
export function familyOf(path: YamlPath): ListFamily {
  const key = String(path.at(-1));
  const inMatrix = path.at(-3) === 'strategy' && path.at(-2) === 'matrix';
  if (inMatrix && key !== 'include' && key !== 'exclude') return 'matrix';
  return FAMILY_OF_KEY.get(key) ?? 'other';
}

/** The majority per family; a family the file does not use, or ties on, takes the majority over all its lists. */
function flowByFamily(lists: readonly { family: ListFamily; flow: boolean }[]): Style['flow'] {
  const all = majority(lists);
  const out = {} as Style['flow'];
  for (const family of FAMILIES)
    out[family] = majority(lists.filter((list) => list.family === family)) ?? all;
  return out;
}

function majority(lists: readonly { flow: boolean }[]): boolean | undefined {
  const flow = lists.filter((list) => list.flow).length;
  const block = lists.length - flow;
  return flow === block ? undefined : flow > block;
}

function blankJobs(tree: Tree): boolean {
  const jobs = locate(tree, ['jobs'])?.node;
  return isMap(jobs) ? (blankSeparated(tree, jobs) ?? false) : false;
}

function blankSteps(tree: Tree): boolean {
  const jobs = locate(tree, ['jobs'])?.node;
  let blank = 0;
  let packed = 0;
  for (const job of entriesOf(isMap(jobs) ? jobs : null)) {
    const steps = locate(tree, ['jobs', job.segment, 'steps'])?.node;
    if (!isSeq(steps) || isFlow(steps)) continue;
    const gaps = separators(tree, steps as Collection);
    blank += gaps.filter(Boolean).length;
    packed += gaps.filter((gap) => !gap).length;
  }
  return blank > 0 && blank >= packed;
}

/**
 * Whether a block collection separates its items with blank lines (ties count as separated); undefined when it has
 * fewer than two items or is written in flow.
 */
export function blankSeparated(tree: Tree, collection: Collection): boolean | undefined {
  if (isFlow(collection) || collection.items.length < 2) return undefined;
  const gaps = separators(tree, collection);
  return gaps.filter(Boolean).length * 2 >= gaps.length;
}

/** For each item after the first, whether a blank line comes right before it (and its leading comments). */
function separators(tree: Tree, collection: Collection): boolean[] {
  const { lines } = tree;
  return collection.items.slice(1).map((_, i) => {
    const line = lines.lineAt(itemSpan(tree, collection, i + 1).from);
    return line > 0 && lines.kind(line - 1).kind === 'blank';
  });
}

/** The most common value, the smallest on a tie. */
function mode(values: readonly number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: [number, number] | undefined;
  for (const [value, count] of counts)
    if (!best || count > best[1] || (count === best[1] && value < best[0])) best = [value, count];
  return best?.[0];
}
