import { ACTIVITY_TYPES, type LoadedProject, readSettings } from '@simulci/engine';
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { Outline, OutlineEvent, OutlineFile, OutlineJob, OutlineWorkflow } from './protocol';

/** The Outline of a loaded project: what the form, the tree and the pane need to know, from core's declarations. */
export function outlineOf(loaded: LoadedProject): Outline {
  const { project } = loaded.index;
  const actionFiles = new Set([...project.actions.values()].map((a) => a.file));
  const files: OutlineFile[] = Object.keys(loaded.files)
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const decl = project.workflows.get(path) ?? [...project.actions.values()].find((a) => a.file === path);
      const kind = project.workflows.has(path) ? 'workflow' : actionFiles.has(path) ? 'action' : 'other';
      const errors = (decl?.parseErrors ?? []).map((e) => ({
        line: e.loc.line,
        column: e.loc.column,
        message: e.message,
      }));
      return { path, kind, errors };
    });
  const workflows: OutlineWorkflow[] = [...project.workflows.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((wf) => {
      const text = loaded.files[wf.path] ?? '';
      const settings = loaded.settings.get(wf.path) ?? readSettings(wf.path, text);
      loaded.settings.set(wf.path, settings);
      const lines = onLines(text);
      const out: OutlineWorkflow = {
        path: wf.path,
        callable: wf.call !== undefined,
        events: Object.entries(settings.events as Record<string, unknown>)
          .filter(([event]) => event !== 'workflow_call')
          .map(([event, config]) => eventOf(event, config, lines.events[event])),
        jobs: Object.values(wf.jobs).map(jobOf),
        onLine: lines.on,
      };
      if (wf.name !== undefined) out.name = wf.name;
      if (wf.generated !== undefined) out.generated = wf.generated;
      if (wf.dispatch) {
        out.dispatch = Object.values(wf.dispatch.inputs).map((i) => {
          const input: NonNullable<OutlineWorkflow['dispatch']>[number] = {
            name: i.name,
            required: i.required,
          };
          if (i.type !== undefined) input.type = i.type;
          if (i.default !== undefined) input.default = i.default;
          if (i.options) input.options = i.options;
          if (i.description !== undefined) input.description = i.description;
          return input;
        });
      }
      return out;
    });
  const events: Outline['events'] = {};
  for (const wf of workflows)
    for (const e of wf.events) if (ACTIVITY_TYPES[e.event]) events[e.event] = ACTIVITY_TYPES[e.event]!;
  return { files, workflows, events };
}

const FILTERS: [keyof OutlineEvent, string][] = [
  ['branches', 'branches'],
  ['branchesIgnore', 'branches-ignore'],
  ['tags', 'tags'],
  ['tagsIgnore', 'tags-ignore'],
  ['paths', 'paths'],
  ['pathsIgnore', 'paths-ignore'],
  ['workflows', 'workflows'],
];

function eventOf(
  event: string,
  config: unknown,
  loc: { line: number; filters: Record<string, number> } | undefined,
): OutlineEvent {
  const out: OutlineEvent = { event };
  if (loc) out.loc = loc;
  if (Array.isArray(config)) {
    // `schedule:` is the list of crons.
    const crons = cronsOf(config);
    if (crons.length) out.crons = crons;
    return out;
  }
  if (typeof config !== 'object' || config === null) return out;
  const record = config as Record<string, unknown>;
  const types = typesOf(event, record);
  if (types) out.types = types;
  for (const [field, key] of FILTERS) {
    const list = strings(record[key]);
    if (list) (out as unknown as Record<string, unknown>)[field] = list;
  }
  return out;
}

function cronsOf(list: unknown[]): string[] {
  return list
    .map((c) => (typeof c === 'string' ? c : strings((c as Record<string, unknown>)?.cron)?.[0]))
    .filter((c): c is string => !!c);
}

/** The activity types the author allowed against every type the event has; absent for events without types. */
function typesOf(event: string, record: Record<string, unknown>): OutlineEvent['types'] | undefined {
  const all = ACTIVITY_TYPES[event]?.types ?? [];
  const allowed = strings(record.types);
  if (!all.length && !allowed) return undefined;
  return {
    allowed: allowed ?? ACTIVITY_TYPES[event]?.default ?? [],
    all,
    narrowed: allowed !== undefined,
  };
}

function strings(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;
  return undefined;
}

function jobOf(
  job: LoadedProject['index']['project']['workflows'] extends Map<string, infer W>
    ? W extends { jobs: Record<string, infer J> }
      ? J
      : never
    : never,
): OutlineJob {
  const out: OutlineJob = {
    id: job.id,
    needs: job.needs.map((n) => n.id),
    matrix: job.matrix !== undefined,
    steps: job.steps.map((s) => {
      const step: OutlineJob['steps'][number] = { index: s.index, line: s.loc.line };
      if (s.id !== undefined) step.id = s.id;
      if (s.name !== undefined) step.name = s.name;
      if (s.uses) step.uses = s.uses.raw;
      return step;
    }),
    line: job.loc.line,
  };
  if (job.name !== undefined) out.name = job.name;
  if (job.uses) out.uses = job.uses.raw;
  return out;
}

/** The lines of `on:`, of each event key under it and of each filter key, which the plan's trigger reasons lack. */
type EventLines = Record<string, { line: number; filters: Record<string, number> }>;

function onLines(text: string): { on: number; events: EventLines } {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  const line = (offset: number | undefined) => (offset === undefined ? 1 : counter.linePos(offset).line);
  if (!isMap(doc.contents)) return { on: 1, events: {} };
  const onPair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'on');
  if (!onPair || !isScalar(onPair.key)) return { on: 1, events: {} };
  const on = line(onPair.key.range?.[0]);
  return { on, events: eventLines(onPair.value, on, line) };
}

type LineOf = (offset: number | undefined) => number;

/** `on: push` names one event on the `on` line; `on: [a, b]` one per item; a map has one per key, with filters. */
function eventLines(value: unknown, on: number, line: LineOf): EventLines {
  if (isScalar(value) && typeof value.value === 'string') return { [value.value]: { line: on, filters: {} } };
  if (isSeq(value)) return seqLines(value.items, line);
  return isMap(value) ? mapLines(value.items, line) : {};
}

function seqLines(items: unknown[], line: LineOf): EventLines {
  const out: EventLines = {};
  for (const item of items)
    if (isScalar(item)) out[String(item.value)] = { line: line(item.range?.[0]), filters: {} };
  return out;
}

function mapLines(items: { key: unknown; value: unknown }[], line: LineOf): EventLines {
  const out: EventLines = {};
  for (const pair of items) {
    if (!isScalar(pair.key)) continue;
    out[String(pair.key.value)] = { line: line(pair.key.range?.[0]), filters: keyLines(pair.value, line) };
  }
  return out;
}

function keyLines(value: unknown, line: LineOf): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isMap(value)) return out;
  for (const f of value.items) if (isScalar(f.key)) out[String(f.key.value)] = line(f.key.range?.[0]);
  return out;
}
