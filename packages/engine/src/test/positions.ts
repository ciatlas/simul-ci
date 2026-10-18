import { type Document, isMap, isScalar, LineCounter, type Node, parseDocument } from 'yaml';

/** Where a key or value sits in a YAML text, 1-based, for annotations on the test file's own tokens. */

export interface TextPos {
  line: number;
  col: number;
}

export interface ParsedYaml {
  doc: Document;
  errors: { message: string; pos: TextPos }[];
  posOf: (path: readonly (string | number)[], which?: 'key' | 'value') => TextPos;
}

export function parseYaml(text: string): ParsedYaml {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: true });
  const at = (offset: number | undefined): TextPos => {
    if (offset === undefined) return { line: 1, col: 1 };
    const p = counter.linePos(offset);
    return { line: p.line, col: p.col };
  };
  return {
    doc,
    errors: doc.errors.map((e) => ({ message: e.message.split('\n')[0] ?? e.message, pos: at(e.pos[0]) })),
    posOf: (path, which = 'value') => at(offsetOf(doc, path, which)),
  };
}

/** The offset of the node at `path` (its key when asked), else of the nearest ancestor that exists. */
function offsetOf(
  doc: Document,
  path: readonly (string | number)[],
  which: 'key' | 'value',
): number | undefined {
  for (let depth = path.length; depth > 0; depth--) {
    const prefix = path.slice(0, depth);
    const node = doc.getIn(prefix, true) as Node | undefined;
    if (!node) continue;
    const key = which === 'key' && depth === path.length ? keyOffset(doc, prefix) : undefined;
    if (key !== undefined) return key;
    if (node.range) return node.range[0];
  }
  return doc.contents?.range?.[0];
}

/** The offset of the key token of a map entry. */
function keyOffset(doc: Document, path: readonly (string | number)[]): number | undefined {
  const parent = doc.getIn(path.slice(0, -1), true);
  const key = String(path.at(-1));
  if (!isMap(parent)) return undefined;
  const pair = parent.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
  return isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
}
