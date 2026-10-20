import type { CST } from 'yaml';

/**
 * Every token of yaml's concrete syntax tree in text order, containers before what they hold. The CST keeps every
 * byte of the text (`CST.stringify` of the tokens gives it back), so style is read here rather than from the AST.
 */
export function walkTokens(tokens: readonly CST.Token[], visit: (token: CST.Token) => void): void {
  walk(tokens, visit);
}

/** Where a token keeps what it holds, in text order for every kind of token. */
const CHILDREN = ['start', 'props', 'key', 'sep', 'value', 'items', 'end'] as const;

function walk(value: unknown, visit: (token: CST.Token) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  // Collection items have no type: only what they hold is visited.
  if ('type' in value) visit(value as CST.Token);
  for (const key of CHILDREN) if (key in value) walk((value as Record<string, unknown>)[key], visit);
}

/** The items of a block sequence that are items: each holds a `-`. The others carry only comments. */
export function seqIndicators(token: CST.Token | undefined): number[] {
  if (token?.type !== 'block-seq') return [];
  return token.items.flatMap(({ start }) => {
    const dash = start.find((t) => t.type === 'seq-item-ind');
    return dash ? [dash.offset] : [];
  });
}

/** A block scalar's header (`|`, `>-`, `|+2`), or '' for any other node. */
export function blockHeader(token: CST.Token | undefined): string {
  if (token?.type !== 'block-scalar') return '';
  const header = token.props.find((t) => t.type === 'block-scalar-header');
  return header && 'source' in header ? header.source : '';
}
