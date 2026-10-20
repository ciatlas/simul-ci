/**
 * `@simulci/document`: a workflow file's text, read through a YAML parse and edited by splices that keep every byte
 * an edit does not touch. The page holds only `@simulci/document/edits`; this entry brings in the YAML parser.
 */
export { WorkflowDocument, PARSE_OPTIONS, unitPathAt, yamlPathOf } from './document';
export type { OpenOptions, Status, YamlProblem } from './document';
export type { AnchorDef, AnchorIndex, AliasUse, MergeKey } from './anchors';
export type { TextEdit } from './edits';
export type { JobInfo, NodeInfo, StepInfo } from './paths';
export type { Fix, Refusal, RefusalReason } from './refusal';
export type { ListFamily, Style } from './style';
export type { Eol, FileKind, Json, Span, YamlPath } from './types';
