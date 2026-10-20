import type { WorkflowDocument } from './document';
import { applyEdits, type TextEdit } from './edits';
import { internal, type Refusal } from './refusal';
import { toJson } from './tree';
import type { Eol, Span, YamlPath } from './types';

/** Something the author should know about an edit; it never blocks one. */
export interface Warning {
  code: 'dangling-ref' | 'required-input' | 'unknown-input' | 'matrix-limit' | 'callers' | 'tests-name';
  message: string;
  at?: Span[];
}

export interface Rename {
  kind: 'job' | 'step';
  file: string;
  job: string;
  from: string;
  to: string;
}

/** An edit, checked and ready to commit, or why it cannot be made. Planning never throws for the author's input. */
export type EditPlan<T> =
  | {
      ok: true;
      label: string;
      value: T;
      created?: string[];
      select?: { file: string; path: YamlPath };
      renames?: Rename[];
      warnings: Warning[];
      /** The documents after the edit, parsed once by the check, for the caller's cache. */
      documents: Record<string, WorkflowDocument>;
    }
  | Refusal;

/** An edit planned against one document and not yet checked. */
export interface Draft {
  /** Splices of the document's text, sorted and not overlapping. */
  edits: TextEdit[];
  /** What the edit means: the document's plain-JSON value before → after. Absent where only the text is known. */
  expect?: (js: unknown) => unknown;
  label: string;
  select?: YamlPath;
  warnings?: Warning[];
  /** The line ending the edit writes when it is not the file's (`convertEol`). */
  eol?: Eol;
}

/** Drafts against one document as one: their splices together, their meanings one after the other. */
export function combine(label: string, drafts: readonly Draft[]): Draft {
  const edits = drafts.flatMap((d) => d.edits).sort((a, b) => a.from - b.from || a.to - b.to);
  const expects = drafts.map((d) => d.expect);
  const draft: Draft = { edits, label, warnings: drafts.flatMap((d) => d.warnings ?? []) };
  if (expects.every((e) => e !== undefined)) draft.expect = (js) => expects.reduce((v, e) => e(v), js);
  const select = drafts.find((d) => d.select)?.select;
  if (select) draft.select = select;
  return draft;
}

/**
 * The guard on every edit (G6): the text after it parses with core's options, with no error and no warning it did
 * not have; its value is what the edit means and nothing else changed (G4); a CRLF file gains no bare LF and the byte
 * order mark stays. Any failure refuses with `internal`, so a broken edit is never offered.
 */
export function verify(doc: WorkflowDocument, draft: Draft): EditPlan<TextEdit[]> {
  const fail = (why: string) =>
    internal(
      doc.path,
      firstLine(doc, draft.edits),
      JSON.stringify({ file: doc.path, label: draft.label, why, edits: draft.edits }),
    );
  const sorted = [...draft.edits].sort((a, b) => a.from - b.from || a.to - b.to);
  try {
    applyEdits(doc.text, sorted);
  } catch (error) {
    return fail(String(error));
  }
  const next = doc.apply(sorted);
  const problem =
    textProblem(doc, next, sorted, draft.eol ?? doc.style.eol) ??
    aliasProblem(doc, next, draft) ??
    meaningProblem(doc, next, draft);
  if (problem) return fail(problem);
  const plan: EditPlan<TextEdit[]> = {
    ok: true,
    label: draft.label,
    value: sorted,
    warnings: draft.warnings ?? [],
    documents: { [doc.path]: next },
  };
  if (draft.select) plan.select = { file: doc.path, path: draft.select };
  return plan;
}

function textProblem(
  doc: WorkflowDocument,
  next: WorkflowDocument,
  edits: readonly TextEdit[],
  eol: Eol,
): string | undefined {
  if (!next.tree.doc) return 'the result was not parsed';
  if (next.errors.length > 0)
    return `the result does not parse: ${next.errors[0]!.code} ${next.errors[0]!.message}`;
  const added = newWarning(doc, next);
  if (added) return `the result has a new warning: ${added}`;
  if (eol === '\r\n' && edits.some((e) => /(?:^|[^\r])\n/.test(e.insert))) return 'a bare LF in a CRLF file';
  if (eol === '\n' && edits.some((e) => e.insert.includes('\r'))) return 'a CR in an LF file';
  if (doc.text.startsWith(BOM) !== next.text.startsWith(BOM)) return 'the byte order mark changed';
  return undefined;
}

