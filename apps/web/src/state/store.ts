import type { AssumeEntry, RunPlan, ScenarioInput, UnknownId } from '@simulci/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { regionEdit, type TextEdit, touched } from '@simulci/document/edits';
import type { GraphState, GraphUi } from '../graph/types';
import { isProjectFile } from '../input/filter';
import { fileLabel } from '../lib/file-label';
import { classifyEol, type FileMeta, textMeta } from '../input/read';
import { pinSentence, type VerdictChange, verdictChanges } from '../plan/changes';
import type { Derived, ModelInfo, Outline } from '../worker/protocol';
import * as history from './history';
import { DEFAULT_PREFS, type PanelTab, type Prefs } from './prefs';

/**
 * The one store of the page: plain data, nothing derived, nothing the engine owns. Panels read it through selectors;
 * only the session talks to the worker, only the router sync writes the URL, only persist.ts and prefs.ts touch
 * storage.
 */

export type Source =
  | { kind: 'none' }
  | { kind: 'sample'; name: string }
  /** Pasted files, or a sample once edited: its buffers follow every edit (`writtenThrough`); `name` says which sample. */
  | { kind: 'paste'; buffers: { path: string; text: string }[]; name?: string }
  | { kind: 'folder'; name: string; handle?: FileSystemDirectoryHandle; readAt: number };

export interface Issue {
  path: (string | number)[];
  message: string;
}

export interface SessionError {
  /**
   * `boot`: the engine never started; `stopped`: it stopped and could not be restarted; `engine`: it threw;
   * `source`: files could not be read; the rest are the author's.
   */
  kind: 'boot' | 'stopped' | 'engine' | 'source' | 'scenario' | 'assume' | 'workflow';
  message: string;
  stack?: string;
  issues?: Issue[];
}

export interface PlanState {
  plan: RunPlan;
  derived: Derived;
  text: string;
  ms: { simulate: number; derive: number };
  /**
   * The files version the plan was simulated from, which may be older than the store's while an edit is answered,
   * the epoch of those files, the project version it answers, and the case layer it was simulated with: the plan
   * names the assume entries by position, so it speaks of the list it was given and of no other. The scenario is the
   * store's object it was simulated from, so a pin can tell the plan that answers it. `untriggered` is the
   * `planUntriggered` it was simulated with (edit mode's focus): two plans compare job by job only when it is the same.
   */
  for: {
    files: number;
    epoch: number;
    project: number;
    assume?: AssumeEntry[];
    scenario?: ScenarioInput;
    untriggered?: string[];
  };
}

/**
 * The last pin (a scenario field or an assume entry written from the Unknowns tab) and, once the plan that answers
 * it came, what it changed: the status line says it ("pinned; deploy now runs") and the cards it changed flash. A pin
 * belongs to the files it was made over: new files, or none, drop it.
 */
export interface Pin {
  seq: number;
  /** The plan the pin was made over, until the answering plan settled it: then only what it changed is kept. */
  before?: Pick<PlanState, 'plan' | 'derived'>;
  /** The inputs the pin left in the store: the plan simulated from exactly these objects answers it. */
  scenario: ScenarioInput;
  assume: AssumeEntry[];
  /** What the answering plan changed; absent until it comes. */
  after?: { plan: RunPlan; changes: VerdictChange[]; sentence: string };
}

/** A request to put the focus on an unknown's row in the Unknowns tab: "Show X in Unknowns" in a reason. */
export interface UnknownFocus {
  id: UnknownId;
  seq: number;
}

export interface Notice {
  id: number;
  text: string;
}

/**
 * A request to put the focus in a scenario field: a pin wrote the field, or a reason's Set … button asked for it.
 * The form resolves `path` the way it routes the worker's issues (`deriveForm`'s `fields`: `vars`, `changed`,
 * `action`, `tag`, `workflow_run.branch`, `inputs.deploy`, `actor.login`; a `key.sub` it has no field for falls back
 * to `key`), focuses the control and selects the example so the author types over it. `seq` tells one request from
 * the next; the form acknowledges it with `fieldFocused(seq)`.
 */
export interface FieldFocus {
  path: string;
  /** The entry of a field written one entry per line whose value is selected: the variable's name for `vars`. */
  entry?: string;
  seq: number;
}

/** A request to show a line in the YAML pane: it opens the pane on the file's tab and scrolls the line into view. */
export interface Reveal {
  file: string;
  line: number;
  seq: number;
}

