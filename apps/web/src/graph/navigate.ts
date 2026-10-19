import type { NodeId } from '@simulci/engine';
import type { GraphLayout, GraphModel } from './types';

/**
 * The canvas keys (synthesis § 11), pure: ↓/↑ the next or previous sibling in layout order, →/← along a `needs` edge
 * (Alt cycles), Enter descends, Esc ascends then leaves, Space opens a job's step list, `.` centres, `f` fits, `0`
 * shows 100 %. React Flow's own arrow keys stay inert: nothing on the canvas is draggable.
 */

export type NavAction =
  | { select: NodeId | undefined }
  | { toggle: NodeId }
  | { fit: true }
  | { centre: NodeId }
  | { actualSize: true }
  | { leave: true };

export interface NavKey {
  key: string;
  altKey: boolean;
}

export function navigate(
  _key: NavKey,
  _at: NodeId | undefined,
  _model: GraphModel,
  _layout: GraphLayout,
): NavAction | undefined {
  return undefined;
}
