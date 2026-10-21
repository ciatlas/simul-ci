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

export type FilterKey = 'branches' | 'branches-ignore' | 'tags' | 'tags-ignore' | 'paths' | 'paths-ignore';

/** A `workflow_dispatch` input, its keys in the order they are written. */
export interface DispatchInput {
  description?: string;
  required?: boolean;
  default?: Json;
  type?: 'string' | 'boolean' | 'choice' | 'number' | 'environment';
  options?: string[];
}

/** The engine's `GeneratedCase` as plain JSON: the document imports nothing of the engine. */
export interface CaseJson {
  name: string;
  when: Record<string, Json>;
  allowMaybe?: boolean;
  then: Record<string, Json>;
  /** The maybe comments (`<unit>: maybe — <unknown> → pin: …`), written as the case's leading comment lines. */
  comments: string[];
}

/**
 * Where the worker found a job's or a step's id (the engine's `Reference`, from `referencesOf`), defined here by its
 * shape because the document imports nothing of the engine. 1-based like core's `Loc`; the span holds the id alone.
 */
export interface Reference {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** The id as written there, which may differ in case from the declared one. */
  text: string;
  role: 'key' | 'needs' | 'read';
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
 * An edit in the author's terms (§ 3.1): the workflow, job, step, matrix, trigger, test-file and rename ops, with the
 * ops the refusals' fixes run (`FixOp`).
 */
export type WorkflowOp =
  // workflow, jobs and steps
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
  /** A step's action pinned to a commit: `uses: <action>@<sha> # <tag>`, the line's comment set or replaced. */
  | { op: 'pinStepUses'; file: string; job: string; index: number; fp: Fp; sha: string; tag: string }
  // matrix and strategy
  | { op: 'setMatrixDim'; file: string; job: string; dim: string; values: Json[] | null }
  | {
      op: 'setMatrixEntry';
      file: string;
      job: string;
      list: 'include' | 'exclude';
      index: number | 'append';
      entry: Record<string, Json> | null;
    }
  | {
      op: 'setStrategyField';
      file: string;
      job: string;
      field: 'fail-fast' | 'max-parallel';
      value: boolean | number | string | null;
    }
  // triggers
  | { op: 'addEvent'; file: string; event: string }
  | { op: 'removeEvent'; file: string; event: string }
  | { op: 'setFilter'; file: string; event: string; filter: FilterKey; patterns: string[] | null }
  | { op: 'setTypes'; file: string; event: string; types: string[] | null }
  | { op: 'setSchedule'; file: string; crons: { cron: string; timezone?: string }[] }
  | { op: 'setDispatchInput'; file: string; name: string; input: DispatchInput | null }
  | { op: 'switchFilter'; file: string; event: string; from: FilterKey; to: FilterKey }
  // test files
  | { op: 'addCase'; file: string; workflow: string; testCase: CaseJson }
  | { op: 'createFile'; file: string; text: string }
  // renames, with the references the worker found in `OpContext.refs`
  | { op: 'renameJob'; file: string; job: string; to: string }
  | { op: 'renameStepId'; file: string; job: string; index: number; fp: Fp; to: string }
  | FixOp;

/**
 * The ops a refusal's fixes run that keep the file's value: the copies that take an anchor or an alias out of an
 * edit's way, and the line-ending conversion. Each is also an op of its own (`switchFilter`, a fix too, changes the
 * value and is a trigger op).
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
  /** Where the worker found the id a rename changes, for the text the op was planned against. */
  refs?: readonly Reference[];
}