export interface SessionState {
  source: Source;
  files: {
    /** Moves with every change of the texts: a new source, or an edit within the epoch (`withTexts`). */
    version: number;
    /**
     * Moves with a new source only (`setFiles`, `forgetSource`, `awaitReopen`): the picture, the viewport, the
     * pane's states and the scenario's defaults belong to an epoch, so an edit keeps them.
     */
    epoch: number;
    /** The project files' texts, a BOM stripped. */
    byPath: Record<string, string>;
    /**
     * What reading each file in `byPath` found: its BOM, its line endings, whether it is valid UTF-8. A file an edit
     * removed keeps its entry, so undoing the removal brings back what reading found.
     */
    meta: Record<string, FileMeta>;
    /**
     * Per file, the files version that last changed its text. The version only grows, so a path and its rev name one
     * text for the page's life, across epochs too: what the pane keeps a file's state by.
     */
    revs: Record<string, number>;
    /** Per file, its text as read (a save will move it); a file created since has none. */
    base: Record<string, string>;
    /** Per file, its text when the epoch began. */
    opened: Record<string, string>;
    /**
     * The edits of the last commit of the history, per file, with each file's rev before it: a view that shows the
     * text of that rev maps the edits instead of comparing texts (`yaml/bridge.ts`).
     */
    edited?: {
      version: number;
      revs: Record<string, number>;
      edits: Record<string, readonly TextEdit[]>;
      /** Each file's line endings before the commit: the text the edits' offsets are in. */
      eols: Record<string, FileMeta['eol']>;
    };
  };
  project: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    version?: number;
    outline?: Outline;
    files?: number;
    /**
     * An edit broke the YAML of a file that parsed on the plan shown (synthesis § 7.2): the newest texts' Outline,
     * for the pane's problems and the status line, while the project, the plan and the picture stay those shown and
     * nothing is simulated until a load without new YAML errors commits.
     */
    held?: Held;
  };
  scenario: ScenarioInput;
  /** Who set the scenario: the page's defaults (replaced on the next load), the URL, or the author. */
  scenarioFrom: 'default' | 'url' | 'author';
  /** Scenario fields the page chose for the author; an edit clears its mark. */
  assumed: string[];
  assume: AssumeEntry[];
  detail: 'legs' | 'steps';
  engine: {
    status: 'booting' | 'ready' | 'failed';
    version?: string;
    models: ModelInfo[];
    restarts: number;
    busy: boolean;
  };
  plan?: PlanState;
  /**
   * What changed since `plan` was computed, if anything: the inputs (the scenario, the assume entries, the detail),
   * or the texts (`withTexts`). The later change names the cause.
   */
  stale: false | 'inputs' | 'edit';
  /**
   * What the screen says of a stale plan (`app/stale.ts`): `inputs`, the last good plan; `edit`, the plan of the newest
   * texts on its way. An edit says so only once its plan has been slow to come, so typing never flickers.
   */
  staleShown: false | 'inputs' | 'edit';
  error?: SessionError;
  /** The depth-0 workflow the defaults, the copy and the fit are about. */
  focus?: string;
  /**
   * The selection, as the URL's `sel` spells it: a unit path within `focus`. Absent, the focused workflow itself is
   * what the panels are about. A unit path survives a new plan; `plan/index.ts` resolves it to a node.
   */
  sel?: string;
  /** What the canvas shows: committed with its positions, so the previous picture stays until they exist. */
  graph?: GraphState;
  /** The field a pin or a reason asked the form to focus, until the form takes it. */
  fieldFocus?: FieldFocus;
  /** The line the YAML pane was last asked to show. */
  reveal?: Reveal;
  /** Whether the Copy as test case dialog is open: the top bar's button and the `c` key open it. */
  caseOpen: boolean;
  /** The unknown whose "affects n" the pointer or the focus is on: the canvas dims every card it does not affect. */
  hoveredUnknown?: UnknownId;
  /** The unknown whose row the Unknowns tab was asked to focus, until the tab takes it. */
  unknownFocus?: UnknownFocus;
  pin?: Pin;
  ui: Omit<GraphUi, 'hideUntriggered' | 'only'> & {
    view: 'graph' | 'text';
    hideUntriggered: boolean;
    prefs: Prefs;
    /** The YAML pane's tab the author picked; absent, the pane follows the selection's file. */
    yamlFile?: string;
  };
  notices: Notice[];
  /** The edit history (`state/history.ts`), cleared by a new epoch only, and the restore waiting to be settled. */
  edit: EditState;
  /** A new source asked to replace files with unsaved edits; the replace prompt answers it (`app/replace.ts`). */
  replacing?: Replacing;
  /**
   * Core's generated marker of each file that has one, from the last Outline committed or held, kept through a load
   * that failed; absent until the epoch's first Outline, when no file is known not to be generated.
   */
  generated?: Record<string, string>;
}

/** A file of the crash snapshot that did not come back by itself (synthesis § 5.6): the author settles it. */
export interface RestoreConflict {
  path: string;
  /** The text the snapshot kept. */
  text: string;
  /** `changed`: the file's text is no longer the one the edits were made to; `gone`: it is not there; `exists`: a file the edits created is there now. */
  reason: 'changed' | 'gone' | 'exists';
}

export interface RestoreOffer {
  /** When the snapshot was taken. */
  at: number;
  conflicts: RestoreConflict[];
}

export interface EditState extends history.History {
  restore?: RestoreOffer;
  /** Edit mode (`e`, the top bar's Edit switch, `edit=1`): the pane edits the files it may (`writable`). */
  on: boolean;
  /** Generated files the author chose to edit this session. */
  unlocked: string[];
}

export interface Replacing {
  seq: number;
  /** What would replace the files, as the prompt names it: "the sample starter", "the folder repo". */
  what: string;
  /** The edited files it would drop; edited buffers a paste leaves standing are not among them. */
  paths: readonly string[];
}

/** What an edit asked of the store came to: applied, or nothing changed (a refusal says why, if there was one). */
export type EditOutcome = { ok: true } | { ok: false; refusal?: history.Refusal };

