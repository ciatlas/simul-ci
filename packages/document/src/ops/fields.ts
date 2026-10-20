import { isScalar } from 'yaml';
import type { WorkflowDocument } from '../document';
import { removeDraft } from '../remove';
import { notFound, type Refusal } from '../refusal';
import { setDraft, type ScalarKind } from '../set';
import { locate, walkNodes } from '../tree';
import type { Json, Span, YamlPath } from '../types';
import type { Draft, Warning } from '../verify';
import { orderFor } from './order';

/** How a field's value is read (§ 2.7): `30` in a number field is a number, `true` in a boolean one a boolean. */
const KIND: Record<string, ScalarKind> = {
  'timeout-minutes': 'number',
  'continue-on-error': 'boolean',
  'max-parallel': 'number',
};

/**
 * An `if:` as the file writes them: one starting with `!` (a YAML tag otherwise) is wrapped in `${{ }}` when the
 * file wraps its conditions, and single-quoted by the scalar writer when it does not.
 */
export function ifValue(doc: WorkflowDocument, value: Json): Json {
  if (typeof value !== 'string' || !value.trimStart().startsWith('!') || doc.style.ifStyle !== 'wrapped')
    return value;
  return `\${{ ${value.trim()} }}`;
}

/** A field set, or removed when the value is null; keys go where the map's order puts them. */
export function fieldDraft(
  doc: WorkflowDocument,
  path: YamlPath,
  value: Json | null,
  shared?: 'all',
): Draft | Refusal {
  const field = String(path.at(-1));
  // Through an alias: a field that is not there is nothing to remove, the alias untouched.
  if (value === null)
    return doc.get(path) !== undefined
      ? removeDraft(doc, path, 'null', shared ? { shared } : {})
      : { edits: [], label: 'Nothing to remove' };
  const json = field === 'if' ? ifValue(doc, value) : value;
  const as = KIND[field];
  return setDraft(doc, path, json, { order: orderFor, ...(as ? { as } : {}), ...(shared ? { shared } : {}) });
}

/** A multi-line `run` ends with a line break, so that it is written `|` (§ 2.6). */
export const runValue = (run: string): string =>
  run.includes('\n') && !run.endsWith('\n') ? `${run}\n` : run;

/** The spans of the document's string scalars, outside `except`, that read `pattern`. */
export function reads(doc: WorkflowDocument, pattern: RegExp, except?: YamlPath): Span[] {
  const out: Span[] = [];
  const inside = (path: readonly (string | number)[]) =>
    except !== undefined && except.every((s, i) => path[i] === s);
  walkNodes(doc.tree.doc?.contents ?? null, (node, path) => {
    if (inside(path) || !isScalar(node) || typeof node.value !== 'string' || !pattern.test(node.value))
      return;
    out.push({ from: node.range[0], to: node.range[1] });
  });
  return out;
}

/** A warning listing where expressions still read something an op removed (or, with `tail`, moved). */
export function danglingReads(
  doc: WorkflowDocument,
  what: string,
  spans: readonly Span[],
  tail = '',
): Warning[] {
  if (spans.length === 0) return [];
  const lines = [...new Set(spans.map((s) => doc.tree.lines.lineAt(s.from) + 1))];
  return [
    {
      code: 'dangling-ref',
      message: `${spans.length} expression${spans.length === 1 ? '' : 's'} still read${spans.length === 1 ? 's' : ''} ${what}${tail} (line${lines.length === 1 ? '' : 's'} ${lines.join(', ')}).`,
      at: [...spans],
    },
  ];
}

/** `needs.<id>`, `needs['<id>']` (or `jobs`, `steps`) in an expression, whatever the id's case. */
export const readOf = (prefix: string, id: string): RegExp => {
  const name = id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(?<![\\w.-])${prefix}(?:\\.${name}(?![\\w-])|\\[\\s*(['"])${name}\\1\\s*\\])`, 'i');
};

export function jobMissing(doc: WorkflowDocument, job: string): Refusal | undefined {
  return locate(doc.tree, ['jobs', job]) ? undefined : notFound(doc.path, ['jobs', job]);
}
