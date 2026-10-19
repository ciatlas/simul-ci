import type { JobPlan, LegPlan, NodeId, RunPlan, StepPlan, Tri, WorkflowPlan } from '@simulci/engine';
import { declaredAt, decisionOf, planNodes } from '../plan/nodes';
import type { Derived, Outline, OutlineFile } from '../worker/protocol';

/**
 * Where the plan meets the text of a file: the verdict marks of its lines, the line that decided the selection, the
 * lines that could not be read, the pane's tabs and the file it shows. The pane (YamlPane.tsx) draws them through
 * the decorations of extensions.ts.
 */

/** A verdict mark in the gutter: the node declared on the line. */
export interface LineMark {
  line: number;
  node: NodeId;
  verdict: Tri;
  kind: 'workflow' | 'job' | 'step';
}

/** A walk over the plan for one file: the marks claimed so far, by line. */
interface MarkWalk {
  file: string;
  representative: Readonly<Record<NodeId, NodeId>>;
  marks: Map<number, LineMark>;
}

/**
 * The marks of a file, by line: the `on:` line of each depth-0 workflow declared in it (its trigger verdict), every
 * job declared in it, and every step declared in it as the job's representative leg runs it (`representative[job]`,
 * else the first leg). A called workflow's jobs come from the representative leg that calls it, a composite action's
 * steps from the first step that uses it. The first node to claim a line keeps it.
 */
export function gutterMarks(
  plan: RunPlan,
  outline: Outline | undefined,
  file: string,
  representative: Readonly<Record<NodeId, NodeId>>,
): LineMark[] {
  const w: MarkWalk = { file, representative, marks: new Map() };
  const onLine = outline?.workflows.find((o) => o.path === file)?.onLine;
  const roots = plan.workflows.filter((wf) => wf.depth === 0);
  for (const wf of roots)
    if (wf.path === file && onLine !== undefined) claim(w, onLine, wf.id, wf.triggered.verdict, 'workflow');
  for (const wf of roots) markWorkflow(w, wf);
  return [...w.marks.values()].sort((a, b) => a.line - b.line);
}

function claim(w: MarkWalk, line: number, node: NodeId, verdict: Tri, kind: LineMark['kind']): void {
  if (!w.marks.has(line)) w.marks.set(line, { line, node, verdict, kind });
}

function markWorkflow(w: MarkWalk, wf: WorkflowPlan): void {
  for (const job of wf.jobs) {
    if (job.loc?.file === w.file) claim(w, job.loc.line, job.id, job.runs.verdict, 'job');
    const leg = representativeLeg(job, w.representative);
    if (leg?.call) markWorkflow(w, leg.call);
    for (const step of leg?.steps ?? []) markStep(w, step);
  }
}

function markStep(w: MarkWalk, step: StepPlan): void {
  if (step.loc?.file === w.file) claim(w, step.loc.line, step.id, step.runs.verdict, 'step');
  for (const inner of step.composite?.steps ?? []) markStep(w, inner);
}

/** The leg a job's card shows: the one the author picked while the plan still has it, else the first. */
export function representativeLeg(
  job: JobPlan,
  representative: Readonly<Record<NodeId, NodeId>>,
): LegPlan | undefined {
  const picked = representative[job.id];
  return job.legs.find((leg) => leg.id === picked) ?? job.legs[0];
}

/** The node each marked line selects. */
export function lineNodes(marks: readonly LineMark[]): Map<number, NodeId> {
  return new Map(marks.map((m) => [m.line, m.node]));
}

/** The selection's lines in one file, toned by its verdict. */
export interface DecidingLines {
  /** The line the deciding reason is written on (`derived.decidingLoc`), when it is in the file. */
  line?: number;
  tone: Tri;
  /** The line the node is declared on, when it is in the file and is not the deciding line. */
  own?: number;
}

/**
 * The line that decided a node and the node's own line, as far as the file holds them; undefined when it holds
 * neither. A workflow's own line is its whole file, so a workflow has none.
 */