/** A load the hold kept off the screen (§ 7.2): its files version, its Outline, and the lines that broke. */
export interface Held {
  files: number;
  outline: Outline;
  /** Per file that parsed on the plan shown and does not now, its first YAML error's line. */
  broken: { path: string; line: number }[];
}

export interface SessionActions {
  /** New files from a source; a file `meta` does not cover is a string no file was read for (a paste, a sample). */
  /** `base` gives the texts some files' edits were made to (`null`: created since), as stored buffers keep them. */
  setFiles: (
    byPath: Record<string, string>,
    source: Source,
    meta?: Record<string, FileMeta>,
    base?: BaseDiff,
  ) => void;
  forgetSource: () => void;
  /** A source that has no files until the author acts: a stored folder waiting for Reopen. */
  awaitReopen: (source: Source) => void;
  setScenario: (
    scenario: ScenarioInput,
    options?: { assumed?: string[]; from?: SessionState['scenarioFrom'] },
  ) => void;
  patchScenario: (patch: Partial<ScenarioInput>) => void;
  /**
   * Writes the scenario a pin built (`scenario/apply-pin.ts`): the keys it wrote join the assumed marks until the
   * author edits them, and the field that shows the pin asks for the focus.
   */
  pinScenario: (scenario: ScenarioInput, keys: string[], focus: Omit<FieldFocus, 'seq'>) => void;
  /** Asks the form to focus a field. */
  focusField: (focus: Omit<FieldFocus, 'seq'>) => void;
  /** The form took the request `seq`. */
  fieldFocused: (seq: number) => void;
  setAssume: (assume: AssumeEntry[]) => void;
  /** Writes the assume list a pin built (the Unknowns tab's Assume and Pin… controls), as a pin. */
  pinAssume: (assume: AssumeEntry[]) => void;
  setDetail: (detail: 'legs' | 'steps') => void;
  setFocus: (focus: string | undefined) => void;
  /**
   * Selects a node by its depth-0 workflow and its unit path; no unit path selects the workflow itself. A new
   * selection takes the YAML pane back to its file; the selection already held changes nothing.
   */
  select: (focus: string | undefined, sel: string | undefined) => void;
  toggleExpanded: (job: string) => void;
  setRepresentative: (job: string, leg: string) => void;
  toggleOpened: (scope: string) => void;
  graphReady: (graph: GraphState) => void;
  setView: (view: 'graph' | 'text') => void;
  setHideUntriggered: (hide: boolean) => void;
  setPrefs: (patch: Partial<Prefs>) => void;
  setPanel: (panel: PanelTab) => void;
  /** Opens or closes a pane; the choice is a preference. */
  togglePane: (pane: keyof Prefs['collapsed']) => void;
  /** Opens the YAML pane on a file's tab and shows the line. */
  revealLine: (loc: { file: string; line: number }) => void;
  setYamlFile: (file: string | undefined) => void;
  openCase: () => void;
  closeCase: () => void;
  /** The pointer or the focus is on an unknown's "affects n", or left it (`undefined`). */
  hoverUnknown: (id: UnknownId | undefined) => void;
  /** Opens the right panel on the Unknowns tab and asks it to focus the unknown's row. */
  showUnknown: (id: UnknownId) => void;
  /** The Unknowns tab took the request `seq`. */
  unknownFocused: (seq: number) => void;
  /**
   * A transaction over one or more files: all or none, one undo entry. It keeps the plan, the picture, the selection
   * and the scenario: the plan is stale for the edit until the session brings the one of the new texts.
   */
  transact: (input: history.TxInput) => EditOutcome;
  /** Text typed in the YAML pane, in the offsets of the file's text now; grouped into undo entries (§ 6). */
  typed: (path: string, edits: readonly TextEdit[], alone?: history.Alone) => EditOutcome;
  /** Closes the open typing group: the pane lost the focus or showed another file. */
  closeGroup: () => void;
  /** Undoes the last entry; false when there is none or the hash guard stopped it. */
  undo: () => boolean;
  redo: () => boolean;
  /** Restore conflicts for the author to settle; the snapshot writer waits until none is left. */
  offerRestore: (offer: RestoreOffer) => void;
  /** Settles a restore conflict: the snapshot's text (`mine`, one undoable entry) or the file as it is (`disk`). */
  settleRestore: (path: string, keep: 'mine' | 'disk') => void;
  /** The replace prompt shows, or goes. */
  setReplacing: (replacing: Replacing | undefined) => void;
  setEdit: (on: boolean) => void;
  /** The author chose to edit a generated file: "Edit anyway". */
  unlock: (path: string) => void;
  projectLoading: () => void;
  projectReady: (version: number, outline: Outline, files: number) => void;
  /** A load of edited texts broke YAML that parsed: the project shown stays (§ 7.2). */
  projectHeld: (held: Held) => void;
  projectFailed: (error: SessionError) => void;
  engineReady: (info: { version: string; models: ModelInfo[] }) => void;
  engineFailed: (error: SessionError) => void;
  /**
   * The engine was restarted. `project` is the id the fresh worker gave the texts it loaded, adopted for the project
   * shown; `null` when those are not the shown project's texts, which the old worker took with it.
   */
  engineRestarted: (restarts: number, project: number | null | undefined) => void;
  engineBusy: (busy: boolean) => void;
  planReceived: (plan: PlanState) => void;
  rejected: (error: SessionError) => void;
  clearError: () => void;
  notify: (text: string) => number;
  dismissNotice: (id: number) => void;
}

