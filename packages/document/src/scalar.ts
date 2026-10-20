import { isMap, isScalar, parseDocument, type CST, type ParsedNode } from 'yaml';
import { blockHeader } from './cst';
import type { TextEdit } from './edits';
import type { Lines } from './lines';
import type { Style } from './style';
import type { Eol } from './types';

export type Scalar = string | number | boolean | null;

/** Where a one-line scalar is written: a map value, a sequence item, a flow item, a block map's key or a flow map's. */
export type Place = 'value' | 'item' | 'flow' | 'key' | 'flowKey';

/**
 * Characters only a double-quoted scalar may hold: controls but the tab (and a line break, in a block), NEL and the
 * line and paragraph separators (line breaks to YAML 1.1 parsers like GitHub's, though not to yaml 2.9), the byte
 * order mark and the non-characters U+FFFE and U+FFFF.
 */
const ESCAPE_ONLY = /(?![\t\n])\p{Cc}|[\u{2028}\u{2029}\u{feff}\u{fffe}\u{ffff}]/u;

type Quote = 'plain' | "'" | '"';

/**
 * The text of a one-line scalar that reads back as `value` where it is written. The token's own style is tried first
 * (`plain` for a new one), then single quotes, or double quotes when the file prefers them or the value holds a `'`.
 * Undefined when nothing reads back, which no JSON scalar a workflow holds should reach.
 */
export function inlineScalar(
  value: Scalar,
  place: Place,
  style: Style,
  first: Quote = 'plain',
): string | undefined {
  if (typeof value !== 'string') return readsBack(String(value), value, place) ? String(value) : undefined;
  for (const kind of quoteOrder(value, style, first)) {
    const text = kind === 'plain' && !plainAllowed(value, place) ? undefined : quoted(value, kind);
    if (text !== undefined && readsBack(text, value, place)) return text;
  }
  return undefined;
}

/** The token's own style first (plain for a new one), then the file's quote, or double when the value holds a `'`. */
function quoteOrder(value: string, style: Style, first: Quote): Quote[] {
  const other = (quote: Quote): Quote => (quote === '"' ? "'" : '"');
  const quote: Quote = value.includes("'") ? '"' : style.quote;
  return first === 'plain' ? ['plain', quote, other(quote)] : [first, other(first)];
}

/**
 * Plain is not tried where other parsers read the text differently from yaml 2.9: a key `<<` (a merge key to YAML
 * 1.1), and a `:` inside a flow collection (libyaml refuses `[node:18]`).
 */
function plainAllowed(value: string, place: Place): boolean {
  if ((place === 'key' || place === 'flowKey') && value === '<<') return false;
  return !((place === 'flow' || place === 'flowKey') && value.includes(':'));
}

