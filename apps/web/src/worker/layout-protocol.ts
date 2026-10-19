import type { NodeId } from '@simulci/engine';
import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import { CARD, type Point, type ScopeLayout, type Size } from '../graph/types';

/**
 * What the page and the layout worker say to each other, and how the worker answers. The page sends the scopes whose
 * shape it has no positions for, callees before the scopes that call them, each card sized but those that hold an
 * open callee: those are sized here around the callee's laid-out size, from earlier in the same request or from
 * `known`, so one request places a whole nesting. Each scope is one ELK `layered` run; ELK is handed in, so a Node
 * test drives the same code the worker runs, and this module never loads elkjs into the page (it imports ELK's types
 * only).
 */

/** A job card: sized, or sized around its callee as `size.ts`' `callFrame` says (at least `min`, callee + `extra`). */
export type LayoutNode = ({ id: NodeId } & Size) | { id: NodeId; callee: NodeId; extra: Size; min: Size };

export interface LayoutEdge {
  id: string;
  source: NodeId;
  target: NodeId;
}

export interface LayoutScope {
  id: NodeId;
  /** In declaration order. */
  nodes: LayoutNode[];
  /** In `needs` order. */
  edges: LayoutEdge[];
}

export interface LayoutRequest {
  id: number;
  type: 'layout';
  /** Callees first. */
  scopes: LayoutScope[];
  /** The sizes of callees the page already has positions for. */
  known: Record<NodeId, Size>;
}

export type LayoutResponse =
  | { id: number; type: 'layout'; scopes: Record<NodeId, ScopeLayout>; ms: number }
  | { id: number; type: 'error'; message: string };

const { top, left, bottom, right } = CARD.scopePadding;

/**
 * Left to right along `needs`; children and edges kept in the order given, so the result is a function of the file,
 * not of what was laid out before.
 */
export const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.padding': `[top=${top},left=${left},bottom=${bottom},right=${right}]`,
  'elk.spacing.nodeNode': '16',
  'elk.layered.spacing.nodeNodeBetweenLayers': '48',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
};

/** Lays each scope out in order; any failure answers the whole request with an error, so no partial picture lands. */
export async function answerLayout(
  elk: Pick<ELK, 'layout'>,
  request: LayoutRequest,
): Promise<LayoutResponse> {
  const start = performance.now();
  const sizes = new Map(Object.entries(request.known));
  const scopes: Record<NodeId, ScopeLayout> = {};
  try {
    for (const scope of request.scopes) {
      const laid = await layOutScope(elk, scope, sizes);
      scopes[scope.id] = laid;
      sizes.set(scope.id, { width: laid.width, height: laid.height });
    }
  } catch (e) {
    return { id: request.id, type: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  return { id: request.id, type: 'layout', scopes, ms: performance.now() - start };
}

async function layOutScope(
  elk: Pick<ELK, 'layout'>,
  scope: LayoutScope,
  sizes: ReadonlyMap<NodeId, Size>,
): Promise<ScopeLayout> {
  const input: ElkNode = {
    id: scope.id,
    layoutOptions: ELK_OPTIONS,
    children: scope.nodes.map((node) => ({ id: node.id, ...nodeSize(node, sizes) })),
    edges: scope.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const graph = await elk.layout(input);
  const positions: Record<NodeId, Point> = {};
  // Whole pixels keep one-pixel borders crisp; ELK's balanced placement can land on halves.
  for (const child of graph.children ?? [])
    positions[child.id] = { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) };
  return { width: Math.ceil(graph.width ?? 0), height: Math.ceil(graph.height ?? 0), positions };
}

function nodeSize(node: LayoutNode, sizes: ReadonlyMap<NodeId, Size>): Size {
  if (!('callee' in node)) return { width: node.width, height: node.height };
  const callee = sizes.get(node.callee);
  if (!callee) throw new Error(`${node.id} calls ${node.callee}, which is neither laid out nor known`);
  return {
    width: Math.max(node.min.width, callee.width + node.extra.width),
    height: Math.max(node.min.height, callee.height + node.extra.height),
  };
}

/** Whether a message is a layout request: the shape is checked, not trusted. */
export function isLayoutRequest(data: unknown): data is LayoutRequest {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === 'number' &&
    d.type === 'layout' &&
    Array.isArray(d.scopes) &&
    typeof d.known === 'object' &&
    d.known !== null
  );
}
