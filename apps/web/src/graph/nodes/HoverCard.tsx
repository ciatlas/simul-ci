import type { Tri } from '@simulci/engine';
import { NodeToolbar, Position } from '@xyflow/react';
import { MARK_LABEL } from '../../lib/words';
import { Mark } from '../Mark';

export interface HoverFacts {
  verdict: Tri;
  label: string;
  clause?: string;
  check?: string;
  result?: string;
  needs?: readonly string[];
}

/**
 * The card above a hovered node: the mark, the label and the verdict word, the deciding clause, the check, the
 * result and what it needs, as the Reasons header words them. The canvas shows it after 300 ms of hovering; every
 * fact on it is also in the node's accessible name (card.ts `jobLabel`, `scopeLabel`) or the card's own text (the
 * check on the subline), so it never holds the only copy and stays hidden from a screen reader.
 */
export function HoverCard({ visible, facts }: { visible: boolean; facts: HoverFacts }) {
  return (
    <NodeToolbar
      isVisible={visible}
      position={Position.Top}
      offset={8}
      className="sc-hover"
      style={ABOVE}
      aria-hidden="true"
    >
      <p className="sc-hover-title">
        <Mark verdict={facts.verdict} />
        <strong>{facts.label}</strong>
        <span className="text-muted">· {MARK_LABEL[facts.verdict]}</span>
      </p>
      {facts.clause && <p className="font-mono">{facts.clause}</p>}
      {facts.check && <p>check: {facts.check}</p>}
      {facts.result && <p>result: {facts.result}</p>}
      {facts.needs && facts.needs.length > 0 && <p>needs: {facts.needs.join(', ')}</p>}
    </NodeToolbar>
  );
}

/** Above the edge labels (500) and every card, selected ones (1000 and up) included. */
const ABOVE = { zIndex: 2000 };
