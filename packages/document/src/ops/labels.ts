import { describe } from '../refusal';
import type { WorkflowOp } from './types';

/** What an op does, in the author's words: the undo history's entry. */
export function labelOf(op: WorkflowOp): string {
  switch (op.op) {
    case 'setWorkflowField':
      return `${op.value === null ? 'Remove' : 'Set'} the workflow's ${op.field}`;
    case 'addJob':
      return `Add job ${op.id}`;
    case 'removeJob':
      return `Remove job ${op.job}`;
    case 'setJobField':
      return `${op.value === null ? 'Remove' : 'Set'} ${op.job}'s ${op.field}`;
    case 'setNeeds':
      return `Set what ${op.job} needs`;
    case 'setOutput':
      return `${op.value === null ? 'Remove' : 'Set'} ${op.job}'s output ${op.name}`;
    case 'setBinding':
      return `${op.value === null ? 'Remove' : 'Set'} ${op.kind}.${op.name} of ${owner(op.job, op.step?.index)}`;
    default:
      return stepLabel(op);
  }
}

function stepLabel(op: WorkflowOp): string {
  const label = STEP_LABELS[op.op as keyof typeof STEP_LABELS] as ((op: WorkflowOp) => string) | undefined;
  return label
    ? label(op)
    : `Convert line endings to ${op.op === 'convertEol' && op.eol === '\r\n' ? 'CRLF' : 'LF'}`;
}

type Of<K extends WorkflowOp['op']> = Extract<WorkflowOp, { op: K }>;

const STEP_LABELS = {
  addStep: (op: Of<'addStep'>) => `Add a step to ${op.job}`,
  removeStep: (op: Of<'removeStep'>) => `Remove ${owner(op.job, op.index)}`,
  moveStep: (op: Of<'moveStep'>) => `Move ${owner(op.job, op.from)}`,
  setStepField: (op: Of<'setStepField'>) =>
    `${op.value === null ? 'Remove' : 'Set'} ${op.field} of ${owner(op.job, op.index)}`,
  dealias: (op: Of<'dealias'>) => `Copy into ${describe(op.path)}`,
  dealiasAnchor: (op: Of<'dealiasAnchor'>) => `Copy \`&${op.anchor}\` into its uses`,
};

const owner = (job: string, index: number | undefined): string =>
  index === undefined ? job : describe(['jobs', job, 'steps', index]);