export type SessionStore = StoreApi<SessionState & SessionActions>;

const DEFAULT_SCENARIO: ScenarioInput = { event: 'push' };

const NO_FILES: SessionState['files'] = {
  version: 0,
  epoch: 0,
  byPath: {},
  meta: {},
  revs: {},
  base: {},
  opened: {},
};

export function initialSessionState(prefs: Prefs = DEFAULT_PREFS): SessionState {
  return {
    source: { kind: 'none' },
    files: NO_FILES,
    project: { status: 'idle' },
    scenario: DEFAULT_SCENARIO,
    scenarioFrom: 'default',
    assumed: [],
    assume: [],
    detail: 'steps',
    engine: { status: 'booting', models: [], restarts: 0, busy: false },
    stale: false,
    staleShown: false,
    caseOpen: false,
    ui: { view: 'graph', hideUntriggered: false, prefs, expanded: [], representative: {}, opened: [] },
    notices: [],
    edit: { ...history.emptyHistory(), on: false, unlocked: [] },
  };
}

/**
 * The edit state of a new epoch: no history, no restore offer, nothing unlocked (another repository's file at the same
 * path is another file); entry ids go on, so none is ever reused.
 */
const freshEdit = (edit: EditState): EditState => ({
  ...history.emptyHistory(edit.next),
  on: edit.on,
  unlocked: [],
});

/** Where the last commit changed the files first: its file and the line of its first edit, in the new text. */
function revealPatch(s: SessionState): Partial<SessionState> | undefined {
  const edited = s.files.edited;
  if (!edited) return undefined;
  const path = Object.keys(edited.edits).find((p) => s.files.byPath[p] !== undefined);
  const splices = path === undefined ? undefined : edited.edits[path];
  if (path === undefined || !splices?.length) return undefined;
  const text = s.files.byPath[path]!;
  const at = Math.min(text.length, touched(splices)[0]!.from);
  const line = text.slice(0, at).split(/\r\n?|\n/).length;
  return { reveal: { file: path, line, seq: ++requestSeq }, ui: withYamlFile(s.ui, path) };
}

/** The edit state with its history gone and the rest (the mode, the unlocks, a restore offer) kept. */
const clearedHistory = (edit: EditState): EditState => ({
  ...edit,
  ...history.emptyHistory(edit.next),
  group: undefined,
  lastOrigin: undefined,
});

/** Each generated file's marker, by path. */
function markersOf(outline: Outline): Record<string, string> {
  const markers: Record<string, string> = {};
  for (const f of outline.files) if (f.generated !== undefined) markers[f.path] = f.generated;
  return markers;
}

const withoutConflict = (edit: EditState, path: string): EditState => {
  const conflicts = edit.restore?.conflicts.filter((c) => c.path !== path) ?? [];
  return {
    ...edit,
    restore: conflicts.length > 0 && edit.restore ? { ...edit.restore, conflicts } : undefined,
  };
};

/** The transaction that puts a conflicting file back to the snapshot's text: one region edit, or a creation. */
function restoreOf(s: SessionState, conflict: RestoreConflict): history.TxInput {
  const current = s.files.byPath[conflict.path];
  const name = conflict.path.slice(conflict.path.lastIndexOf('/') + 1);
  const file: history.TxFile =
    current === undefined
      ? { path: conflict.path, edits: [{ from: 0, to: 0, insert: conflict.text }], create: true }
      : {
          path: conflict.path,
          edits: [regionEdit(current, conflict.text)],
          expect: history.stampOf(current),
        };
  return { label: `Restored unsaved edits to ${name}`, origin: 'restore', files: [file] };
}

/** Per path whose text is not its base: the base, or `null` when it has none (a file created since). */
export type BaseDiff = Record<string, string | null>;

/**
 * The files whose text is not what was read or last saved: edited, created since, or removed since. A selector, never
 * stored: undoing back to the base leaves nothing unsaved.
 */
export function dirtyPaths(files: Pick<SessionState['files'], 'byPath' | 'base'>): string[] {
  const dirty = Object.keys(files.byPath).filter((path) => files.byPath[path] !== files.base[path]);
  for (const path of Object.keys(files.base)) if (!Object.hasOwn(files.byPath, path)) dirty.push(path);
  return dirty;
}

let noticeId = 0;
let requestSeq = 0;
/** Pins count apart from the pin the store holds, which new files drop (`pinOver`). */
let pinSeq = 0;

/**
 * What belongs to the files that were there: the pin made over their plan, and the unknown hovered or asked for,
 * which the next files' plan may not have. New files, or none, clear it all, so no plan of theirs settles that pin.
 */
const UNPINNED = { pin: undefined, hoveredUnknown: undefined, unknownFocus: undefined } as const;

/** What a new source starts from: nothing loaded, simulated or drawn, and nothing pinned over the files before. */
const UNLOADED = {
  project: { status: 'idle' },
  plan: undefined,
  graph: undefined,
  generated: undefined,
  stale: false,
  ...UNPINNED,
} as const;

