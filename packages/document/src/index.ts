/**
 * `@simulci/document`: a workflow file's text, read through a YAML parse and edited by splices that keep every byte
 * an edit does not touch. The page holds only `@simulci/document/edits`; this entry brings in the YAML parser.
 */
export { WorkflowDocument, PARSE_OPTIONS, unitPathAt, yamlPathOf } from './document';
export type { OpenOptions, Status, YamlProblem } from './document';
export type { AnchorDef, AnchorIndex, AliasUse, MergeKey } from './anchors';
export type { TextEdit } from './edits';
export type { InsertOptions } from './insert';
export type { JobInfo, NodeInfo, StepInfo } from './paths';
export { freeId, ID, sameId, stepIdFor } from './ops/ids';
export { ORDER, orderFor } from './ops/order';
export { planOp } from './ops/plan';
export { fingerprint } from './ops/steps';
export { caseFileText } from './ops/cases';
export type {
  CaseJson,
  DispatchInput,
  FilterKey,
  FixOp,
  Fp,
  JobField,
  NewJob,
  NewStep,
  OpContext,
  Reference,
  StepField,
  WorkflowOp,
} from './ops/types';
export {
  convertEol,
  dealias,
  dealiasAnchor,
  insert,
  move,
  remove,
  renameKey,
  replaceAt,
  set,
} from './primitives';
export type { Fix, Refusal, RefusalReason } from './refusal';
export type { OrderOf, ScalarKind, SetOptions } from './set';
export type { ListFamily, Style } from './style';
export type { Eol, FileKind, Json, Span, YamlPath } from './types';
export type { EditPlan, Rename, Warning } from './verify';
