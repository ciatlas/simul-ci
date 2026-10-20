import { Composer, isMap, Parser, type CST, type Document, type ParsedNode, type YAMLError } from 'yaml';
import { AnchorIndex } from './anchors';
import { applyEdits, type TextEdit } from './edits';
import { Lines } from './lines';
import {
  jobsOf,
  lineOf,
  nodeInfo,
  pathAt,
  spanOf,
  unitPathIn,
  yamlPathIn,
  type JobInfo,
  type NodeInfo,
} from './paths';
import * as refusals from './refusal';
import type { Refusal } from './refusal';
import { inferStyle, textStyle, type Style } from './style';
import { entriesOf, type Tree } from './tree';
import type { FileKind, Span, YamlPath } from './types';

export interface OpenOptions {
  path: string;
  kind: FileKind;
  /** Core's generated marker, from the Outline. */
  generated?: string;
  /** The author chose to edit this generated file this session. */
  unlocked?: boolean;
  /** Larger files are not parsed, and ops refuse them (`too-large`): 512 kB unless given. */
  maxBytes?: number;
}

/** A yaml error or warning, by offset. */
export interface YamlProblem {
  from: number;
  to: number;
  code: string;
  message: string;
}

export type Status = { editable: true } | { editable: false; refusal: Refusal };

/**
 * How core parses a workflow file (`parseDocument(text, { strict: false, prettyErrors: false })`, `@ciatlas/core`
 * parse.ts): the document's errors are core's, so a file this package calls invalid is one the hold calls broken.
 * yaml's default `strict: true` would refuse `k: "x"# c`, which GitHub and core accept.
 */
export const PARSE_OPTIONS = { strict: false } as const;

const MAX_BYTES = 512 * 1024;

/**
 * One version of a file's text and what a parse of it says: the YAML tree, its anchors, its style and whether ops may
 * edit it. The text is the state; this is an index over it, immutable, so `apply` returns a new one.
 */
export class WorkflowDocument {
  readonly path: string;
  readonly kind: FileKind;
  readonly text: string;
  readonly style: Style;
  /** yaml's errors as core sees them, a second document included (`MULTIPLE_DOCS`). */
  readonly errors: readonly YamlProblem[];
  readonly warnings: readonly YamlProblem[];
  readonly status: Status;
  /** The number of YAML documents in the text. */
  readonly documents: number;
  readonly anchors: AnchorIndex;
  /** The parse behind the reads. Internal to the package: its shape follows yaml's. */
  readonly tree: Tree;
  readonly #options: OpenOptions;
  #jobs: JobInfo[] | undefined;

  private constructor(text: string, options: OpenOptions, parsed: Parsed) {
    this.path = options.path;
    this.kind = options.kind;
    this.text = text;
    this.#options = options;
    this.tree = parsed.tree;
    this.errors = parsed.errors;
    this.warnings = parsed.warnings;
    this.documents = parsed.documents;
    this.anchors = new AnchorIndex(parsed.tree);
    this.style = parsed.tree.doc ? inferStyle(parsed.tree) : textStyle(text);
    this.status = statusOf(this, options, parsed);
  }

  /** Parses a text. Never throws: what is wrong with the text is in `errors` and `status`. */
  static open(text: string, options: OpenOptions): WorkflowDocument {
    const bytes = utf8Length(text, options.maxBytes ?? MAX_BYTES);
    if (bytes > (options.maxBytes ?? MAX_BYTES))
      return new WorkflowDocument(text, options, unparsed(text, bytes));
    try {
      return new WorkflowDocument(text, options, parse(text));
    } catch (error) {
      return new WorkflowDocument(text, options, failed(text, error));
    }
  }

  /** What is at a path, aliases read through; undefined when nothing is. */
  get(path: YamlPath): NodeInfo | undefined {
    return nodeInfo(this.tree, this.anchors, path);
  }

  /** The path of the innermost item at an offset: the pane's cursor. */
  pathAt(offset: number): YamlPath {
    return pathAt(this.tree, offset);
  }

  /** The lines the item at a path owns: its leading comments, its content, its deeper trailing comments. */
  spanOf(path: YamlPath): Span | undefined {
    return spanOf(this.tree, path);
  }

  lineOf(path: YamlPath): number | undefined {
    return lineOf(this.tree, path);
  }

  /** The offset of a 1-based line and column, as core's `Loc`. */
  offsetOf(line: number, column: number): number {
    return this.tree.lines.offsetOf(line, column);
  }

  jobs(): JobInfo[] {
    this.#jobs ??= jobsOf(this.tree, this.anchors);
    return this.#jobs;
  }

