import { blockOf, indentLines, inlineScalar, type Place, type Scalar } from './scalar';
import { familyOf, type Style } from './style';
import type { Json, YamlPath } from './types';

/**
 * A new value as text in the file's style: what follows `key:` or `- ` on its line (`head`, '' for nothing), and the
 * lines after it, already indented. Only new nodes are rendered; nothing that exists is ever printed again.
 */
export interface Rendered {
  head: string;
  rest: string[];
}

export interface RenderContext {
  style: Style;
  /** The column of a new sequence item's first key, from its `-`: 2, or what the sequence's own items use. */
  itemKeyOffset?: number;
  /** The indentation of a comment right after the new text: block scalars go deeper, else on one line. */
  blockLimit?: number;
}

/**
 * A value written after the key or dash at `column`. `path` is the value's own path: list families (§ 2.6) follow it.
 * Undefined when a scalar in it cannot be written.
 */
export function renderValue(
  value: Json,
  column: number,
  path: YamlPath,
  place: 'value' | 'item',
  ctx: RenderContext,
): Rendered | undefined {
  if (Array.isArray(value)) return renderList(value, column, path, place, ctx);
  if (value !== null && typeof value === 'object') return renderMap(value, column, path, ctx);
  return renderScalar(value, column, place, ctx);
}

function renderScalar(value: Scalar, column: number, place: Place, ctx: RenderContext): Rendered | undefined {
  const { style } = ctx;
  if (value === null) return { head: '', rest: [] };
  const deep = column + style.indent > (ctx.blockLimit ?? -1);
  const block = typeof value === 'string' && value.includes('\n') && deep ? blockOf(value) : undefined;
  if (block) return { head: block.header, rest: indentLines(block.lines, column + style.indent) };
  const head = inlineScalar(value, place, style);
  return head === undefined ? undefined : { head, rest: [] };
}

function renderMap(
  value: { [key: string]: Json },
  column: number,
  path: YamlPath,
  ctx: RenderContext,
): Rendered | undefined {
  const entries = Object.entries(value);
  if (entries.length === 0) return { head: '{}', rest: [] };
  const rest: string[] = [];
  for (const [key, child] of entries) {
    const lines = renderPair(key, child, column + ctx.style.indent, [...path, key], ctx);
    if (!lines) return undefined;
    rest.push(...lines);
  }
  return { head: '', rest };
}

function renderList(
  value: Json[],
  column: number,
  path: YamlPath,
  place: 'value' | 'item',
  ctx: RenderContext,
): Rendered | undefined {
  if (value.length === 0) return { head: '[]', rest: [] };
  const flow = place === 'value' ? flowList(value, column, path, ctx.style) : undefined;
  if (flow !== undefined) return { head: flow, rest: [] };
  const dash = place === 'item' ? column + 2 : column + (ctx.style.indentSeq ? ctx.style.indent : 0);
  const rest: string[] = [];
  for (const [i, item] of value.entries()) {
    const lines = renderItem(item, dash, [...path, i], ctx);
    if (!lines) return undefined;
    rest.push(...lines);
  }
  return { head: '', rest };
}

/**
 * A short list of scalars in flow (`[a, b]`) when its family is written in flow, or, in a file where no list says,
 * when it has at most 4 items and fits in 100 columns. Never with an item holding `${{`: in flow it would need quotes
 * GitHub's own examples never use, so such lists are written in block.
 */
function flowList(value: Json[], column: number, path: YamlPath, style: Style): string | undefined {
  const scalars = value.every((v) => v === null || typeof v !== 'object');
  if (!scalars || value.some((v) => typeof v === 'string' && v.includes('${{'))) return undefined;
  const items = (value as Scalar[]).map((v) => inlineScalar(v, 'flow', style));
  if (items.some((i) => i === undefined)) return undefined;
  const pad = style.flowPadding ? ' ' : '';
  const text = `[${pad}${items.join(', ')}${pad}]`;
  const flow = style.flow[familyOf(path)];
  const short = value.length <= 4 && column + String(path.at(-1)).length + 2 + text.length <= 100;
  return (flow ?? short) ? text : undefined;
}

/** A key and its value as lines, the key at `column`. */
export function renderPair(
  key: string,
  value: Json,
  column: number,
  path: YamlPath,
  ctx: RenderContext,
): string[] | undefined {
  const text = keyText(key, ctx.style);
  const rendered = renderValue(value, column, path, 'value', ctx);
  if (text === undefined || !rendered) return undefined;
  const head = rendered.head === '' ? '' : ` ${rendered.head}`;
  return [`${' '.repeat(column)}${text}:${head}`, ...rendered.rest];
}

