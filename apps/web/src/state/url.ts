import type { AssumeEntry, ScenarioInput } from '@simulci/engine';

/**
 * What the URL carries: the scenario's own keys, `a` (the assume entries), `wf` (the focused workflow), `sel` (the
 * selected unit path), `d` (`legs`), `view` (`text`) and `hide` (`1`). Files never. The picker checks shapes only,
 * deep enough that the form can show whatever it keeps; the worker validates and answers `invalid` on the field.
 */

/** The keys of `ScenarioInputSchema`, in its order; a test holds this list to the schema. */
export const SCENARIO_KEYS = [
  'event',
  'action',
  'ref',
  'branch',
  'tag',
  'base',
  'head',
  'number',
  'merged',
  'sha',
  'defaultBranch',
  'repository',
  'message',
  'actor',
  'changed',
  'inputs',
  'vars',
  'secrets',
  'environments',
  'cron',
  'workflow_run',
  'platform',
] as const;

type ScenarioKey = (typeof SCENARIO_KEYS)[number];

/**
 * `record`: an object of plain values, as every record key of the scenario is; `changes`: paths, or records with a
 * `path`, as `changed` holds them. The form turns these values into text, which a nested object can refuse to become.
 */
type Shape = 'string' | 'number' | 'boolean' | 'array' | 'record' | 'changes';

const SHAPES: Record<ScenarioKey, Shape> = {
  event: 'string',
  action: 'string',
  ref: 'string',
  branch: 'string',
  tag: 'string',
  base: 'string',
  head: 'string',
  number: 'number',
  merged: 'boolean',
  sha: 'string',
  defaultBranch: 'string',
  repository: 'string',
  message: 'string',
  actor: 'record',
  changed: 'changes',
  inputs: 'record',
  vars: 'record',
  secrets: 'array',
  environments: 'array',
  cron: 'string',
  workflow_run: 'record',
  platform: 'string',
};

export interface UrlState {
  scenario?: ScenarioInput;
  assume?: AssumeEntry[];
  wf?: string;
  sel?: string;
  d?: 'legs';
  view?: 'text';
  hide?: true;
}

/** Beyond this many characters of JSON the assume entries stay in the store and leave the URL. */
export const ASSUME_URL_LIMIT = 8 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlain = (value: unknown): boolean => value === null || typeof value !== 'object';

const isRecord = (value: unknown): boolean => isObject(value) && Object.values(value).every(isPlain);

const isChange = (value: unknown): boolean => typeof value === 'string' || isRecord(value);

function hasShape(value: unknown, shape: Shape): boolean {
  if (shape === 'array') return Array.isArray(value);
  if (shape === 'record') return isRecord(value);
  if (shape === 'changes') return Array.isArray(value) && value.every(isChange);
  return typeof value === shape;
}

/** The scenario the search params spell, when they name an event; keys of the wrong shape are dropped. */
function scenarioOf(raw: Record<string, unknown>): ScenarioInput | undefined {
  if (typeof raw.event !== 'string' || raw.event === '') return undefined;
  const scenario: Record<string, unknown> = {};
  for (const key of SCENARIO_KEYS)
    if (key in raw && hasShape(raw[key], SHAPES[key])) scenario[key] = raw[key];
  return scenario as unknown as ScenarioInput;
}

const isEntry = (e: unknown): e is AssumeEntry => isObject(e);

/** Reads the search params; anything unexpected is left out rather than refused. */
export function readSearch(raw: Record<string, unknown>): UrlState {
  const state: UrlState = {};
  const scenario = scenarioOf(raw);
  if (scenario) state.scenario = scenario;
  if (Array.isArray(raw.a) && raw.a.every(isEntry)) state.assume = raw.a;
  if (typeof raw.wf === 'string' && raw.wf) state.wf = raw.wf;
  if (typeof raw.sel === 'string' && raw.sel) state.sel = raw.sel;
  if (raw.d === 'legs') state.d = 'legs';
  if (raw.view === 'text') state.view = 'text';
  if (raw.hide === 1 || raw.hide === '1' || raw.hide === true) state.hide = true;
  return state;
}

/** The route's `validateSearch`: what the picker keeps, written the way the bridge writes it. */
export const validateSearch = (raw: Record<string, unknown>): Record<string, unknown> =>
  writeSearch(readSearch(raw));

/** The search params for a state; the inverse of `readSearch` for what it keeps. */
export function writeSearch(state: UrlState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (state.scenario) {
    const s = state.scenario as unknown as Record<string, unknown>;
    for (const key of SCENARIO_KEYS) if (s[key] !== undefined && !isEmpty(s[key])) out[key] = s[key];
  }
  if (state.assume?.length && JSON.stringify(state.assume).length <= ASSUME_URL_LIMIT) out.a = state.assume;
  if (state.wf) out.wf = state.wf;
  if (state.sel) out.sel = state.sel;
  if (state.d === 'legs') out.d = 'legs';
  if (state.view === 'text') out.view = 'text';
  if (state.hide) out.hide = 1;
  return out;
}

/** Empty strings, arrays and records say nothing the engine's defaults do not. */
function isEmpty(value: unknown): boolean {
  if (value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length === 0;
  return false;
}

/** The URL-backed slice of a session: what `UrlSync` writes back. */
export interface UrlSource {
  scenario: ScenarioInput;
  assume: AssumeEntry[];
  focus?: string;
  detail: 'legs' | 'steps';
  ui: { view: 'graph' | 'text'; hideUntriggered: boolean };
}

export function urlStateOf(s: UrlSource): UrlState {
  const state: UrlState = { scenario: s.scenario, assume: s.assume };
  if (s.focus) state.wf = s.focus;
  if (s.detail === 'legs') state.d = 'legs';
  if (s.ui.view === 'text') state.view = 'text';
  if (s.ui.hideUntriggered) state.hide = true;
  return state;
}

export function urlSliceChanged(s: UrlSource, prev: UrlSource): boolean {
  return (
    s.scenario !== prev.scenario ||
    s.assume !== prev.assume ||
    s.focus !== prev.focus ||
    s.detail !== prev.detail ||
    s.ui.view !== prev.ui.view ||
    s.ui.hideUntriggered !== prev.ui.hideUntriggered
  );
}
