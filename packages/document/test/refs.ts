import { isScalar, isSeq, type ParsedNode } from 'yaml';
import type { Reference, WorkflowDocument } from '@simulci/document';
import { locate, walkNodes } from '../src/tree';

/**
 * The references the engine's `referencesOf` (E2) gives for a job or a step, built here from the document's
 * structure, as the document zone may not import the engine: the job's key or the step's `id:` value, each `needs`
 * entry naming the job, and the reads in expressions (`needs.<id>`, `jobs.<id>` in a `workflow_call` output,
 * `steps.<id>` in the step's own job), each cut to the id. An expression is a `${{ }}` region, or a whole `if:`.
 */

const ID = '[A-Za-z_][\\w-]*';

export function jobReferences(doc: WorkflowDocument, job: string): Reference[] {
  const refs: Reference[] = [];
  const pair = locate(doc.tree, ['jobs', job])?.hops.at(-1)?.pair;
  if (!pair) return [];
  refs.push(at(doc, idStart(doc, pair.key), job, 'key'));
  for (const other of doc.jobs()) {
    const needs = locate(doc.tree, ['jobs', other.id, 'needs'])?.node ?? null;
    for (const entry of isSeq(needs) ? needs.items : [needs])
      if (isScalar(entry) && typeof entry.value === 'string' && same(entry.value, job))
        refs.push(at(doc, idStart(doc, entry), entry.value, 'needs'));
  }
  reads(
    doc,
    (path) => {
      const output = path[0] === 'on' && path[1] === 'workflow_call' && path[2] === 'outputs';
      return output ? ['needs', 'jobs'] : ['needs'];
    },
    job,
    refs,
  );
  return sorted(refs);
}

export function stepReferences(doc: WorkflowDocument, job: string, index: number): Reference[] {
  const node = locate(doc.tree, ['jobs', job, 'steps', index, 'id'])?.node;
  if (!isScalar(node) || typeof node.value !== 'string') return [];
  const id = node.value;
  const refs = [at(doc, idStart(doc, node), id, 'key')];
  reads(doc, (path) => (path[0] === 'jobs' && path[1] === job ? ['steps'] : []), id, refs);
  return sorted(refs);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Where a scalar's text starts, past its quote. */
const idStart = (doc: WorkflowDocument, node: ParsedNode): number =>
  /["']/.test(doc.text[node.range[0]]!) ? node.range[0] + 1 : node.range[0];

function at(doc: WorkflowDocument, from: number, text: string, role: Reference['role']): Reference {
  const start = doc.tree.lines.position(from);
  const end = doc.tree.lines.position(from + text.length);
  return {
    file: doc.path,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    text: doc.text.slice(from, from + text.length),
    role,
  };
}

/** The reads of an id in every string scalar's expressions, through the contexts each place reads it by. */
function reads(
  doc: WorkflowDocument,
  contexts: (path: readonly (string | number)[]) => string[],
  id: string,
  refs: Reference[],
): void {
  walkNodes(doc.tree.doc?.contents ?? null, (node, path, isKey) => {
    if (isKey || !isScalar(node) || typeof node.value !== 'string') return;
    const names = contexts(path);
    if (names.length === 0) return;
    const [start, end] = node.range;
    const source = doc.text.slice(start, end);
    const head = new RegExp(`(?<![\\w.-])(?:${names.join('|')})\\s*(?:\\.\\s*|\\[\\s*'{1,2})(${ID})`, 'gi');
    for (const [from, to] of regions(source, path.at(-1) === 'if'))
      for (const m of source.slice(from, to).matchAll(head)) {
        if (!same(m[1]!, id)) continue;
        const offset = start + from + m.index + m[0].length - m[1]!.length;
        refs.push(at(doc, offset, m[1]!, 'read'));
      }
  });
}

/** The expression regions of a scalar's source: its `${{ }}`s, or the whole of an `if:` that has none. */
function regions(source: string, condition: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (const m of source.matchAll(/\$\{\{[\s\S]*?\}\}/g)) out.push([m.index, m.index + m[0].length]);
  return out.length === 0 && condition ? [[0, source.length]] : out;
}

const sorted = (refs: Reference[]): Reference[] =>
  refs.toSorted((a, b) => a.line - b.line || a.column - b.column);
