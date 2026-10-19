import type { Diagnostic, Loc, NodeId, RunPlan } from '@simulci/engine';
import { declaredAt, type PlanNode, planNodes } from '../plan/nodes';
import type { Outline, OutlineFile, OutlineWorkflow } from '../worker/protocol';

/**
 * The Problems tab as rows (synthesis § 10): a file that could not be read (`outline.files[].errors`, one row per
 * error with its line and column), a workflow file that is no workflow (no `on:` and no `jobs:`), and the plan's
 * diagnostics that are not an assumption's (those show on the entry in the Unknowns tab). Errors first, then
 * warnings, then info; within a severity by file and line.
 */

export interface ProblemRow {
  severity: Diagnostic['severity'];
  /** `parse` for a file that could not be read, `workflow` for one that is no workflow, else the diagnostic's code. */
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  /** The node the diagnostic is about, which a click selects. */
  node?: NodeId;
}

/**
 * The rows of the project and the plan. A `parse` diagnostic about a file whose outline already lists errors is left
 * out: the outline has the same error with its line and column. A diagnostic without a `loc` takes the line its node
 * is declared on.
 */
export function problemRows(outline: Outline | undefined, plan: RunPlan | undefined): ProblemRow[] {
  const files = outline?.files ?? [];
  const unread = new Set(files.filter((f) => f.errors.length > 0).map((f) => f.path));
  const rows = [
    ...files.flatMap(fileRows),
    ...(outline?.workflows ?? []).filter(isNoWorkflow).map(noWorkflowRow),
    ...(plan ? diagnosticRows(plan, unread) : []),
  ];
  return rows.sort(byPlace);
}

function fileRows(file: OutlineFile): ProblemRow[] {
  return file.errors.map((e) => ({
    severity: 'error',
    code: 'parse',
    message: e.message,
    file: file.path,
    line: e.line,
    column: e.column,
  }));
}

/** No event under `on:` (`workflow_call` is counted by `callable`) and no job: a YAML file that only sits there. */
function isNoWorkflow(wf: OutlineWorkflow): boolean {
  return !wf.callable && wf.events.length === 0 && wf.jobs.length === 0;
}

function noWorkflowRow(wf: OutlineWorkflow): ProblemRow {
  return {
    severity: 'warning',
    code: 'workflow',
    message: `${basename(wf.path)} is not a workflow (no on: and no jobs:)`,
    file: wf.path,
    line: 1,
  };
}

function diagnosticRows(plan: RunPlan, unread: ReadonlySet<string>): ProblemRow[] {
  const nodes = planNodes(plan);
  return plan.diagnostics
    .filter((d) => d.mock === undefined)
    .map((d) => diagnosticRow(d, nodes))
    .filter((row) => !(row.code === 'parse' && row.file !== undefined && unread.has(row.file)));
}

function diagnosticRow(d: Diagnostic, nodes: Map<NodeId, PlanNode>): ProblemRow {
  const row: ProblemRow = { severity: d.severity, code: d.code, message: d.message };
  const at = d.loc ?? nodeLoc(d.node, nodes);
  if (at) Object.assign(row, { file: at.file, line: at.line, column: at.column });
  if (d.node !== undefined) row.node = d.node;
  return row;
}

function nodeLoc(node: NodeId | undefined, nodes: Map<NodeId, PlanNode>): Loc | undefined {
  const found = node === undefined ? undefined : nodes.get(node);
  return found ? declaredAt(found) : undefined;
}

const SEVERITY_RANK: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

/** Severity, then file (rows about no file last), then line and column. */
function byPlace(a: ProblemRow, b: ProblemRow): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    compareFiles(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0)
  );
}

function compareFiles(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a.localeCompare(b);
}

/** Where a row points, as its link reads: `ci.yml:4:3`, `notes.yml:1`; undefined without a file and a line. */
export function placeOf(row: ProblemRow): string | undefined {
  if (row.file === undefined || row.line === undefined) return undefined;
  const at = `${basename(row.file)}:${row.line}`;
  return row.column === undefined ? at : `${at}:${row.column}`;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