export function createSessionStore(initial: SessionState = initialSessionState()): SessionStore {
  return createStore<SessionState & SessionActions>((set, get) => {
    /** Commits a step of the history in one `set()` with the texts it changes (`committed`). */
    const commit = (step: (s: SessionState) => StepOutcome, verb?: 'undo' | 'redo'): EditOutcome => {
      let outcome: EditOutcome = { ok: false };
      set((s) => {
        const result = committed(s, step(s), verb && { verb, id: ++noticeId });
        outcome = result.outcome;
        return result.patch;
      });
      return outcome;
    };
    /** After an undo or a redo, the pane shows the file and the line it changed (§ 6); it is not opened for it. */
    const revealed = (outcome: EditOutcome): boolean => {
      if (outcome.ok) set((s) => revealPatch(s) ?? s);
      return outcome.ok;
    };
    return {
      ...initial,
      setFiles: (byPath, source, meta, base) =>
        set((s) => ({
          source,
          files: sourceFiles(s.files, byPath, metaOf(byPath, meta), base),
          ...UNLOADED,
          edit: freshEdit(s.edit),
          error: s.error?.kind === 'source' ? undefined : s.error,
        })),
      forgetSource: () =>
        set((s) => ({
          source: { kind: 'none' },
          files: sourceFiles(s.files, {}, {}),
          ...UNLOADED,
          edit: freshEdit(s.edit),
          focus: undefined,
          sel: undefined,
          error: replaceError(s.error, undefined),
        })),
      // A new epoch, so the session takes it for a source with no files, not for an edit that emptied them.
      awaitReopen: (source) => get().setFiles({}, source),
      setScenario: (scenario, options) =>
        set((s) => ({
          scenario,
          scenarioFrom: options?.from ?? 'author',
          assumed: options?.assumed ?? [],
          stale: inputsStale(s),
          error: authorsErrorCleared(s.error, 'scenario'),
        })),
      patchScenario: (patch) =>
        set((s) => ({
          scenario: withPatch(s.scenario, patch),
          scenarioFrom: 'author',
          assumed: s.assumed.filter((k) => !edits(k, s.scenario, patch)),
          stale: inputsStale(s),
          error: authorsErrorCleared(s.error, 'scenario'),
        })),
      pinScenario: (scenario, keys, focus) =>
        set((s) => ({
          scenario,
          scenarioFrom: 'author',
          assumed: Array.from(new Set([...s.assumed, ...keys])),
          stale: inputsStale(s),
          error: authorsErrorCleared(s.error, 'scenario'),
          fieldFocus: { ...focus, seq: ++requestSeq },
          pin: pinOver(s, scenario, s.assume),
        })),
      focusField: (focus) => set({ fieldFocus: { ...focus, seq: ++requestSeq } }),
      fieldFocused: (seq) => set((s) => (s.fieldFocus?.seq === seq ? { fieldFocus: undefined } : {})),
      setAssume: (assume) =>
        set((s) => ({ assume, stale: inputsStale(s), error: authorsErrorCleared(s.error, 'assume') })),
      pinAssume: (assume) =>
        set((s) => ({
          assume,
          stale: inputsStale(s),
          error: authorsErrorCleared(s.error, 'assume'),
          pin: pinOver(s, s.scenario, assume),
        })),
      setDetail: (detail) => set((s) => ({ detail, stale: inputsStale(s) })),
      setFocus: (focus) => set({ focus }),
      // Returning `s` skips the update: a held selection keeps the tab the author picked.
      select: (focus, sel) =>
        set((s) =>
          s.focus === focus && s.sel === sel ? s : { focus, sel, ui: withYamlFile(s.ui, undefined) },
        ),
      toggleExpanded: (job) => set((s) => ({ ui: { ...s.ui, expanded: toggled(s.ui.expanded, job) } })),
      setRepresentative: (job, leg) =>
        set((s) => ({ ui: { ...s.ui, representative: { ...s.ui.representative, [job]: leg } } })),
      toggleOpened: (scope) => set((s) => ({ ui: { ...s.ui, opened: toggled(s.ui.opened, scope) } })),
      graphReady: (graph) => set({ graph }),
      setView: (view) => set((s) => ({ ui: { ...s.ui, view } })),
      setHideUntriggered: (hideUntriggered) => set((s) => ({ ui: { ...s.ui, hideUntriggered } })),
      setPrefs: (patch) => set((s) => ({ ui: { ...s.ui, prefs: { ...s.ui.prefs, ...patch } } })),
      setPanel: (panel) => get().setPrefs({ panel }),
      togglePane: (pane) => {
        const { collapsed } = get().ui.prefs;
        get().setPrefs({ collapsed: { ...collapsed, [pane]: !collapsed[pane] } });
      },
      revealLine: ({ file, line }) =>
        set((s) => ({
          reveal: { file, line, seq: ++requestSeq },
          ui: {
            ...s.ui,
            yamlFile: file,
            prefs: { ...s.ui.prefs, collapsed: { ...s.ui.prefs.collapsed, yaml: false } },
          },
        })),
      setYamlFile: (yamlFile) => set((s) => ({ ui: withYamlFile(s.ui, yamlFile) })),
      openCase: () => set({ caseOpen: true }),
      closeCase: () => set({ caseOpen: false }),
      hoverUnknown: (hoveredUnknown) =>
        set((s) => (s.hoveredUnknown === hoveredUnknown ? s : { hoveredUnknown })),
      showUnknown: (id) =>
        set((s) => ({
          unknownFocus: { id, seq: ++requestSeq },
          ui: {
            ...s.ui,
            prefs: { ...s.ui.prefs, panel: 'unknowns', collapsed: { ...s.ui.prefs.collapsed, right: false } },
          },
        })),
      unknownFocused: (seq) => set((s) => (s.unknownFocus?.seq === seq ? { unknownFocus: undefined } : {})),
      transact: (input) => commit((s) => history.transact(s.edit, s.files.byPath, input, contextOf(s))),
      typed: (path, splices, alone) =>
        commit((s) => history.typed(s.edit, s.files.byPath, path, splices, contextOf(s), alone)),
      closeGroup: () => set((s) => (s.edit.group ? { edit: { ...s.edit, ...history.close(s.edit) } } : s)),
      offerRestore: (restore) => set((s) => ({ edit: { ...s.edit, restore } })),
      settleRestore: (path, keep) => {
        const conflict = get().edit.restore?.conflicts.find((c) => c.path === path);
        if (!conflict) return;
        if (keep === 'mine')
          commit((s) => history.transact(s.edit, s.files.byPath, restoreOf(s, conflict), contextOf(s)));
        set((s) => ({ edit: withoutConflict(s.edit, path) }));
      },
      setReplacing: (replacing) => set({ replacing }),
      setEdit: (on) =>
        set((s) =>
          s.edit.on === on
            ? s
            : { edit: { ...history.close(s.edit), restore: s.edit.restore, on, unlocked: s.edit.unlocked } },
        ),
      unlock: (path) =>
        set((s) =>
          s.edit.unlocked.includes(path) ? s : { edit: { ...s.edit, unlocked: [...s.edit.unlocked, path] } },
        ),
      undo: () => revealed(commit((s) => history.undo(s.edit, s.files.byPath), 'undo')),
      redo: () => revealed(commit((s) => history.redo(s.edit, s.files.byPath), 'redo')),
      projectLoading: () => set((s) => ({ project: { ...s.project, status: 'loading' } })),
      // A new project of the newest texts: whatever was held is released.
      projectReady: (version, outline, files) =>
        set((s) => ({
          project: { status: 'ready', version, outline, files },
          generated: markersOf(outline),
          error: replaceError(s.error, undefined),
        })),
      projectHeld: (held) =>
        set((s) => ({ project: { ...s.project, held }, generated: markersOf(held.outline) })),
      projectFailed: (error) =>
        set((s) => ({ project: { status: 'error' }, error: replaceError(s.error, error) })),
      engineReady: ({ version, models }) =>
        set((s) => ({ engine: { ...s.engine, status: 'ready', version, models } })),
      engineFailed: (error) =>
        set((s) => ({ engine: { ...s.engine, status: 'failed', busy: false }, error })),
      engineRestarted: (restarts, project) =>
        set((s) => ({
          engine: { ...s.engine, restarts },
          project: project === undefined ? s.project : { ...s.project, version: project ?? undefined },
        })),
      engineBusy: (busy) => set((s) => ({ engine: { ...s.engine, busy } })),
      planReceived: (plan) =>
        set((s) => ({
          plan,
          // A plan of older texts (an input changed while an edit was loading) is still behind the edit.
          stale: plan.for.files < s.files.version ? 'edit' : false,
          error: replaceError(s.error, undefined),
          pin: answered(s.pin, plan),
        })),
      rejected: (error) => set((s) => ({ error: replaceError(s.error, error) })),
      clearError: () => set((s) => ({ error: replaceError(s.error, undefined) })),
      notify: (text) => {
        const id = ++noticeId;
        set((s) => ({ notices: [...s.notices, { id, text }] }));
        return id;
      },
      dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
    };
  });
}

