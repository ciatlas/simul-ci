/**
 * Marks on the browser's performance timeline along an edit's way to the screen, for the latency gate
 * (`e2e/edit-latency.spec.ts`, synthesis § 9.5): `edit:tx` when a key reaches the store, `edit:loaded` when its texts
 * are loaded, `edit:plan` when their plan is in the store, `edit:painted` once the canvas has drawn it. Each names the
 * files version it is for. Only the newest mark of each name is kept, so a long session gathers none.
 */
export type EditMark = 'edit:tx' | 'edit:loaded' | 'edit:plan' | 'edit:painted';

export function markEdit(name: EditMark, files: number): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  try {
    performance.clearMarks(name);
    performance.mark(name, { detail: { files } });
  } catch {
    // A timeline that refuses marks costs nothing but the gate's figures.
  }
}
