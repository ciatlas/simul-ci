import { type BehindOptions, behind } from './behind';
import {
  belongs,
  clockOf,
  type EditsSnapshot,
  restorePlan,
  type SnapshotStore,
  snapshotOf,
} from './snapshot';
import { dirtyPaths, type SessionState, type SessionStore } from './store';

/**
 * Keeps the crash snapshot of a folder's edits (`state/snapshot.ts`): written behind the edits (`state/behind.ts`),
 * and cleared once nothing is unsaved, or once the author lets the edits go by replacing the folder (the replace
 * prompt asked first) or forgetting it. When a folder's files come in, the snapshot that belongs to them comes back
 * first, and the writer waits until it has: for the restore to load, and for every conflict it raised to be settled.
 */
export interface SnapshotKeeper {
  /** A write waits or runs: leaving the page now could lose the last edits. */
  pending(): boolean;
  flush(): Promise<void>;
  dispose(): void;
}

export interface SnapshotKeeperOptions extends BehindOptions {
  store: SessionStore;
  snapshots: SnapshotStore;
  now?: () => number;
}

export function createSnapshotKeeper({
  store,
  snapshots,
  now = Date.now,
  ...options
}: SnapshotKeeperOptions): SnapshotKeeper {
  /** The restore under way, by the epoch it is for; a newer one makes an older one moot. */
  let restoring: number | undefined;

  const paused = (): boolean => restoring !== undefined || store.getState().edit.restore !== undefined;

  const writer = behind(() => {
    const s = store.getState();
    if (s.source.kind !== 'folder' || paused()) return undefined;
    const snapshot = snapshotOf(s, now());
    return snapshot ? snapshots.save(snapshot) : snapshots.clear();
  }, options);

  /** The snapshot's files that come back by themselves as one entry, the others for the author to settle. */
  const apply = (snapshot: EditsSnapshot): void => {
    const a = store.getState();
    const plan = restorePlan(snapshot, a.files);
    const n = plan.files.length;
    if (n > 0 && a.transact({ label: 'Restored unsaved edits', origin: 'restore', files: plan.files }).ok)
      a.notify(
        `Restored unsaved edits to ${n} ${n === 1 ? 'file' : 'files'} from ${clockOf(snapshot.at)} · undo starts here`,
      );
    if (plan.conflicts.length > 0) a.offerRestore({ at: snapshot.at, conflicts: plan.conflicts });
  };

  const restore = async (epoch: number, after: Promise<void>): Promise<void> => {
    restoring = epoch;
    try {
      await after;
      const snapshot = await snapshots.load();
      if (!snapshot || store.getState().files.epoch !== epoch) return;
      if (!(await belongs(snapshot, store.getState().source)) || store.getState().files.epoch !== epoch)
        return;
      apply(snapshot);
    } finally {
      if (restoring === epoch) {
        restoring = undefined;
        // Edits made while the restore loaded were not written: write them now. With none, nothing is written, so
        // the snapshot of another folder stays until this one is edited.
        if (dirtyPaths(store.getState().files).length > 0) writer.call();
      }
    }
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.files.epoch !== prev.files.epoch) {
      writer.cancel();
      restoring = undefined;
      const gone = letGo(prev) ? writer.run(() => snapshots.clear()) : Promise.resolve();
      if (s.source.kind === 'folder' && Object.keys(s.files.byPath).length > 0)
        void restore(s.files.epoch, gone);
      return;
    }
    const settled = prev.edit.restore !== undefined && s.edit.restore === undefined;
    if (s.files.version !== prev.files.version || settled) writer.call();
  });

  return {
    pending: () => writer.pending(),
    flush: () => writer.flush(),
    dispose: () => {
      unsubscribe();
      writer.dispose();
    },
  };
}

/** Whether a new epoch let a folder's unsaved edits go: the prompt asked first, and the author chose to. */
const letGo = (prev: SessionState): boolean =>
  prev.source.kind === 'folder' && dirtyPaths(prev.files).length > 0;