export function decidingLines(
  plan: RunPlan,
  derived: Derived,
  node: NodeId | undefined,
  file: string,
): DecidingLines | undefined {
  const n = node === undefined ? undefined : planNodes(plan).get(node);
  if (node === undefined || !n) return undefined;
  const at = derived.decidingLoc[node];
  const line = at?.file === file ? at.line : undefined;
  const declared = n.kind === 'workflow' ? undefined : declaredAt(n);
  const own = declared?.file === file && declared.line !== line ? declared.line : undefined;
  if (line === undefined && own === undefined) return undefined;
  const lines: DecidingLines = { tone: decisionOf(n).verdict };
  if (line !== undefined) lines.line = line;
  if (own !== undefined) lines.own = own;
  return lines;
}

/** A line the parser refused, with every message about it. */
export interface ProblemLine {
  line: number;
  message: string;
}

/** The lines of a file the parsers refused (`outline.files[].errors`), in order, one per line. */
export function problemLines(outline: Outline | undefined, file: string): ProblemLine[] {
  const byLine = new Map<number, string[]>();
  for (const e of outline?.files.find((f) => f.path === file)?.errors ?? []) {
    const messages = byLine.get(e.line);
    if (messages) messages.push(e.message);
    else byLine.set(e.line, [e.message]);
  }
  return [...byLine]
    .sort(([a], [b]) => a - b)
    .map(([line, messages]) => ({ line, message: messages.join('\n') }));
}

/** A tab of the pane: a loaded file. */
export interface FileTab {
  path: string;
  kind: OutlineFile['kind'];
  /** The shortest end of the path no other loaded file shares: `ci.yml`, `setup/action.yml`. */
  label: string;
  /** The errors the parsers found in it. */
  problems: number;
}

const KIND_ORDER: Record<OutlineFile['kind'], number> = { workflow: 0, action: 1, other: 2 };

/**
 * Every loaded file as a tab: workflows, then actions, then the rest, each by path. The outline says what a file is;
 * until it arrives, the path does.
 */
export function fileTabs(outline: Outline | undefined, byPath: Readonly<Record<string, string>>): FileTab[] {
  const known = new Map(outline?.files.map((f) => [f.path, f]));
  const paths = Object.keys(byPath);
  const labels = shortLabels(paths);
  return paths
    .map((path) => {
      const file = known.get(path);
      return {
        path,
        kind: file?.kind ?? kindOfPath(path),
        label: labels.get(path) ?? path,
        problems: file?.errors.length ?? 0,
      };
    })
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.path.localeCompare(b.path));
}

function kindOfPath(path: string): OutlineFile['kind'] {
  if (path.startsWith('.github/workflows/')) return 'workflow';
  return /(?:^|\/)action\.ya?ml$/.test(path) ? 'action' : 'other';
}

/** Each path by its last parts, as few as tell it from every other path. */
function shortLabels(paths: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const label = parts.slice(-n).join('/');
      const shared = paths.some(
        (other) => other !== path && (other === label || other.endsWith(`/${label}`)),
      );
      if (!shared || n === parts.length) {
        labels.set(path, label);
        break;
      }
    }
  }
  return labels;
}

/** What decides the file the pane shows. */
export interface ShownFileInput {
  tabs: readonly FileTab[];
  /** The tab the author picked (`ui.yamlFile`). */
  picked?: string | undefined;
  plan?: { plan: RunPlan; derived: Derived } | undefined;
  /** The selected node. */
  node?: NodeId | undefined;
  /** The focused workflow. */
  focus?: string | undefined;
}

/**
 * The file the pane shows: the author's pick while it is loaded, else the file that decided the selection, else the
 * one the selection is declared in, else the focused workflow, else the first tab.
 */
export function shownFile({ tabs, picked, plan, node, focus }: ShownFileInput): string | undefined {
  const loaded = new Set(tabs.map((t) => t.path));
  const candidates = [picked, ...selectionFiles(plan, node), focus, tabs[0]?.path];
  return candidates.find((path) => path !== undefined && loaded.has(path));
}

function selectionFiles(plan: ShownFileInput['plan'], node: NodeId | undefined): (string | undefined)[] {
  const n = plan && node !== undefined ? planNodes(plan.plan).get(node) : undefined;
  if (!plan || node === undefined || !n) return [];
  return [plan.derived.decidingLoc[node]?.file, declaredAt(n)?.file];
}
