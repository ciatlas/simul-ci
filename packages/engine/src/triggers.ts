import { getCronDescription } from '@actions/workflow-parser/model/converter/cron';
import type { EventsConfig } from '@actions/workflow-parser/model/workflow-template';
import { compilePattern, matchesPatterns, pathsMatch, refMatches, refSubject } from './filters';
import type {
  Decision,
  FilterKind,
  Json,
  Reason,
  Tri,
  Unknown,
  UnknownId,
  UnknownKind,
  Value,
} from './plan/types';
import type { Scenario } from './scenario';
import {
  ACTIVITY_TYPES,
  BASE_BRANCH_EVENTS,
  CUSTOM_TYPES_EVENTS,
  PATH_FILTER_EVENTS,
  SKIP_EVENTS,
  SKIP_MARKERS,
  SKIP_TRAILER,
} from './triggers-data';

/**
 * Whether a workflow's `on:` is triggered by a scenario, with the chain of reasons: the event, its activity types,
 * the schedule, every filter, the skip markers. The rules come from docs.github.com (fixtures/triggers). A gate the
 * scenario cannot decide (changed files not given, no activity type with a narrowed `types:`) makes the verdict
 * `maybe` and names the scenario field that would decide it.
 */

export interface TriggerMatch {
  decision: Decision;
  unknowns: Unknown[];
}

/** One gate of the trigger: its reason, whether it passed, and the unknown that would decide it. */
interface Gate {
  reason: Reason;
  matched: Value<boolean>;
  unknown?: Unknown;
}

type EventConfig = Record<string, unknown>;
type UnknownBoolean = { known: false; unknowns: UnknownId[] };

interface PatternList {
  kind: FilterKind;
  patterns: string[];
  include?: string[];
  ignore?: string[];
}

export function matchTrigger(events: EventsConfig, scenario: Scenario): TriggerMatch {
  const config = events[scenario.event] as EventConfig | undefined;
  const chain: Reason[] = [{ kind: 'event', event: scenario.event, listens: config !== undefined }];
  if (config === undefined) return { decision: { verdict: 'no', chain }, unknowns: [] };
  const gates = [
    ...activityGate(scenario, config),
    ...scheduleGate(scenario, config),
    ...refGates(scenario, config),
    ...pathsGate(scenario, config),
    ...skipGate(scenario),
  ];
  for (const g of gates) chain.push(g.reason);
  const unknowns = gates.flatMap((g) => (g.unknown ? [g.unknown] : []));
  return { decision: { verdict: verdictOf(gates.map((g) => g.matched)), chain }, unknowns };
}

/** The first skip marker a commit message carries, if any. */
export function skipMarker(message: string): string | undefined {
  const marker = SKIP_MARKERS.find((m) => message.includes(m));
  if (marker) return marker;
  const trailer = SKIP_TRAILER.exec(message);
  return trailer ? trailer[0] : undefined;
}

/**
 * A schedule's cron in words, in GitHub's own wording ("Runs at 06:00, only on Monday"): the workflow-parser's
 * description, so apps/web, which does not depend on it, gets it through the engine. `undefined` when GitHub would
 * not accept the cron (wrong field count, a value out of range, `@daily`, a stray space); the parser never throws.
 */
export function describeCron(cron: string): string | undefined {
  return getCronDescription(cron);
}

function activityGate(scenario: Scenario, config: EventConfig): Gate[] {
  const activity = activityTypes(scenario.event, config);
  if (!activity) return [];
  const { allowed, narrowed } = activity;
  if (scenario.action !== undefined) {
    const matched = known(allowed.includes(scenario.action));
    return [{ reason: { kind: 'types', action: scenario.action, allowed, matched }, matched }];
  }
  // Without an activity type, any of the default activities triggers the workflow; a narrowed `types:` needs one.
  if (!narrowed) return [{ reason: { kind: 'types', allowed, matched: known(true) }, matched: known(true) }];
  return [
    unknownGate('event', 'action', { action: allowed[0] ?? '' }, (m) => ({
      kind: 'types',
      allowed,
      matched: m,
    })),
  ];
}

function activityTypes(
  event: string,
  config: EventConfig,
): { allowed: string[]; narrowed: boolean } | undefined {
  const configured = stringList(config, 'types');
  if (configured) return { allowed: configured, narrowed: true };
  if (CUSTOM_TYPES_EVENTS.has(event)) return undefined;
  const table = ACTIVITY_TYPES[event];
  return table ? { allowed: table.default, narrowed: false } : undefined;
}

/** For `schedule`, the converter's config is the list of crons itself. */
function scheduleGate(scenario: Scenario, config: EventConfig): Gate[] {
  if (scenario.event !== 'schedule') return [];
  const crons = Array.isArray(config) ? (config as { cron: string }[]).map((s) => s.cron) : [];
  const matched = scenario.cron === undefined || crons.includes(scenario.cron);
  const reason: Reason = { kind: 'schedule', crons, matched };
  if (scenario.cron !== undefined) reason.cron = scenario.cron;
  return [{ reason, matched: known(matched) }];
}

function refGates(scenario: Scenario, config: EventConfig): Gate[] {
  const branches = patternList(config, 'branches', 'branches-ignore');
  if (scenario.event === 'push')
    return pushRefGate(scenario, branches, patternList(config, 'tags', 'tags-ignore'));
  if (scenario.event === 'workflow_run') return workflowRunGates(scenario, config, branches);
  // Pull requests and merge groups are filtered by the branch they target.
  if (!branches || !BASE_BRANCH_EVENTS.has(scenario.event)) return [];
  return [refGate(branches, scenario.baseRef ?? scenario.defaultBranch)];
}

