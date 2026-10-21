import type { NodeId } from '@simulci/engine';
import type { SessionStore } from '../state/store';

/**
 * The page's side of the structural gestures (synthesis § 4.2, § 4.5): the canvas, the page keys and the outline tree
 * ask, and the edit runtime answers while edit mode shows (`edit/canvas/EditHost.tsx` registers itself). A key
 * pressed while its chunk is still coming waits for it (`ask`); a handle connects nothing until then. Types only
 * cross: the page holds none of the document model. Kept per store, as the canvas keeps its viewport.
 */
export interface Gestures {
  /** Opens Add job, after a job of the focused workflow or for the workflow itself. */
  addJob(after?: string): boolean;
  /** Opens What it needs under the selected job. */
  needs(): boolean;
  /**
   * Opens the palette: a step after the selected step, else the selected job's last; or at a place in a job; or, with
   * `change`, another action for the step at that index.
   */
  palette(at?: { job: string; index: number; change?: boolean }): boolean;
  /** Removes the selected job or step, asking first when the removal warns or takes needs with it. */
  remove(): boolean;
  /** Moves the selected step up or down within its job. */
  move(by: -1 | 1): boolean;
  /** Renames the selected job, or the selected step's id, with every reference to it (F2, a card title's double-click). */
  rename(): boolean;
  /** Whether a drag from one job's handle may end on another's: the second would then need the first. */
  canConnect(source: NodeId, target: NodeId): boolean;
  /** The second job needs the first; a refused drag says why. */
  connect(source: NodeId, target: NodeId): void;
  /** The need an edge draws goes. */
  disconnect(source: NodeId, target: NodeId): void;
  /** The actions of an outline row, in a menu at the row. */
  menu(node: NodeId, at: HTMLElement): boolean;
}

/** A `needs` edge the canvas draws dashed until a picture of the files version it was written in is on screen. */
export interface PendingEdge {
  source: NodeId;
  target: NodeId;
  files: number;
}

const registered = new WeakMap<SessionStore, Gestures>();
const waiting = new WeakMap<SessionStore, (g: Gestures) => boolean>();
const watchers = new WeakMap<SessionStore, Set<() => void>>();

const told = (store: SessionStore): void => {
  for (const watcher of watchers.get(store) ?? []) watcher();
};
const pending = new WeakMap<SessionStore, readonly PendingEdge[]>();
const listeners = new WeakMap<SessionStore, Set<() => void>>();

export const gestures = {
  /** The edit runtime registers its gestures while edit mode shows; the returned function takes them back. */
  register(store: SessionStore, impl: Gestures): () => void {
    registered.set(store, impl);
    told(store);
    const asked = waiting.get(store);
    waiting.delete(store);
    asked?.(impl);
    return () => {
      if (registered.get(store) !== impl) return;
      registered.delete(store);
      told(store);
    };
  },
  /** Calls `watcher` when the gestures come or go: the canvas offers its handles, ✕ and + only while they answer. */
  watch(store: SessionStore, watcher: () => void): () => void {
    const own = watchers.get(store) ?? new Set();
    watchers.set(store, own);
    own.add(watcher);
    return () => own.delete(watcher);
  },
  of: (store: SessionStore): Gestures | undefined => registered.get(store),
  /**
   * A key's gesture: run now when the runtime is in, else kept (the last one asked) until it registers, so a key
   * pressed just after entering edit mode is not lost. True when it ran and took the key, or waits.
   */
  ask(store: SessionStore, run: (g: Gestures) => boolean): boolean {
    const impl = registered.get(store);
    if (impl) return run(impl);
    waiting.set(store, run);
    return true;
  },
};

const NONE: readonly PendingEdge[] = [];

/** The edges written and not drawn yet: a list the canvas subscribes to, kept per store. */
export const pendingEdges = {
  of: (store: SessionStore): readonly PendingEdge[] => pending.get(store) ?? NONE,
  add(store: SessionStore, edge: PendingEdge): void {
    publish(store, [...pendingEdges.of(store), edge]);
  },
  /** Drops the edges a picture of these files or newer ones draws, or no longer can. */
  settle(store: SessionStore, files: number): void {
    const left = pendingEdges.of(store).filter((e) => e.files > files);
    if (left.length !== pendingEdges.of(store).length) publish(store, left.length > 0 ? left : NONE);
  },
  subscribe(store: SessionStore, listener: () => void): () => void {
    const own = listeners.get(store) ?? new Set();
    listeners.set(store, own);
    own.add(listener);
    return () => own.delete(listener);
  },
};

function publish(store: SessionStore, list: readonly PendingEdge[]): void {
  pending.set(store, list);
  for (const listener of listeners.get(store) ?? []) listener();
}