function quoted(value: string, kind: Quote): string | undefined {
  if (kind === 'plain') return value.includes('\n') || ESCAPE_ONLY.test(value) ? undefined : value;
  if (kind === "'")
    return value.includes('\n') || ESCAPE_ONLY.test(value) ? undefined : `'${value.replaceAll("'", "''")}'`;
  // JSON's escapes are YAML's; YAML also wants DEL, the C1 controls, the separators and the non-characters escaped.
  return JSON.stringify(value).replace(
    /[\x7f-\x9f\u{2028}\u{2029}\u{feff}\u{fffe}\u{ffff}]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Whether `text`, written at `place`, parses with core's options to exactly `value`, with no error or warning. */
export function readsBack(text: string, value: Scalar, place: Place): boolean {
  const source = {
    value: `k: ${text}\n`,
    item: `- ${text}\n`,
    flow: `[${text}]\n`,
    key: `${text}: k\n`,
    flowKey: `{${text}: k}\n`,
  }[place];
  const doc = parseDocument(source, { strict: false });
  if (doc.errors.length > 0 || doc.warnings.length > 0) return false;
  // An alias that names nothing (`*star`) is no error to yaml; only reading it throws.
  let js: unknown;
  try {
    js = doc.toJS();
  } catch {
    return false;
  }
  // A key must read as the string itself: `true:` is a boolean key that only reads as "true" once stringified.
  if (place === 'key' || place === 'flowKey') {
    const key =
      isMap(doc.contents) && doc.contents.items.length === 1 ? doc.contents.items[0]!.key : undefined;
    return isScalar(key) && key.value === value;
  }
  return Object.is(readPlace(js, place), value);
}

function readPlace(js: unknown, place: Place): unknown {
  if (place === 'value') return (js as { k?: unknown } | null)?.k;
  return Array.isArray(js) && js.length === 1 ? js[0] : undefined;
}

/**
 * A text without the characters of a set that end it (by hand: a `[…]+$` regex is polynomial on a text holding many
 * of them before something else).
 */
export function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** A multi-line string as a block scalar: its header and its lines, not yet indented. */
export interface Block {
  header: string;
  lines: string[];
}

/**
 * A string as a block scalar: literal (`|`), or folded (`>`) when asked and the value has no line break inside, with
 * the chomping its trailing line breaks need (`|-` none, `|` one, `|+` more). Undefined for what a block scalar
 * cannot hold as written: a carriage return or another control character, or a first line that starts with a space
 * (it would need an indentation indicator); such a value is double-quoted instead.
 */
export function blockOf(value: string, folded = false, keep = false): Block | undefined {
  if (ESCAPE_ONLY.test(value)) return undefined;
  const content = trimEnd(value, '\n');
  const trailing = value.length - content.length;
  // A new `|+` would take in the blank lines that follow it in the file: only one already there stays kept.
  if (trailing > 1 && !keep) return undefined;
  const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
  const lines = (trailing > 1 ? value.slice(0, -1) : content).split('\n');
  // A first line starting with a space or a tab would need an indentation indicator (libyaml refuses the tab).
  if (/^[ \t]/.test(lines.find((line) => line !== '') ?? '')) return undefined;
  const block = folded ? foldedBlock(content, chomp) : undefined;
  if (block && readsBackBlock(block, value)) return block;
  const literal = { header: `|${chomp}`, lines };
  return readsBackBlock(literal, value) ? literal : undefined;
}

/**
 * A value as a folded block (`>`), whose lines fold into spaces: a line break of the value is written as an empty
 * line, `n` of them as `n` empty lines. Undefined for a line that starts with a space (it would not fold).
 */
function foldedBlock(content: string, chomp: string): Block | undefined {
  const parts = content.split(/(\n+)/);
  if (parts.some((part, i) => i % 2 === 0 && /^[ \t]/.test(part))) return undefined;
  const lines = parts.flatMap((part, i) => (i % 2 === 0 ? [part] : Array<string>(part.length).fill('')));
  return { header: `>${chomp}`, lines };
}

function readsBackBlock(block: Block, value: string): boolean {
  const body = block.lines.map((line) => (line === '' ? '' : `  ${line}`)).join('\n');
  const doc = parseDocument(`k: ${block.header}\n${body}\n`, { strict: false });
  return (
    doc.errors.length === 0 &&
    doc.warnings.length === 0 &&
    (doc.toJS() as { k?: unknown } | null)?.k === value
  );
}

/** A block scalar's lines at a column, with empty lines left empty. */
export const indentLines = (lines: readonly string[], column: number): string[] =>
  lines.map((line) => (line === '' ? '' : `${' '.repeat(column)}${line}`));

/** Where a scalar is in the text, and how it is written. */
export interface ScalarSite {
  node: ParsedNode;
  lines: Lines;
  style: Style;
  place: Place;
  /** The column of the key or dash the scalar belongs to. */
  column: number;
  /** The column a new block body goes to: the owning key's or dash's column plus the file's indent. */
  bodyColumn: number;
}

/**
 * The splices that write a new value into an existing scalar, keeping what surrounds the token: the key, an inline
 * comment, a block header's comment. Strings with line breaks become (or stay) block scalars outside flow
 * collections; every line break written is the file's. Undefined when the value cannot be written.
 */
export function writeScalar(site: ScalarSite, value: Scalar): TextEdit[] | undefined {
  const { node } = site;
  if (isScalar(node) && Object.is(node.value, value)) return [];
  // `key:` with nothing after it: an empty value reads as null, as GitHub writes an event with no filters.
  if (value === null && site.place === 'value') return writeEmpty(site);
  const block = typeof value === 'string' ? blockWrite(site, value) : undefined;
  if (block) return block;
  const text = inlineScalar(value, site.place, site.style, tokenQuote(node.srcToken));
  return text === undefined ? undefined : writeInline(site, text);
}

/**
 * A string written as a block scalar: one with line breaks outside a flow collection, or any string into a folded
 * one (`if: >-`), whose header stays when the value has no line break. Undefined when it goes on one line instead.
 */
function blockWrite(site: ScalarSite, value: string): TextEdit[] | undefined {
  const header = blockHeader(site.node.srcToken);
  const multiLine = value.includes('\n');
  if (multiLine && site.place === 'flow') return undefined;
  if (!multiLine && !header.startsWith('>')) return undefined;
  const block = blockOf(value, header.startsWith('>'), header.includes('+'));
  return block && writeBlock(site, block);
}

/** How a scalar token is quoted: the style a rewrite tries first. */
export function tokenQuote(token: CST.Token | undefined): Quote {
  if (token?.type === 'single-quoted-scalar') return "'";
  if (token?.type === 'double-quoted-scalar') return '"';
  return 'plain';
}

/** A one-line text in place of the token; a block scalar's body goes with its old header. */
function writeInline(site: ScalarSite, text: string): TextEdit[] {
  const { node, lines } = site;
  const [start, end] = node.range;
  // `"5"# minutes`: a comment right after a quoted token needs a space once the token is plain.
  const touching = lines.text[end] === '#' ? ' ' : '';
  if (node.srcToken?.type !== 'block-scalar') return [{ from: start, to: end, insert: text + touching }];
  const header = headerToken(node.srcToken)!;
  const body = bodyRange(lines, node);
  return [
    { from: header.offset, to: header.offset + header.source.length, insert: text },
    { from: body.from, to: body.to, insert: '' },
  ];
}

function writeEmpty(site: ScalarSite): TextEdit[] {
  const { node, lines } = site;
  let from = node.range[0];
  while (from > 0 && (lines.text[from - 1] === ' ' || lines.text[from - 1] === '\t')) from--;
  const edits = writeInline(site, '');
  edits[0] = { ...edits[0]!, from: Math.min(edits[0]!.from, from) };
  return edits;
}

/**
 * A block scalar in place of the token; undefined when a comment below it is as deep as its lines would be (YAML
 * would read the comment as part of it), and the value is then written on one line.
 */
function writeBlock(site: ScalarSite, block: Block): TextEdit[] | undefined {
  return site.node.srcToken?.type === 'block-scalar' ? rewriteBlock(site, block) : newBlock(site, block);
}

/** A block scalar rewritten: its header token if it changes, its body in the body's own column. */
function rewriteBlock(site: ScalarSite, block: Block): TextEdit[] | undefined {
  const { node, lines, style } = site;
  const header = headerToken(node.srcToken as CST.BlockScalar)!;
  const body = bodyRange(lines, node);
  // With an indentation indicator the body's column is the owner's plus the indicator, not its first line's.
  const indicator = /\d/.exec(header.source)?.[0];
  const column = indicator ? site.column + Number(indicator) : (bodyIndent(lines, body) ?? site.bodyColumn);
  if (column <= (lines.commentAfter(body.to) ?? -1)) return undefined;
  const text = indentLines(block.lines, column).join(style.eol);
  const lead = body.lead ? style.eol : '';
  const edits: TextEdit[] = [];
  if (header.source !== block.header)
    edits.push({ from: header.offset, to: header.offset + header.source.length, insert: block.header });
  edits.push({
    from: body.from,
    to: body.to,
    insert: lead + endWith(text, body.to, lines, style.eol, block),
  });
  return edits;
}

/** A one-line token turned into a block scalar: its header where the token was, its lines after the token's line. */
function newBlock(site: ScalarSite, block: Block): TextEdit[] | undefined {
  const { node, lines, style } = site;
  const [start, end] = node.range;
  const at = lines.end(lines.lineAt(Math.max(end - 1, start)));
  if (site.bodyColumn <= (lines.commentAfter(at) ?? -1)) return undefined;
  const text = indentLines(block.lines, site.bodyColumn).join(style.eol);
  const lead = at === lines.text.length && !lines.text.endsWith('\n') ? style.eol : '';
  return [
    { from: start, to: end, insert: block.header },
    { from: at, to: at, insert: lead + endWith(text, at, lines, style.eol, block) },
  ];
}

/**
 * A block body's text ends with a line break unless it ends the file and the file has none, which only a body that
 * strips its trailing breaks may do (a kept or clipped one would lose its last break).
 */
function endWith(text: string, at: number, lines: Lines, eol: Eol, block: Block): string {
  const atEnd = at === lines.text.length && !lines.text.endsWith('\n');
  return atEnd && block.header.endsWith('-') ? text : text + eol;
}

/** Where a block scalar's header ends (`|-`, `>2`), before its comment; a node that is no block scalar's start. */
export function headerEnd(node: ParsedNode): number {
  const header = node.srcToken?.type === 'block-scalar' ? headerToken(node.srcToken) : undefined;
  return header ? header.offset + header.source.length : node.range[0];
}

function headerToken(token: CST.BlockScalar): CST.SourceToken | undefined {
  return token.props.find((t): t is CST.SourceToken => t.type === 'block-scalar-header');
}

/**
 * A block scalar's body: from the line after its header to the end of its range. At the end of a file with no final
 * line break the header's own break goes with it (`lead`), so a replacement starts with a line break.
 */
export function bodyRange(lines: Lines, node: ParsedNode): { from: number; to: number; lead: boolean } {
  const [start, end] = node.range;
  const header = lines.lineAt(start);
  const atEnd = end === lines.text.length && !lines.text.endsWith('\n');
  if (atEnd && lines.end(header) < end) return { from: lines.breakAt(header), to: end, lead: true };
  // An empty body on the file's last line, with no break after the header: the body starts with one.
  if (atEnd) return { from: end, to: end, lead: true };
  return { from: Math.min(lines.end(header), end), to: end, lead: false };
}

/** The column of a block body's first line that is not empty. */
function bodyIndent(lines: Lines, body: { from: number; to: number; lead: boolean }): number | undefined {
  // With `lead` the body starts at the header's own line break: its lines are the ones after.
  const first = lines.lineAt(body.from) + (body.lead ? 1 : 0);
  for (let line = first; line < lines.count && lines.start(line) < body.to; line++) {
    const text = lines.textOf(line);
    if (text.trim() !== '') return /^ */.exec(text)![0].length;
  }
  return undefined;
}