type StepOutcome = history.Step | history.Refusal | undefined;

/**
 * What a step of the history does to the store: its texts and its history in one patch, the source's buffers with
 * them. A refused step changes nothing, but an undo or a redo the hash guard stopped clears the history and says so:
 * none of its entries can be trusted any more.
 */
function committed(
  s: SessionState,
  outcome: StepOutcome,
  stopped?: { verb: string; id: number },
): { patch: Partial<SessionState>; outcome: EditOutcome } {
  if (outcome === undefined) return { patch: s, outcome: { ok: false } };
  if ('refused' in outcome) {
    if (outcome.refused !== 'desync' || !stopped)
      return { patch: s, outcome: { ok: false, refusal: outcome } };
    const text = `${stopped.verb} stopped: ${fileLabel(outcome.path)} changed outside the history`;
    return {
      patch: { edit: clearedHistory(s.edit), notices: [...s.notices, { id: stopped.id, text }] },
      outcome: { ok: false, refusal: outcome },
    };
  }
  const texts = withTexts(s, outcome.changes);
  // Nothing moved: no update, so no listener runs.
  if (!texts.files && outcome.history === s.edit) return { patch: s, outcome: { ok: false } };
  const patch: Partial<SessionState> = { ...texts, edit: { ...s.edit, ...outcome.history } };
  if (texts.files)
    texts.files.edited = {
      version: texts.files.version,
      revs: s.files.revs,
      edits: outcome.edits,
      eols: Object.fromEntries(Object.keys(outcome.edits).map((p) => [p, s.files.meta[p]?.eol ?? 'none'])),
    };
  if (!texts.files) return { patch, outcome: { ok: false } };
  patch.source = writtenThrough(s.source, outcome.changes, texts.files.byPath);
  return { patch, outcome: { ok: true } };
}

