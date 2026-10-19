import type { NodeId } from '@simulci/engine';

/**
 * The canvas's viewport, as commands the shortcuts and the panels can give without holding the React Flow
 * instance: the mounted canvas registers them, and they do nothing while no canvas is mounted.
 */
export interface ViewportCommands {
  fit(): void;
  /** Brings a node into view, moving only when it is outside. */
  centre(node: NodeId): void;
  actualSize(): void;
}

let current: ViewportCommands | undefined;

export const viewport = {
  /** The canvas registers its commands on mount; the returned function unregisters them. */
  register(commands: ViewportCommands): () => void {
    current = commands;
    return () => {
      if (current === commands) current = undefined;
    };
  },
  fit: (): void => current?.fit(),
  centre: (node: NodeId): void => current?.centre(node),
  actualSize: (): void => current?.actualSize(),
};
