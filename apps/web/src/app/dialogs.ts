/**
 * The dialogs chunk: the Changes dialog, the save's conflicts and report dialogs, the test case dialog, the restore
 * conflicts' rows, the line diff they draw, the patch, and what Save and Reload run against the folder (synthesis
 * § 8.5, once the page passed 240 kB). The page reaches it through this module alone, by `import()`
 * (`app/dialogs-load.ts`: the prefetch, Save, Reload, the replace prompt's patch) and by `React.lazy` (the dialogs, the
 * rows), so the build names its chunk `dialogs-*` after it and the page keeps none of it.
 */
export { ChangesDialog } from './ChangesDialog';
export { RestoreConflicts } from './RestoreConflicts';
export { SaveDialogs } from './SaveDialog';
export { runSave } from './save-run';
export { CaseDialog } from '../testcase/CaseDialog';
export { downloadPatch } from '../state/changes';
export { reloadPlan, settledReload } from '../state/reload';
