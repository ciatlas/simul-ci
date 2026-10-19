import type { AssumeEntry, RunPlan, ScenarioInput } from '@simulci/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Derived, ModelInfo, Outline } from '../worker/protocol';
import { DEFAULT_PREFS, type Prefs } from './prefs';

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
  /** The files version and the project version the plan answers. */
  for: { files: number; project: number };
}

export interface Notice {
  id: number;
  text: string;
}

export interface SessionState {
  source: Source;
  files: { version: number; byPath: Record<string, string> };
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
  ui: { view: 'graph' | 'text'; hideUntriggered: boolean; prefs: Prefs };
  notices: Notice[];
}

export interface SessionActions {
  setFiles: (byPath: Record<string, string>, source: Source) => void;
  forgetSource: () => void;
  setScenario: (
    scenario: ScenarioInput,
    options?: { assumed?: string[]; from?: SessionState['scenarioFrom'] },
  ) => void;
  patchScenario: (patch: Partial<ScenarioInput>) => void;
  setAssume: (assume: AssumeEntry[]) => void;
  setDetail: (detail: 'legs' | 'steps') => void;
  setFocus: (focus: string | undefined) => void;
  setView: (view: 'graph' | 'text') => void;
  setHideUntriggered: (hide: boolean) => void;
  setPrefs: (patch: Partial<Prefs>) => void;
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
    files: { version: 0, byPath: {} },
    project: { status: 'idle' },
    scenario: DEFAULT_SCENARIO,
    scenarioFrom: 'default',
    assumed: [],
    assume: [],
    detail: 'steps',
    engine: { status: 'booting', models: [], restarts: 0, busy: false },
    stale: false,
    ui: { view: 'graph', hideUntriggered: false, prefs },
    notices: [],
  };
}

let noticeId = 0;

export function createSessionStore(initial: SessionState = initialSessionState()): SessionStore {
  return createStore<SessionState & SessionActions>((set, get) => ({
    ...initial,
    setFiles: (byPath, source) =>
      set((s) => ({
        source,
        files: { version: s.files.version + 1, byPath },
        project: { status: 'idle' },
        plan: undefined,
        stale: false,
        error: s.error?.kind === 'source' ? undefined : s.error,
      })),
    forgetSource: () =>
      set({
        source: { kind: 'none' },
        files: { version: get().files.version + 1, byPath: {} },
        project: { status: 'idle' },
        plan: undefined,
        stale: false,
        focus: undefined,
        error: replaceError(get().error, undefined),
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
        assumed: s.assumed.filter((k) => !(k in patch)),
        stale: s.plan !== undefined,
        error: authorsErrorCleared(s.error, 'scenario'),
      })),
    setAssume: (assume) =>
      set((s) => ({ assume, stale: s.plan !== undefined, error: authorsErrorCleared(s.error, 'assume') })),
    setDetail: (detail) => set((s) => ({ detail, stale: s.plan !== undefined })),
    setFocus: (focus) => set({ focus }),
    setView: (view) => set((s) => ({ ui: { ...s.ui, view } })),
    setHideUntriggered: (hideUntriggered) => set((s) => ({ ui: { ...s.ui, hideUntriggered } })),
    setPrefs: (patch) => set((s) => ({ ui: { ...s.ui, prefs: { ...s.ui.prefs, ...patch } } })),
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

/** A patch value of `undefined` removes the key: the schema is strict and the URL carries only what is set. */
function withPatch(scenario: ScenarioInput, patch: Partial<ScenarioInput>): ScenarioInput {
  const next = { ...scenario } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as ScenarioInput;
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