/**
 * The source after an edit (synthesis § 5.5). Pasted buffers follow their files' texts, so pasting another file,
 * removing one or reloading the page keeps the edit, and the buffer writer persists them. A sample becomes the
 * buffers of its edited copy: the sample itself never changes. A folder's edits are the crash snapshot's (A4).
 */
function writtenThrough(
  source: Source,
  changes: history.TextChanges,
  byPath: Record<string, string>,
): Source {
  if (source.kind === 'sample')
    return {
      kind: 'paste',
      name: `edited copy of the ${source.name} sample`,
      buffers: Object.entries(byPath).map(([path, text]) => ({ path, text })),
    };
  if (source.kind !== 'paste') return source;
  const buffers = source.buffers
    .filter((b) => changes[b.path] !== null)
    .map((b) => (Object.hasOwn(changes, b.path) ? { path: b.path, text: changes[b.path]! } : b));
  for (const [path, text] of Object.entries(changes))
    if (text !== null && !source.buffers.some((b) => b.path === path)) buffers.push({ path, text });
  return { ...source, buffers };
}

const contextOf = (s: SessionState): history.Context => ({
  at: Date.now(),
  selection: {
    ...(s.focus === undefined ? {} : { focus: s.focus }),
    ...(s.sel === undefined ? {} : { sel: s.sel }),
  },
});

/**
 * The files of a new source: a new epoch, every file at the new version, its text as read and as opened, except
 * where `diff` gives the text its edits were made to (pasted buffers carry their edits across epochs).
 */
function sourceFiles(
  files: SessionState['files'],
  byPath: Record<string, string>,
  meta: Record<string, FileMeta>,
  diff?: BaseDiff,
): SessionState['files'] {
  const version = files.version + 1;
  const revs = Object.fromEntries(Object.keys(byPath).map((path) => [path, version]));
  const base = { ...byPath };
  for (const [path, text] of Object.entries(diff ?? {}))
    if (text === null) delete base[path];
    else base[path] = text;
  return { version, epoch: files.epoch + 1, byPath, meta, revs, base, opened: base };
}

/**
 * The texts changed within the epoch: the files version moves, and so does the rev of each file whose text changed;
 * the epoch, the base and the opened texts stay. A path new to the files gets the meta of a string, and `null`
 * removes a file (its meta stays, for the undo that brings it back). A file's `eol` follows its text, so a converted
 * file is no longer mixed, except that a text left with no line break keeps the ending it had, so its next lines get
 * it too; its BOM and its encoding stay what reading found. Nothing else of the store moves, the plan, the picture, the selection and the scenario
 * included: the plan is stale for the edit until the session brings the one of the new texts. Texts the files already
 * hold change nothing. This is what an edit of the store's texts reduces to; the history's steps commit through it.
 */
export function withTexts(
  s: SessionState,
  texts: Readonly<Record<string, string | null>>,
): Partial<Pick<SessionState, 'files' | 'stale'>> {
  const changed = Object.entries(texts).filter(([path, text]) =>
    text === null ? Object.hasOwn(s.files.byPath, path) : s.files.byPath[path] !== text,
  );
  if (changed.length === 0) return {};
  const version = s.files.version + 1;
  const files = {
    ...s.files,
    edited: undefined,
    version,
    byPath: { ...s.files.byPath },
    meta: { ...s.files.meta },
    revs: { ...s.files.revs },
  };
  for (const [path, text] of changed) {
    if (text === null) {
      delete files.byPath[path];
      delete files.revs[path];
      continue;
    }
    files.byPath[path] = text;
    const meta = files.meta[path];
    files.meta[path] = meta ? withEol(meta, text) : textMeta(text);
    files.revs[path] = version;
  }
  // Only a project file's text is in the plan; a test file (C10) leaves it current.
  const planned = changed.some(([path]) => isProjectFile(path));
  return { files, stale: s.plan === undefined ? false : planned ? 'edit' : s.stale };
}

/** A file's meta for its new text: its line endings as the text has them, the ones it had while it has no break. */
const withEol = (meta: FileMeta, text: string): FileMeta => {
  const eol = classifyEol(text);
  return eol === meta.eol || eol === 'none' ? meta : { ...meta, eol };
};

/** An input changed: the plan shown, if any, is stale for it. */
const inputsStale = (s: SessionState): SessionState['stale'] => (s.plan === undefined ? false : 'inputs');

/** The meta of each file: as the reader gave it, else that of a string. A path not in `byPath` is dropped. */
function metaOf(
  byPath: Record<string, string>,
  given: Record<string, FileMeta> = {},
): Record<string, FileMeta> {
  const meta: Record<string, FileMeta> = {};
  for (const [path, text] of Object.entries(byPath)) meta[path] = given[path] ?? textMeta(text);
  return meta;
}