/** A branch push is judged by `branches`, a tag push by `tags`; only the other kind's filter means no run. */
function pushRefGate(scenario: Scenario, branches?: PatternList, tags?: PatternList): Gate[] {
  if (scenario.ref === undefined) return [];
  const name = refSubject(scenario.ref);
  const [own, other] = scenario.refType === 'tag' ? [tags, branches] : [branches, tags];
  if (own) return [refGate(own, name)];
  if (other) return [{ reason: filterReason(other, name, false), matched: known(false) }];
  return [];
}

function refGate(filter: PatternList, name: string): Gate {
  const matched = refMatches(name, filter);
  return { reason: filterReason(filter, name, matched), matched: known(matched) };
}

/** `workflows` names the triggering workflow; `branches` the branch it ran on. Both come from the scenario. */
function workflowRunGates(scenario: Scenario, config: EventConfig, branches?: PatternList): Gate[] {
  const gates: Gate[] = [];
  const workflows = stringList(config, 'workflows');
  const run = scenario.workflow_run;
  if (workflows) {
    const filter: PatternList = { kind: 'workflows', patterns: workflows };
    if (run?.name === undefined) {
      const fragment = { workflow_run: { name: workflows[0] ?? '' } };
      gates.push(unknownGate('event', 'workflow_run.name', fragment, (m) => unknownFilterReason(filter, m)));
    } else {
      const matched = matchesPatterns(run.name, workflows.map(compilePattern));
      gates.push({ reason: filterReason(filter, run.name, matched), matched: known(matched) });
    }
  }
  if (branches) {
    if (run?.branch === undefined) {
      const fragment = { workflow_run: { branch: scenario.defaultBranch } };
      gates.push(
        unknownGate('event', 'workflow_run.branch', fragment, (m) => unknownFilterReason(branches, m)),
      );
    } else gates.push(refGate(branches, run.branch));
  }
  return gates;
}

/** Path filters need the changed files; they are not evaluated for pushes of tags. */
function pathsGate(scenario: Scenario, config: EventConfig): Gate[] {
  const filter = patternList(config, 'paths', 'paths-ignore');
  if (!filter || !PATH_FILTER_EVENTS.has(scenario.event)) return [];
  if (scenario.event === 'push' && scenario.refType === 'tag') return [];
  if (scenario.changed === undefined) {
    const fragment = { changed: [filter.patterns[0] ?? ''] };
    return [unknownGate('changed-files', 'changed', fragment, (m) => unknownFilterReason(filter, m))];
  }
  const files = scenario.changed.map((c) => c.path);
  const matched = pathsMatch(
    files,
    filter.kind === 'paths' ? { paths: filter.patterns } : { pathsIgnore: filter.patterns },
  );
  const reason: Reason = {
    kind: 'filter',
    filter: filter.kind,
    patterns: filter.patterns,
    subject: known(files),
    matched: known(matched),
  };
  return [{ reason, matched: known(matched) }];
}

/** Skip markers in the head commit message, for `push` and `pull_request` only. No message given: no marker. */
function skipGate(scenario: Scenario): Gate[] {
  if (!SKIP_EVENTS.has(scenario.event) || scenario.message === undefined) return [];
  const marker = skipMarker(scenario.message);
  return marker === undefined ? [] : [{ reason: { kind: 'skip-ci', marker }, matched: known(false) }];
}

function stringList(config: EventConfig, key: string): string[] | undefined {
  const value = config[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

function patternList(
  config: EventConfig,
  includeKey: FilterKind,
  ignoreKey: FilterKind,
): PatternList | undefined {
  const include = stringList(config, includeKey);
  if (include) return { kind: includeKey, patterns: include, include };
  const ignore = stringList(config, ignoreKey);
  return ignore ? { kind: ignoreKey, patterns: ignore, ignore } : undefined;
}

function filterReason(filter: PatternList, subject: string, matched: boolean): Reason {
  return {
    kind: 'filter',
    filter: filter.kind,
    patterns: filter.patterns,
    subject: known(subject),
    matched: known(matched),
  };
}

function unknownFilterReason(filter: PatternList, m: UnknownBoolean): Reason {
  return { kind: 'filter', filter: filter.kind, patterns: filter.patterns, subject: m, matched: m };
}

/** A gate the scenario leaves undecided, with the field that would decide it as the pin. */
function unknownGate(
  kind: UnknownKind,
  field: string,
  fragment: Record<string, unknown>,
  reason: (matched: UnknownBoolean) => Reason,
): Gate {
  const unknown: Unknown = {
    id: `scenario.${field}`,
    kind,
    reads: [],
    affects: [],
    pin: { layer: 'scenario', fragment: fragment as Json, at: ['when'] },
  };
  const matched: UnknownBoolean = { known: false, unknowns: [unknown.id] };
  return { reason: reason(matched), matched, unknown };
}

const known = <T>(value: T): Value<T> => ({ known: true, value });

function verdictOf(gates: Value<boolean>[]): Tri {
  if (gates.some((g) => g.known && !g.value)) return 'no';
  return gates.some((g) => !g.known) ? 'maybe' : 'yes';
}
