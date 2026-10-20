import { describe, fileName } from '../refusal';
import type { WorkflowOp } from './types';

/** What an op does, in the author's words: the undo history's entry. */
export function labelOf(op: WorkflowOp): string {
  return (LABELS[op.op] as (op: WorkflowOp) => string)(op);
}

type Of<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

const setOr = (value: unknown): string => (value === null ? 'Remove' : 'Set');

const LABELS: { [K in WorkflowOp['op']]: (op: Of<K>) => string } = {
  setWorkflowField: (op) => `${setOr(op.value)} the workflow's ${op.field}`,
  addJob: (op) => `Add job ${op.id}`,
  removeJob: (op) => `Remove job ${op.job}`,
  setJobField: (op) => `${setOr(op.value)} ${op.job}'s ${op.field}`,
  setNeeds: (op) => `Set what ${op.job} needs`,
  setOutput: (op) => `${setOr(op.value)} ${op.job}'s output ${op.name}`,
  setBinding: (op) => `${setOr(op.value)} ${op.kind}.${op.name} of ${owner(op.job, op.step?.index)}`,
  addStep: (op) => `Add a step to ${op.job}`,
  removeStep: (op) => `Remove ${owner(op.job, op.index)}`,
  moveStep: (op) => `Move ${owner(op.job, op.from)}`,
  setStepField: (op) => `${setOr(op.value)} ${op.field} of ${owner(op.job, op.index)}`,
  setMatrixDim: (op) => `${setOr(op.values)} ${op.job}'s matrix ${op.dim}`,
  setMatrixEntry: (op) =>
    op.index === 'append'
      ? `Add an ${op.list} entry to ${op.job}'s matrix`
      : `${setOr(op.entry)} ${op.list} entry ${op.index + 1} of ${op.job}'s matrix`,
  setStrategyField: (op) => `${setOr(op.value)} ${op.job}'s ${op.field}`,
  addEvent: (op) => `Add the ${op.event} trigger`,
  removeEvent: (op) => `Remove the ${op.event} trigger`,
  setFilter: (op) => `${setOr(op.patterns)} ${op.event}'s ${op.filter}`,
  setTypes: (op) => `${setOr(op.types)} ${op.event}'s types`,
  setSchedule: (op) => (op.crons.length === 0 ? 'Remove the schedule' : 'Set the schedule'),
  setDispatchInput: (op) => `${setOr(op.input)} the input ${op.name}`,
  switchFilter: (op) => `Switch ${op.event} to ${op.to}`,
  addCase: (op) => `Add a case to ${fileName(op.file)}`,
  createFile: (op) => `Create ${fileName(op.file)}`,
  renameJob: (op) => `Rename job ${op.job} to ${op.to}`,
  renameStepId: (op) => `Rename the id of ${owner(op.job, op.index)} to ${op.to}`,
  dealias: (op) => `Copy into ${describe(op.path)}`,
  dealiasAnchor: (op) => `Copy \`&${op.anchor}\` into its uses`,
  convertEol: (op) => `Convert line endings to ${op.eol === '\r\n' ? 'CRLF' : 'LF'}`,
};

const owner = (job: string, index: number | undefined): string =>
  index === undefined ? job : describe(['jobs', job, 'steps', index]);