/**
 * Whether a patch edits what an assumed mark is on: its key, or for `inputs.<name>` that one input, so an edit of
 * another input keeps the mark.
 */
function edits(mark: string, scenario: ScenarioInput, patch: Partial<ScenarioInput>): boolean {
  const [key = '', name] = mark.split(/\.(.*)/s);
  if (!(key in patch)) return false;
  if (name === undefined) return true;
  const before = (scenario as Record<string, unknown>)[key];
  const after = (patch as Record<string, unknown>)[key];
  return JSON.stringify(entryOf(before, name)) !== JSON.stringify(entryOf(after, name));
}

const entryOf = (record: unknown, name: string): unknown =>
  typeof record === 'object' && record !== null && Object.hasOwn(record, name)
    ? (record as Record<string, unknown>)[name]
    : undefined;

/** A patch value of `undefined` removes the key: the schema is strict and the URL carries only what is set. */
function withPatch(scenario: ScenarioInput, patch: Partial<ScenarioInput>): ScenarioInput {
  const next = { ...scenario } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as ScenarioInput;
}

function withYamlFile(ui: SessionState['ui'], yamlFile: string | undefined): SessionState['ui'] {
  const next = { ...ui };
  if (yamlFile === undefined) delete next.yamlFile;
  else next.yamlFile = yamlFile;
  return next;
}

const toggled = (list: readonly string[], item: string): string[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

/**
 * A pin over the store as it is: the plan it is made over and the inputs it leaves. Its `seq` comes from `pinSeq`,
 * so one pin and the next always differ in parity, whatever cleared the pin between them.
 */
const pinOver = (s: SessionState, scenario: ScenarioInput, assume: AssumeEntry[]): Pin => ({
  seq: ++pinSeq,
  ...(s.plan ? { before: { plan: s.plan.plan, derived: s.plan.derived } } : {}),
  scenario,
  assume,
});

/**
 * The pin with what the plan answering it changed: the plan simulated from the very inputs the pin left. A plan for
 * other inputs (an older reply, an edit after the pin) leaves the pin waiting; one already answered stays as it is.
 * A settled pin drops the plan it was made over, which nothing reads once the changes are known, so the store does
 * not hold an old plan for as long as the pin stays.
 */
function answered(pin: Pin | undefined, plan: PlanState): Pin | undefined {
  if (!pin?.before || pin.after || plan.for.scenario !== pin.scenario || plan.for.assume !== pin.assume)
    return pin;
  const changes = verdictChanges(pin.before, plan);
  const { seq, scenario, assume } = pin;
  return { seq, scenario, assume, after: { plan: plan.plan, changes, sentence: pinSentence(changes) } };
}

/** Why the pane may not edit a file, or that it may. */
export type Writable =
  | { ok: true }
  | { ok: false; reason: 'off' | 'missing' | 'encoding' | 'loading' | 'mixed' }
  | { ok: false; reason: 'generated'; marker: string };

/**
 * Whether the pane may edit a file (synthesis § 4.3): in edit mode, a file read as valid UTF-8, known not to be
 * generated (an Outline of the epoch has come) unless the author unlocked it in this epoch or has edited it already
 * (a marker typed into it does not lock it under the cursor), with one kind of line ending. Generated is said before
 * mixed, so a locked file never offers Convert. Invalid YAML stays writable: the pane is where it gets fixed.
 */
export function writable(s: Pick<SessionState, 'edit' | 'files' | 'generated'>, path: string): Writable {
  if (!s.edit.on) return { ok: false, reason: 'off' };
  const meta = s.files.meta[path];
  const text = s.files.byPath[path];
  if (text === undefined || !meta) return { ok: false, reason: 'missing' };
  if (!meta.utf8) return { ok: false, reason: 'encoding' };
  if (s.generated === undefined) return { ok: false, reason: 'loading' };
  const marker = s.generated[path];
  const kept = s.edit.unlocked.includes(path) || text !== s.files.base[path];
  if (marker !== undefined && !kept) return { ok: false, reason: 'generated', marker };
  if (meta.eol === 'mixed') return { ok: false, reason: 'mixed' };
  return { ok: true };
}

/** The Outline of the newest texts loaded: the held one while the hold is on, since its errors are what to fix. */
export const newestOutline = (s: Pick<SessionState, 'project'>): Outline | undefined =>
  s.project.held?.outline ?? s.project.outline;

/** The files version `newestOutline` is of. */
export const newestOutlined = (s: Pick<SessionState, 'project'>): number | undefined =>
  s.project.held?.files ?? s.project.files;

/** The errors only a reload clears: the engine never started, or it stopped and could not be restarted. */
export function isBlocking(error: SessionError | undefined): boolean {
  return error?.kind === 'boot' || error?.kind === 'stopped';
}

/** A blocking error stays until the page reloads; any other gives way to `next`. */
function replaceError(
  error: SessionError | undefined,
  next: SessionError | undefined,
): SessionError | undefined {
  return isBlocking(error) ? error : next;
}

/** An edit of the thing the worker rejected clears that rejection; other errors stay. */
function authorsErrorCleared(
  error: SessionError | undefined,
  kind: 'scenario' | 'assume',
): SessionError | undefined {
  return error?.kind === kind ? undefined : error;
}