/**
 * A sequence item as lines, its `-` at `column`. A map item is compact: its first key on the dash's line, the others
 * under it.
 */
export function renderItem(
  value: Json,
  column: number,
  path: YamlPath,
  ctx: RenderContext,
): string[] | undefined {
  const dash = `${' '.repeat(column)}-`;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
    const offset = ctx.itemKeyOffset ?? 2;
    const rendered = renderMap(value, column + offset - ctx.style.indent, path, ctx);
    if (!rendered) return undefined;
    const [first, ...rest] = rendered.rest;
    return [`${dash}${' '.repeat(offset - 1)}${first!.trimStart()}`, ...rest];
  }
  const rendered = renderValue(value, column, path, 'item', ctx);
  if (!rendered) return undefined;
  return [rendered.head === '' ? dash : `${dash} ${rendered.head}`, ...rendered.rest];
}

/**
 * A map on one line in flow (`{ event: push, branch: main }`), padded inside its braces or not; its lists of scalars
 * padded as the file pads them. Undefined when a value cannot go there: a string holding `${{` (G5) or a line break, a
 * map inside a list, or a scalar that does not read back.
 */
export function flowMap(value: { [key: string]: Json }, style: Style, padded: boolean): string | undefined {
  const pairs: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const name = inlineScalar(key, 'flowKey', style);
    const text = flowValue(child, style, padded);
    if (name === undefined || text === undefined) return undefined;
    pairs.push(`${name}: ${text}`);
  }
  const pad = padded && pairs.length > 0 ? ' ' : '';
  return `{${pad}${pairs.join(', ')}${pad}}`;
}

function flowValue(value: Json, style: Style, padded: boolean): string | undefined {
  if (Array.isArray(value)) return flowItems(value, style);
  if (value !== null && typeof value === 'object') return flowMap(value, style, padded);
  return flowScalar(value, style);
}

/** A list of scalars in brackets, padded as the file pads them; none for a list holding a collection. */
function flowItems(value: Json[], style: Style): string | undefined {
  const items: string[] = [];
  for (const item of value) {
    const text = item !== null && typeof item === 'object' ? undefined : flowScalar(item, style);
    if (text === undefined) return undefined;
    items.push(text);
  }
  const pad = style.flowPadding && items.length > 0 ? ' ' : '';
  return `[${pad}${items.join(', ')}${pad}]`;
}

const flowScalar = (value: Scalar, style: Style): string | undefined =>
  typeof value === 'string' && (value.includes('${{') || value.includes('\n'))
    ? undefined
    : inlineScalar(value, 'flow', style);

/** A map key: plain when it reads back as itself, else quoted. */
function keyText(key: string, style: Style): string | undefined {
  return inlineScalar(key, 'key', style);
}

/** Every line break YAML 1.1 parsers like GitHub's know (yaml 2.9 knows only CR and LF). */
const BREAK = /\r\n|[\r\n\u{85}\u{2028}\u{2029}]/u;
const UNPRINTABLE = /(?!\t)\p{Cc}|[\u{feff}\u{fffe}\u{ffff}]/gu;
const TRAILING_BREAKS = /[\r\n\u{85}\u{2028}\u{2029}]+$/u;

/**
 * Comment lines at a column: `# text`, or `#` alone for an empty line. A comment holding a line break is written as
 * several lines (a break would end the comment and start YAML), and characters YAML does not allow are dropped.
 */
export const commentLines = (comments: readonly string[], column: number): string[] =>
  comments
    .flatMap((c) => c.replace(TRAILING_BREAKS, '').split(BREAK))
    .map((c) => c.replace(UNPRINTABLE, ''))
    .map((c) => `${' '.repeat(column)}#${c === '' ? '' : ` ${c}`}`);

/**
 * Whether text holds a block scalar that keeps its last line break (`|`, `|+`, `>`): at the end of a file it must
 * end with a break, which the YAML spec (and GitHub's parser) reads as part of the value, though yaml 2.9 does not.
 */
export function opensBlock(lines: readonly string[]): boolean {
  return lines.some((line) => /(?:^|[\s:-])[|>][1-9]?\+?(?:[ \t]+#.*)?$/.test(line));
}