function newWarning(doc: WorkflowDocument, next: WorkflowDocument): string | undefined {
  const had = new Map<string, number>();
  for (const w of doc.warnings)
    had.set(`${w.code} ${w.message}`, (had.get(`${w.code} ${w.message}`) ?? 0) + 1);
  for (const w of next.warnings) {
    const key = `${w.code} ${w.message}`;
    const left = had.get(key) ?? 0;
    if (left === 0) return key;
    had.set(key, left - 1);
  }
  return undefined;
}

/**
 * Aliases after the edit: none dangles or names its own node that did not before, and, for an edit known only as
 * text, each names the same definition as before.
 */
function aliasProblem(doc: WorkflowDocument, next: WorkflowDocument, draft: Draft): string | undefined {
  if (next.anchors.dangling.length > doc.anchors.dangling.length) return 'an alias names no anchor';
  const recursive = (d: WorkflowDocument) => d.anchors.aliases.filter((a) => a.recursive).length;
  if (recursive(next) > recursive(doc)) return 'an alias is inside the node it names';
  if (!draft.expect && bindings(doc) !== bindings(next)) return 'an alias names another anchor';
  return undefined;
}

/** Each alias with the definition it names (the how-manyth of its name), and how many anchors there are. */
const bindings = (doc: WorkflowDocument): string =>
  [
    doc.anchors.anchors.length,
    ...doc.anchors.aliases.map(
      (a) => `${a.name}#${a.target ? doc.anchors.definitions(a.name).indexOf(a.target) : -1}`,
    ),
  ].join(' ');

function meaningProblem(doc: WorkflowDocument, next: WorkflowDocument, draft: Draft): string | undefined {
  if (!draft.expect) return undefined;
  const before = valueOf(doc);
  const after = valueOf(next);
  if (before === undefined || after === undefined) return 'an alias does not resolve';
  const want = draft.expect(unshared(before));
  const diff = difference(want, after, '');
  return diff === undefined ? undefined : `the value differs at ${diff || '/'}`;
}

/** U+FEFF, the byte order mark. */
const BOM = String.fromCharCode(0xfeff);

const valueOf = (doc: WorkflowDocument): unknown => toJson(doc.tree, doc.tree.doc?.contents ?? null);

/**
 * Where two plain-JSON values first differ, as a `/`-path; undefined when they are the same. Maps compare whatever
 * their key order (a new key goes where the file's order puts it), sequences in order.
 */
export function difference(a: unknown, b: unknown, at: string): string | undefined {
  if (Array.isArray(a) || Array.isArray(b)) return listDifference(a, b, at);
  if (isObject(a) && isObject(b)) return mapDifference(a, b, at);
  return Object.is(a, b) ? undefined : at;
}

function listDifference(a: unknown, b: unknown, at: string): string | undefined {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return at;
  for (const [i, x] of a.entries()) {
    const d = difference(x, b[i], `${at}/${i}`);
    if (d !== undefined) return d;
  }
  return undefined;
}

function mapDifference(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  at: string,
): string | undefined {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return `${at}/${key}`;
    const d = difference(a[key], b[key], `${at}/${key}`);
    if (d !== undefined) return d;
  }
  return undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function firstLine(doc: WorkflowDocument, edits: readonly TextEdit[]): number | undefined {
  return edits.length === 0 ? undefined : doc.tree.lines.lineAt(Math.min(...edits.map((e) => e.from))) + 1;
}

/**
 * A deep copy in which no two places share an object: yaml reads an alias of a collection as the anchored object
 * itself, and an edit of one use must not reach the others through it.
 */
function unshared(js: unknown): unknown {
  if (Array.isArray(js)) return js.map(unshared);
  if (typeof js !== 'object' || js === null) return js;
  return Object.fromEntries(Object.entries(js).map(([k, v]) => [k, unshared(v)]));
}