  /** The document of the text after the edits, parsed once. */
  apply(edits: readonly TextEdit[]): WorkflowDocument {
    return WorkflowDocument.open(applyEdits(this.text, edits).text, this.#options);
  }
}

/** The unit path of the job or step a path is in: `build`, `build.detect`, `build.#3`. */
export function unitPathAt(doc: WorkflowDocument, path: YamlPath): string | undefined {
  return unitPathIn(doc.jobs(), path);
}

/** The path in this file of the job or step a unit path names. */
export function yamlPathOf(doc: WorkflowDocument, unitPath: string): YamlPath | undefined {
  return yamlPathIn(doc.jobs(), unitPath);
}

interface Parsed {
  tree: Tree;
  errors: YamlProblem[];
  warnings: YamlProblem[];
  documents: number;
  /** Set when the text was not parsed for its size. */
  bytes?: number;
}

function parse(text: string): Parsed {
  const tokens = [...new Parser().parse(text)];
  const docs = [
    ...new Composer({ ...PARSE_OPTIONS, keepSourceTokens: true }).compose(tokens, true, text.length),
  ];
  const doc = docs[0] as Document.Parsed;
  const errors = doc.errors.map(problem);
  // As parseDocument, which core calls: a second document is an error at its start.
  if (docs[1])
    errors.push(
      problem({ pos: [docs[1].range[0], docs[1].range[1]], code: 'MULTIPLE_DOCS', message: MULTIPLE_DOCS }),
    );
  return {
    tree: { text, lines: new Lines(text), tokens, doc },
    errors,
    warnings: doc.warnings.map(problem),
    documents: docs.length,
  };
}

const MULTIPLE_DOCS = 'Source contains multiple documents; please use YAML.parseAllDocuments()';

function problem(error: Pick<YAMLError, 'pos' | 'code' | 'message'>): YamlProblem {
  return { from: error.pos[0], to: error.pos[1], code: error.code, message: error.message };
}

function unparsed(text: string, bytes: number): Parsed {
  return {
    tree: { text, lines: new Lines(text), tokens: [], doc: undefined },
    errors: [],
    warnings: [],
    documents: 1,
    bytes,
  };
}

function failed(text: string, error: unknown): Parsed {
  const message = error instanceof Error ? error.message : String(error);
  const parsed = unparsed(text, 0);
  delete parsed.bytes;
  parsed.errors.push({ from: 0, to: 0, code: 'UNREADABLE', message });
  return parsed;
}

function statusOf(doc: WorkflowDocument, options: OpenOptions, parsed: Parsed): Status {
  const refusal = lockOf(doc, options, parsed);
  return refusal ? { editable: false, refusal } : { editable: true };
}

function lockOf(doc: WorkflowDocument, options: OpenOptions, parsed: Parsed): Refusal | undefined {
  if (parsed.bytes !== undefined) return refusals.tooLarge(doc.path, parsed.bytes);
  if (options.generated !== undefined && !options.unlocked)
    return refusals.generated(doc.path, options.generated, markerLine(doc.tree, options.generated));
  const error = doc.errors.find((e) => e.code !== 'MULTIPLE_DOCS');
  if (error) return brokenYaml(doc, error);
  if (doc.documents > 1) {
    const second = doc.errors.find((e) => e.code === 'MULTIPLE_DOCS')!;
    return refusals.multiDocument(doc.path, doc.documents, doc.tree.lines.lineAt(second.from) + 1);
  }
  const directive = doc.tree.tokens.find((t): t is CST.Directive => t.type === 'directive');
  if (directive)
    return refusals.directive(doc.path, directive.source.trim(), doc.tree.lines.lineAt(directive.offset) + 1);
  return undefined;
}

function brokenYaml(doc: WorkflowDocument, error: YamlProblem): Refusal {
  const line = doc.tree.lines.lineAt(error.from) + 1;
  const duplicate = error.code === 'DUPLICATE_KEY' ? firstDuplicate(doc.tree) : undefined;
  if (duplicate) return refusals.duplicateKey(doc.path, duplicate.at, duplicate.key, duplicate.lines);
  return refusals.invalidYaml(doc.path, line, error.code, error.message.split('\n')[0]!);
}

/** The first map with two pairs of one key: its path, the key and both 1-based lines. */
function firstDuplicate(tree: Tree): { at: YamlPath; key: string; lines: [number, number] } | undefined {
  const search = (node: ParsedNode | null, at: YamlPath): ReturnType<typeof firstDuplicate> => {
    const entries = entriesOf(node);
    if (isMap(node)) {
      const seen = new Map<string, number>();
      for (const { segment, pair } of entries) {
        const line = tree.lines.lineAt(pair!.key.range[0]) + 1;
        const first = seen.get(String(segment));
        if (first !== undefined) return { at, key: String(segment), lines: [first, line] };
        seen.set(String(segment), line);
      }
    }
    for (const entry of entries) {
      const found = search(entry.node, [...at, entry.segment]);
      if (found) return found;
    }
    return undefined;
  };
  return search(tree.doc?.contents ?? null, []);
}

/** The 1-based line of the header comment that holds core's marker; undefined for a name-only marker. */
function markerLine(tree: Tree, marker: string): number | undefined {
  for (let line = 0; line < Math.min(tree.lines.count, 10); line++) {
    const text = tree.lines.textOf(line).trim();
    if (text.startsWith('#') && text.includes(marker)) return line + 1;
  }
  return undefined;
}

/** The UTF-8 length of a text, counted exactly only when it could be near `max` (it is at least the UTF-16 length). */
function utf8Length(text: string, max: number): number {
  if (text.length > max || text.length * 3 <= max) return text.length;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && isLow(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
