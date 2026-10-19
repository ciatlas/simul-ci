import type { Viewport } from '@xyflow/react';
import type { Point } from './types';

/**
 * The viewport's own rules, pure: where it starts when the canvas mounts, and where a double-click takes it. The
 * first picture of a project is fitted once; after that the canvas opens where the author left it, whether the text
 * view, a narrow window or StrictMode's second mount took it away, and a newly loaded project is fitted again. A
 * double-click zooms in twice as far (out with Shift) about the pointer, as d3-zoom's own does, but in the canvas's
 * time, so it moves at once for an author who asked for less motion.
 */

/** The last viewport of a project's picture, kept while the canvas is unmounted. */
export interface ViewMemory {
  project: number;
  viewport: Viewport;
}

/** How a mounted picture starts. */
export interface MountView {
  /** Fit the picture once its nodes are in. */
  fit: boolean;
  /** Where the viewport starts; absent, React Flow's own origin at 100 %. */
  viewport?: Viewport;
}

export function mountView(memory: ViewMemory | undefined, project: number): MountView {
  return memory?.project === project ? { fit: false, viewport: memory.viewport } : { fit: true };
}

/** The viewport a double-click at `pointer` (relative to the pane) asks for: the flow point under it stays there. */
export function doubleClickZoom(
  at: Viewport,
  pointer: Point,
  out: boolean,
  limits: { min: number; max: number },
): Viewport {
  const zoom = Math.min(limits.max, Math.max(limits.min, at.zoom * (out ? 0.5 : 2)));
  const x = (pointer.x - at.x) / at.zoom;
  const y = (pointer.y - at.y) / at.zoom;
  return { x: pointer.x - x * zoom, y: pointer.y - y * zoom, zoom };
}
