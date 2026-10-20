import type { WorkflowDocument } from '../document';
import type { Eol, Json, YamlPath } from '../types';

/**
 * What the author saw when picking a step, read from the document when the gesture starts (`doc.jobs()[].steps[]`):
 * a step op checks it against the text before writing, and refuses with `moved` when the step there is another.
 */
export interface Fp {
  id?: string;
  name?: string;
  uses?: string;
  runHead?: string;
  /** A digest of the step's whole value (`fingerprint`), which tells apart steps that look the same. */
  digest?: string;
}

export type JobField =
  | 'name'
  | 'runs-on'
  | 'if'
  | 'environment'
  | 'continue-on-error'
  | 'timeout-minutes'
  | 'uses';
export type StepField =
  | 'name'
  | 'if'
  | 'uses'
  | 'run'
  | 'shell'
  | 'working-directory'
  | 'continue-on-error'
  | 'timeout-minutes';

export interface NewJob {
  name?: string;
  'runs-on'?: Json;
  needs?: string[];
  if?: string;
  uses?: string;
  with?: Record<string, Json>;
  steps?: NewStep[];
}

export interface NewStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, Json>;
  env?: Record<string, Json>;
}

/**
 * An edit in the author's terms (§ 3.1). The workflow, job and step ops are here, with the ops the refusals' fixes run
 * (`FixOp`: `dealias`, `dealiasAnchor`, `convertEol`); the trigger, matrix, test-case and rename ops follow.
 */
export type WorkflowOp =
  | { op: 'setWorkflowField'; file: string; field: 'name' | 'run-name'; value: string | null }
  | { op: 'addJob'; file: string; id: string; after?: string; job: NewJob }
  | { op: 'removeJob'; file: string; job: string }
  | { op: 'setJobField'; file: string; job: string; field: JobField; value: Json | null }
  | { op: 'setNeeds'; file: string; job: string; needs: string[] }
  | { op: 'setOutput'; file: string; job: string; name: string; value: string | null }
  | {
      op: 'setBinding';
      file: string;
      job: string;
      step?: { index: number; fp: Fp };
      kind: 'with' | 'env' | 'secrets';
      name: string;
      value: Json | null;
    }
  | { op: 'addStep'; file: string; job: string; index: number; step: NewStep }
  | { op: 'removeStep'; file: string; job: string; index: number; fp: Fp }
  | { op: 'moveStep'; file: string; job: string; from: number; to: number; fp: Fp }
  | {
      op: 'setStepField';
      file: string;
      job: string;
      index: number;
      fp: Fp;
      field: StepField;
      value: Json | null;
    }
  | FixOp;

/**
 * The ops a refusal's fixes run: the copies that take an anchor or an alias out of an edit's way, and the line-ending
 * conversion. Each is also an op of its own.
 */
export type FixOp =
  | { op: 'dealias'; file: string; path: YamlPath }
  | { op: 'dealiasAnchor'; file: string; anchor: string; line?: number }
  | { op: 'convertEol'; file: string; eol: Eol };

/** Every open file, and how far an op may reach. */
export interface OpContext {
  /** The document of a path, parsed at the revision the op is for. */
  doc(path: string): WorkflowDocument | undefined;
  /** "Change all N uses" of a shared anchor. */
  shared?: 'all';
}
