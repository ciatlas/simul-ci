import type { AssumeEntry, RunPlan, ScenarioInput, UnknownId } from '@simulci/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { GraphState, GraphUi } from '../graph/types';
import { type FileMeta, textMeta } from '../input/read';
import { pinSentence, type VerdictChange, verdictChanges } from '../plan/changes';
import type { Derived, ModelInfo, Outline } from '../worker/protocol';
import { DEFAULT_PREFS, type PanelTab, type Prefs } from './prefs';

/**
 * The one store of the page: plain data, nothing derived, nothing the engine owns. Panels read it through selectors;
 * only the session talks to the worker, only the router sync writes the URL, only persist.ts and prefs.ts touch
 * storage.
 */

export type Source =
  | { kind: 'none' }
  | { kind: 'sample'; name: string }
  | { kind: 'paste'; buffers: { path: string; text: string }[] }
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
   * The files version and the project version the plan answers, and the case layer it was simulated with: the plan
   * names the assume entries by position, so it speaks of the list it was given and of no other. The scenario is the
   * store's object it was simulated from, so a pin can tell the plan that answers it.
   */
  for: { files: number; project: number; assume?: AssumeEntry[]; scenario?: ScenarioInput };
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
    version: number;
    /** The project files' texts, a BOM stripped. */
    byPath: Record<string, string>;
    /** What reading each file in `byPath` found: its BOM, its line endings, whether it is valid UTF-8. */
    meta: Record<string, FileMeta>;
  };
  project: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    version?: number;
    outline?: Outline;
    files?: number;
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
  /** The inputs changed since `plan` was computed. */
  stale: boolean;
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
  ui: Omit<GraphUi, 'hideUntriggered'> & {
    view: 'graph' | 'text';
    hideUntriggered: boolean;
    prefs: Prefs;
    /** The YAML pane's tab the author picked; absent, the pane follows the selection's file. */
    yamlFile?: string;
  };
  notices: Notice[];
}

export interface SessionActions {
  /** New files from a source; a file `meta` does not cover is a string no file was read for (a paste, a sample). */
  setFiles: (byPath: Record<string, string>, source: Source, meta?: Record<string, FileMeta>) => void;
  forgetSource: () => void;
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
  projectLoading: () => void;
  projectReady: (version: number, outline: Outline, files: number) => void;
  projectFailed: (error: SessionError) => void;
  engineReady: (info: { version: string; models: ModelInfo[] }) => void;
  engineFailed: (error: SessionError) => void;
  engineRestarted: (restarts: number, project: number | undefined) => void;
  engineBusy: (busy: boolean) => void;
  planReceived: (plan: PlanState) => void;
  rejected: (error: SessionError) => void;
  clearError: () => void;
  notify: (text: string) => number;
  dismissNotice: (id: number) => void;
}

export type SessionStore = StoreApi<SessionState & SessionActions>;

const DEFAULT_SCENARIO: ScenarioInput = { event: 'push' };

export function initialSessionState(prefs: Prefs = DEFAULT_PREFS): SessionState {
  return {
    source: { kind: 'none' },
    files: { version: 0, byPath: {}, meta: {} },
    project: { status: 'idle' },
    scenario: DEFAULT_SCENARIO,
    scenarioFrom: 'default',
    assumed: [],
    assume: [],
    detail: 'steps',
    engine: { status: 'booting', models: [], restarts: 0, busy: false },
    stale: false,
    caseOpen: false,
    ui: { view: 'graph', hideUntriggered: false, prefs, expanded: [], representative: {}, opened: [] },
    notices: [],
  };
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

export function createSessionStore(initial: SessionState = initialSessionState()): SessionStore {
  return createStore<SessionState & SessionActions>((set, get) => ({
    ...initial,
    setFiles: (byPath, source, meta) =>
      set((s) => ({
        source,
        files: { version: s.files.version + 1, byPath, meta: metaOf(byPath, meta) },
        project: { status: 'idle' },
        plan: undefined,
        graph: undefined,
        stale: false,
        error: s.error?.kind === 'source' ? undefined : s.error,
        ...UNPINNED,
      })),
    forgetSource: () =>
      set({
        source: { kind: 'none' },
        files: { version: get().files.version + 1, byPath: {}, meta: {} },
        project: { status: 'idle' },
        plan: undefined,
        graph: undefined,
        stale: false,
        focus: undefined,
        sel: undefined,
        error: replaceError(get().error, undefined),
        ...UNPINNED,
      }),
    setScenario: (scenario, options) =>
      set((s) => ({
        scenario,
        scenarioFrom: options?.from ?? 'author',
        assumed: options?.assumed ?? [],
        stale: s.plan !== undefined,
        error: authorsErrorCleared(s.error, 'scenario'),
      })),
    patchScenario: (patch) =>
      set((s) => ({
        scenario: withPatch(s.scenario, patch),
        scenarioFrom: 'author',
        assumed: s.assumed.filter((k) => !edits(k, s.scenario, patch)),
        stale: s.plan !== undefined,
        error: authorsErrorCleared(s.error, 'scenario'),
      })),
    pinScenario: (scenario, keys, focus) =>
      set((s) => ({
        scenario,
        scenarioFrom: 'author',
        assumed: Array.from(new Set([...s.assumed, ...keys])),
        stale: s.plan !== undefined,
        error: authorsErrorCleared(s.error, 'scenario'),
        fieldFocus: { ...focus, seq: ++requestSeq },
        pin: pinOver(s, scenario, s.assume),
      })),
    focusField: (focus) => set({ fieldFocus: { ...focus, seq: ++requestSeq } }),
    fieldFocused: (seq) => set((s) => (s.fieldFocus?.seq === seq ? { fieldFocus: undefined } : {})),
    setAssume: (assume) =>
      set((s) => ({ assume, stale: s.plan !== undefined, error: authorsErrorCleared(s.error, 'assume') })),
    pinAssume: (assume) =>
      set((s) => ({
        assume,
        stale: s.plan !== undefined,
        error: authorsErrorCleared(s.error, 'assume'),
        pin: pinOver(s, s.scenario, assume),
      })),
    setDetail: (detail) => set((s) => ({ detail, stale: s.plan !== undefined })),
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
    projectLoading: () => set((s) => ({ project: { ...s.project, status: 'loading' } })),
    projectReady: (version, outline, files) =>
      set((s) => ({
        project: { status: 'ready', version, outline, files },
        error: replaceError(s.error, undefined),
      })),
    projectFailed: (error) =>
      set((s) => ({ project: { status: 'error' }, error: replaceError(s.error, error) })),
    engineReady: ({ version, models }) =>
      set((s) => ({ engine: { ...s.engine, status: 'ready', version, models } })),
    engineFailed: (error) => set((s) => ({ engine: { ...s.engine, status: 'failed', busy: false }, error })),
    engineRestarted: (restarts, project) =>
      set((s) => ({
        engine: { ...s.engine, restarts },
        project: project === undefined ? s.project : { ...s.project, version: project },
      })),
    engineBusy: (busy) => set((s) => ({ engine: { ...s.engine, busy } })),
    planReceived: (plan) =>
      set((s) => ({
        plan,
        stale: false,
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
  }));
}

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
